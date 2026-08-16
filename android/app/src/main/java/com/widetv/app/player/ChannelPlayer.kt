package com.widetv.app.player

import android.content.Context
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.MediaSession
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import com.widetv.app.net.ApiClient
import com.widetv.app.net.ChannelSummary
import com.widetv.app.net.EpisodeRef
import com.widetv.app.net.NowPlaying
import com.widetv.app.net.StreamProbe
import com.widetv.app.net.TimedNow
import java.io.IOException
import kotlin.math.max

/**
 * Idioma preferido de audio e legenda, como tag de container ("por", "eng").
 *
 * Idioma, e nao indice de faixa: o indice muda a cada episodio, e a escolha
 * precisa valer para a maratona inteira. `subtitleLang == null` significa
 * legendas desligadas.
 */
data class TrackPrefs(
  val audioLang: String? = null,
  val subtitleLang: String? = null,
)

/**
 * Reproducao: o canal ao vivo e a maratona sob demanda.
 *
 * Ao vivo, o servidor manda no relogio e esta classe so persegue — a virada de
 * episodio nao precisa de dois elementos de video porque a playlist do ExoPlayer
 * ja pre-carrega e emenda o item seguinte sozinha. O que sobra e manter a
 * posicao colada na grade e a fila com o `next` que o servidor disser.
 *
 * Sob demanda e o mesmo player com a grade desligada: sem `now`, sem correcao de
 * relogio, e a fila inteira da serie enfileirada de uma vez.
 */
@OptIn(UnstableApi::class)
class ChannelPlayer(
  private val context: Context,
  private val api: ApiClient,
  private val scope: CoroutineScope,
  private val events: Events,
  initialPrefs: TrackPrefs = TrackPrefs(),
) {

  interface Events {
    fun onTuned(playing: NowPlaying)
    fun onEpisodeChange(playing: NowPlaying)
    /** O arquivo nao respondeu. Numa TV, tela preta muda parece app quebrado. */
    fun onStalled()
    /**
     * O stream respondeu 202: o servidor esta gerando o remux do episodio. O
     * player espera sozinho e segue quando pronto; este aviso existe so para a
     * tela nao ficar preta sem explicacao - igual ao web player.
     */
    fun onPreparing() {}
    fun onError(error: Throwable)
    /** Comecou um episodio sob demanda: o escolhido, ou o proximo da maratona. */
    fun onVodEpisode(channel: ChannelSummary, episode: EpisodeRef) {}
    /** A maratona chegou ao fim da fila. */
    fun onVodEnded() {}
  }

  /**
   * Ao vivo a posicao pertence a grade; sob demanda pertence a quem esta
   * assistindo. Sao os dois unicos jeitos de este player tocar alguma coisa.
   */
  enum class PlaybackMode { LIVE, ON_DEMAND }

  val exo: ExoPlayer = ExoPlayer.Builder(context)
    .setMediaSourceFactory(
      // Mesmo cliente da API: o request do video precisa levar o cookie de
      // sessao, senao o servidor devolve 401 no meio do episodio.
      DefaultMediaSourceFactory(OkHttpDataSource.Factory(api.http)),
    )
    .build()

  var mode: PlaybackMode = PlaybackMode.LIVE
    private set

  /**
   * Preferencia de trilha. Escrever aqui reaplica no player na hora — e a unica
   * porta: o resto do app nunca toca em `trackSelectionParameters`.
   */
  var prefs: TrackPrefs = initialPrefs
    set(value) {
      field = value
      applyPrefs()
    }

  private var sample: NowSample? = null
  private var playing: NowPlaying? = null
  private var channelNumber: Int? = null
  private var lastResyncMs = 0L
  private var loop: Job? = null
  private var vodChannel: ChannelSummary? = null
  private var vodQueue: List<EpisodeRef> = emptyList()

  /** Invalida a espera de "preparando" de um load antigo quando outro assume. */
  private var loadToken = 0

  /**
   * true depois que o item carregado pelo ultimo `load` chegou a READY. E o que
   * separa "o next pre-carregado falhou" de "o proprio episodio nao abriu".
   */
  private var currentItemStarted = false

  /** Ultimo `next` cuja entrada na fila foi PEDIDA; evita re-probar o mesmo arquivo. */
  private var nextRequestedId: String? = null
  private var nextJob: Job? = null

  /** Viva so enquanto algo toca; ver [ensureSession]. */
  private var session: MediaSession? = null

  init {
    applyPrefs()

    exo.addListener(object : Player.Listener {
      override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
        // Item novo, grupos de trilha novos: o override fixado no episodio
        // anterior aponta para grupos que nao existem mais. Reaplicar a
        // preferencia por IDIOMA e o que faz a escolha atravessar a maratona.
        applyPrefs()

        if (reason != Player.MEDIA_ITEM_TRANSITION_REASON_AUTO) return

        if (mode == PlaybackMode.ON_DEMAND) {
          // Emendou o proximo da maratona. Nao ha grade a conferir: a fila
          // inteira ja esta no player desde o comeco.
          val channel = vodChannel ?: return
          val id = mediaItem?.mediaId ?: return
          val episode = vodQueue.firstOrNull { it.id == id } ?: return
          events.onVodEpisode(channel, episode)
          return
        }

        val channel = channelNumber ?: return
        // A grade virou sozinha. Confirma com o servidor e reenfileira o proximo.
        scope.launch { resync(channel, episodeChanged = true) }
      }

      override fun onPlayerError(error: PlaybackException) {
        Log.w(TAG, "erro de reproducao", error)

        if (
          mode == PlaybackMode.LIVE &&
          decideLiveError(currentItemStarted, exo.currentMediaItemIndex, exo.mediaItemCount) ==
          LiveErrorAction.DROP_NEXT
        ) {
          // Quem falhou foi a preparacao antecipada do `next` (ex.: um 202
          // "preparando" que virou JSON no extractor); o episodio no ar nao tem
          // culpa. Tira o next da fila e retoma da posicao em que parou, em vez
          // de derrubar o canal - o resync readiciona o proximo quando o probe
          // disser que ele esta pronto.
          while (exo.mediaItemCount > exo.currentMediaItemIndex + 1) {
            exo.removeMediaItem(exo.mediaItemCount - 1)
          }
          nextRequestedId = null
          exo.prepare()
          return
        }

        events.onStalled()

        if (mode == PlaybackMode.ON_DEMAND) {
          // Sob demanda nao ha canal a resintonizar: o mesmo arquivo, na mesma
          // posicao, e o unico lugar para onde voltar.
          scope.launch {
            delay(RETRY_DELAY_MS)
            exo.prepare()
          }
          return
        }

        val channel = channelNumber ?: return
        scope.launch {
          delay(RETRY_DELAY_MS)
          runCatching { tune(channel) }.onFailure { events.onError(it) }
        }
      }

      override fun onPlaybackStateChanged(state: Int) {
        // O item do ultimo load abriu de verdade: um erro daqui em diante com
        // fila de dois itens e culpa do `next` pre-carregado, nao dele.
        if (state == Player.STATE_READY) currentItemStarted = true

        // A grade nunca termina; a maratona sim.
        if (state != Player.STATE_ENDED || mode != PlaybackMode.ON_DEMAND) return
        events.onVodEnded()
      }
    })
  }

  val currentChannel: Int? get() = channelNumber

  val nowPlaying: NowPlaying? get() = playing

  /** Trilhas do item que esta tocando. Vazio antes do primeiro `prepare`. */
  val tracks: Tracks get() = exo.currentTracks

  /**
   * Episodio no ar agora, ao vivo ou sob demanda.
   *
   * O overlay do player precisa dos dois modos escritos do mesmo jeito, e so
   * quem guarda a fila sabe traduzir o `mediaId` de volta em episodio.
   */
  val currentEpisode: EpisodeRef?
    get() = if (mode == PlaybackMode.LIVE) {
      playing?.episode
    } else {
      vodQueue.firstOrNull { it.id == exo.currentMediaItem?.mediaId }
    }

  /** O proximo. Ao vivo vem da grade; sob demanda, da fila — null no ultimo. */
  val nextEpisode: EpisodeRef?
    get() {
      if (mode == PlaybackMode.LIVE) return playing?.next
      val id = exo.currentMediaItem?.mediaId ?: return null
      val at = vodQueue.indexOfFirst { it.id == id }
      return if (at < 0) null else vodQueue.getOrNull(at + 1)
    }

  /** Nome da serie no ar, para o rotulo de cima do overlay. */
  val currentChannelName: String?
    get() = if (mode == PlaybackMode.LIVE) playing?.channel?.name else vodChannel?.name

  val isPlaying: Boolean get() = exo.playWhenReady

  /** 0..1. Mudo e volume zero, nao um estado separado. */
  var volume: Float
    get() = exo.volume
    set(value) {
      exo.volume = value.coerceIn(0f, 1f)
    }

  /** false quando o canal nao existe. */
  suspend fun tune(channelNumber: Int): Boolean {
    stopLoop()
    ensureSession()
    // Sintonizar e sempre sair do sob demanda: o canal ao vivo nao divide a
    // tela com maratona nenhuma.
    resetVod()
    this.channelNumber = channelNumber

    val timed = api.now(channelNumber) ?: return false

    // load pode esperar um episodio "preparando"; se outra sintonia (ou o
    // stop) assumiu nesse meio tempo, quem assumiu ja cuidou do OSD e do loop
    // — repetir aqui sobrescreveria o canal novo com o velho.
    if (!load(timed)) return true
    events.onTuned(timed.data)
    startLoop()
    return true
  }

  /**
   * Reproducao sob demanda: sem grade, sem sync. Toca do episodio escolhido e
   * emenda os seguintes da serie, como uma maratona.
   *
   * @param startPositionMs onde comecar dentro do episodio escolhido. E o que
   *   faz "Continuar S01E08" continuar de onde parou em vez de recomecar; zero
   *   para "Do inicio".
   */
  fun playOnDemand(
    channel: ChannelSummary,
    episodes: List<EpisodeRef>,
    startIndex: Int,
    startPositionMs: Long = 0L,
  ) {
    stopLoop()
    ensureSession()
    mode = PlaybackMode.ON_DEMAND
    vodChannel = channel
    vodQueue = episodes
    // Nao ha canal ao vivo por baixo: quem ficasse aqui faria o loop de sync
    // perseguir a grade de um canal que ninguem esta assistindo.
    channelNumber = null
    sample = null
    playing = null
    // A espera de "preparando" e o probe do next eram do ao vivo; a maratona
    // que comeca agora nao pode ser atropelada por eles.
    loadToken++
    nextJob?.cancel()
    nextRequestedId = null

    exo.setMediaItems(episodes.map(::mediaItem), startIndex, startPositionMs.coerceAtLeast(0L))
    exo.playWhenReady = true
    exo.prepare()
    events.onVodEpisode(channel, episodes[startIndex])
  }

  /** So faz sentido no sob demanda; a grade nao tem pausa. */
  fun togglePause() {
    exo.playWhenReady = !exo.playWhenReady
  }

  /**
   * Salto relativo. Ao vivo nao ha o que saltar: a posicao pertence a grade, e
   * qualquer seek seria desfeito pelo proximo ciclo de sincronia.
   */
  fun seekBy(deltaMs: Long) {
    if (mode != PlaybackMode.ON_DEMAND) return
    val duration = exo.duration
    val target = max(0L, exo.currentPosition + deltaMs)
    exo.seekTo(if (duration > 0) minOf(target, duration) else target)
  }

  /**
   * Salto absoluto: e o commit do scrub, que ja escolheu o alvo em cima da
   * posicao projetada. Mesma regra do [seekBy] — ao vivo a posicao e da grade.
   */
  fun seekTo(positionMs: Long) {
    if (mode != PlaybackMode.ON_DEMAND) return
    val duration = exo.duration
    val target = max(0L, positionMs)
    exo.seekTo(if (duration > 0) minOf(target, duration) else target)
  }

  /**
   * Fixa o grupo de audio escolhido no painel — imediato e exato, para o caso de
   * dois grupos dividirem o mesmo idioma. A permanencia entre episodios vem de
   * `prefs`, que quem chama atualiza junto.
   */
  fun overrideAudio(group: Tracks.Group) {
    exo.trackSelectionParameters = exo.trackSelectionParameters.buildUpon()
      .setOverrideForType(TrackSelectionOverride(group.mediaTrackGroup, 0))
      .build()
  }

  /** Mesmo papel do `overrideAudio`, para legenda. Desligar e assunto de `prefs`. */
  fun overrideText(group: Tracks.Group) {
    exo.trackSelectionParameters = exo.trackSelectionParameters.buildUpon()
      .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
      .setOverrideForType(TrackSelectionOverride(group.mediaTrackGroup, 0))
      .build()
  }

  /**
   * MediaSession por cima do exo, criada quando a reproducao comeca e desfeita
   * no [stop]: e ela que recebe as teclas de midia que NAO passam pela
   * Activity — assistente, fone bluetooth, controle com o app fora de foco.
   * Com a Activity em foco quem age e o `onKeyDown`, que consome as MEDIA_*
   * antes de o sistema encaminha-las para ca: a sessao e a dona do caminho
   * remoto, o `onKeyDown` do local, e nenhuma tecla age duas vezes.
   */
  private fun ensureSession() {
    if (session != null) return
    session = MediaSession.Builder(context, exo).build()
  }

  private fun releaseSession() {
    session?.release()
    session = null
  }

  /** Solta o decoder quando a TV dorme. A grade nao precisa de ninguem olhando. */
  fun stop() {
    stopLoop()
    releaseSession()
    resetVod()
    // Mata a espera de "preparando" e o probe do next: sem isso um load antigo
    // acordaria depois do stop e ressuscitaria a reproducao sozinho.
    loadToken++
    nextJob?.cancel()
    nextRequestedId = null
    exo.stop()
    exo.clearMediaItems()
    sample = null
    playing = null
  }

  private fun resetVod() {
    mode = PlaybackMode.LIVE
    vodChannel = null
    vodQueue = emptyList()
  }

  fun release() {
    stopLoop()
    releaseSession()
    exo.release()
  }

  /**
   * Traduz a preferencia em parametros do seletor.
   *
   * Limpa os overrides antes: eles sao presos a um `TrackGroup` concreto, e um
   * grupo do episodio anterior sobrevivendo aqui daria uma selecao fantasma que
   * nunca casa.
   */
  private fun applyPrefs() {
    exo.trackSelectionParameters = exo.trackSelectionParameters.buildUpon()
      .clearOverridesOfType(C.TRACK_TYPE_AUDIO)
      .clearOverridesOfType(C.TRACK_TYPE_TEXT)
      .setPreferredAudioLanguage(prefs.audioLang)
      .setPreferredTextLanguage(prefs.subtitleLang)
      .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, prefs.subtitleLang == null)
      .build()
  }

  /** @return false quando outro load, stop() ou playOnDemand() assumiu no meio da espera. */
  private suspend fun load(timed: TimedNow): Boolean {
    val next = toSample(timed)
    sample = next
    playing = timed.data
    lastResyncMs = System.currentTimeMillis()

    // Episodio respondendo 202 (remux com prioridade em andamento): espera
    // antes de entregar a URL ao ExoPlayer, senao o corpo JSON morre no
    // extractor como erro fatal e o canal entra em loop de retune. O offset
    // nao se perde: `expectedOffsetMs` projeta a grade pelo relogio, entao ao
    // ficar pronto o video entra na posicao em que a grade ja esta.
    val token = ++loadToken
    var probe = api.probeStream(timed.data.episode.id)
    if (probe == StreamProbe.PREPARING) events.onPreparing()
    while (probe == StreamProbe.PREPARING) {
      delay(STREAM_POLL_MS)
      if (token != loadToken || channelNumber == null) return false
      probe = api.probeStream(timed.data.episode.id)
    }
    // ERROR segue em frente: um HEAD falhado nao prova nada, e o fluxo normal
    // ja sabe avisar quando o arquivo realmente nao vem.

    // Projeta o offset ate o instante do seek: o request custa centenas de ms,
    // e sem isso o canal ja nasce atrasado.
    val start = max(0L, expectedOffsetMs(next, System.currentTimeMillis()))

    currentItemStarted = false
    // Fila nova: o pedido de `next` de antes morreu junto com ela.
    nextJob?.cancel()
    nextRequestedId = null
    // So o episodio atual entra ja: o `next` e adicionado depois que o probe
    // dele confirmar que nao esta "preparando" - um 202 pre-carregado na fila
    // derrubaria tambem o episodio no ar.
    exo.setMediaItems(listOf(mediaItem(timed.data.episode)), 0, start)
    exo.playWhenReady = true
    exo.prepare()
    enqueueNextWhenReady(timed.data.next)
    return true
  }

  private fun startLoop() {
    loop = scope.launch {
      while (isActive) {
        delay(SYNC_INTERVAL_MS)
        try {
          step()
        } catch (error: IOException) {
          events.onError(error)
        }
      }
    }
  }

  private fun stopLoop() {
    loop?.cancel()
    loop = null
  }

  private suspend fun step() {
    val current = sample ?: return
    val channel = channelNumber ?: return

    val now = System.currentTimeMillis()
    val expected = expectedOffsetMs(current, now)

    // A virada normal e do ExoPlayer, que emenda o proximo item da fila. Este
    // ramo so pega o caso em que ele NAO virou: duracao medida maior que o
    // arquivo, ou item que nao entrou. Sem ele o canal ficaria preso no fim.
    if (expected >= current.durationMs + END_GRACE_MS) {
      resync(channel, episodeChanged = true)
      return
    }

    if (exo.playbackState != Player.STATE_READY || !exo.isPlaying) return

    val correction = decideCorrection(exo.currentPosition - expected, exo.playbackParameters.speed)
    when (correction.action) {
      CorrectionAction.SEEK -> {
        exo.setPlaybackSpeed(1f)
        exo.seekTo(max(0L, expected))
      }
      CorrectionAction.RATE, CorrectionAction.NONE -> exo.setPlaybackSpeed(correction.playbackRate)
    }

    if (now - lastResyncMs >= RESYNC_INTERVAL_MS) resync(channel)
  }

  private suspend fun resync(channel: Int, episodeChanged: Boolean = false) {
    val timed = try {
      api.now(channel) ?: return
    } catch (error: IOException) {
      events.onError(error)
      return
    }

    sample = toSample(timed)
    playing = timed.data
    lastResyncMs = System.currentTimeMillis()

    // Compara pelo id do episodio, nao pela URL: o `mediaId` e nosso e nao passa
    // por normalizacao nenhuma.
    val mismatch = exo.currentMediaItem?.mediaId != timed.data.episode.id
    if (mismatch) {
      // load abortado = outra sintonia assumiu; o OSD dela nao pode ser
      // atropelado por um onEpisodeChange deste canal.
      if (!load(timed)) return
    } else {
      alignQueue(timed)
    }

    if (episodeChanged || mismatch) events.onEpisodeChange(timed.data)
  }

  /**
   * Deixa a fila com no maximo dois itens: o que toca agora e o `next` que o
   * servidor acabou de dizer. Nao mexe no item seguinte quando ele ja e o certo
   * — remover e readicionar jogaria fora o buffer que o ExoPlayer ja carregou.
   */
  private fun alignQueue(timed: TimedNow) {
    while (exo.currentMediaItemIndex > 0) exo.removeMediaItem(0)

    val wanted = timed.data.next.id
    if (exo.mediaItemCount > 1) {
      if (exo.getMediaItemAt(1).mediaId == wanted) return
      while (exo.mediaItemCount > 1) exo.removeMediaItem(exo.mediaItemCount - 1)
      nextRequestedId = null
    }
    enqueueNextWhenReady(timed.data.next)
  }

  /**
   * Poe o `next` na fila SO depois de um probe confirmar que o stream dele
   * existe. Um item "preparando" (202) na playlist nao e inofensivo: o
   * ExoPlayer prepara o proximo item antecipadamente e a falha dele e fatal
   * para o episodio que esta tocando (veja `decideLiveError`). Enquanto o
   * servidor gera o remux, o probe insiste — e, se o next nunca entrar, a
   * virada cai no resync do `step()`, que sabe carregar do zero.
   */
  private fun enqueueNextWhenReady(episode: EpisodeRef) {
    if (nextRequestedId == episode.id) return
    nextRequestedId = episode.id
    nextJob?.cancel()
    nextJob = scope.launch {
      var probe = api.probeStream(episode.id)
      while (probe == StreamProbe.PREPARING) {
        delay(STREAM_POLL_MS)
        if (nextRequestedId != episode.id || mode != PlaybackMode.LIVE) return@launch
        probe = api.probeStream(episode.id)
      }
      // ERROR entra mesmo assim: mesmo criterio do load — um HEAD falhado nao
      // prova nada, e o tratamento de erro sabe tirar um next defeituoso.
      if (nextRequestedId != episode.id || mode != PlaybackMode.LIVE) return@launch
      if (playing?.next?.id != episode.id) return@launch
      // Ja tem um item depois do atual: outro caminho chegou primeiro.
      if (exo.mediaItemCount > exo.currentMediaItemIndex + 1) return@launch
      exo.addMediaItem(mediaItem(episode))
    }
  }

  private fun mediaItem(episode: EpisodeRef): MediaItem =
    MediaItem.Builder()
      .setMediaId(episode.id)
      .setUri(api.streamUrl(episode.id))
      .build()

  private fun toSample(timed: TimedNow) = NowSample(
    serverTimeMs = timed.data.serverTimeMs,
    offsetMs = timed.data.offsetMs,
    durationMs = timed.data.episode.durationMs,
    sentAtMs = timed.sentAtMs,
    receivedAtMs = timed.receivedAtMs,
  )

  private companion object {
    const val TAG = "WideTv"

    /** De quanto em quanto tempo conferir o desvio. */
    const val SYNC_INTERVAL_MS = 1_000L

    /** Reconsulta o servidor de tempos em tempos para nao acumular erro de relogio. */
    const val RESYNC_INTERVAL_MS = 60_000L

    /** Folga antes de considerar que a virada travou. */
    const val END_GRACE_MS = 2_000L

    const val RETRY_DELAY_MS = 2_000L

    /** De quanto em quanto tempo perguntar se o episodio "preparando" ficou pronto. */
    const val STREAM_POLL_MS = 3_000L
  }
}
