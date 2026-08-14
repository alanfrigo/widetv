package com.retrotv.app.player

import android.content.Context
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import com.retrotv.app.net.ApiClient
import com.retrotv.app.net.ChannelSummary
import com.retrotv.app.net.EpisodeRef
import com.retrotv.app.net.NowPlaying
import com.retrotv.app.net.TimedNow
import java.io.IOException
import kotlin.math.max

/**
 * Reproducao do canal ao vivo. Porte de `src/web/player.ts`.
 *
 * O servidor manda no relogio; esta classe so persegue. A diferenca para o web e
 * que a virada de episodio nao precisa de dois elementos de video: a playlist do
 * ExoPlayer ja pre-carrega e emenda o item seguinte sozinha. O que sobra aqui e
 * manter a posicao colada na grade e manter a fila com o `next` que o servidor
 * disser.
 *
 * O modo panoramico acrescenta um segundo jeito de tocar: a maratona sob
 * demanda. E o mesmo player, com a grade desligada — sem `now`, sem correcao de
 * relogio, e a fila inteira da serie enfileirada de uma vez.
 */
@OptIn(UnstableApi::class)
class ChannelPlayer(
  context: Context,
  private val api: ApiClient,
  private val scope: CoroutineScope,
  private val events: Events,
) {

  interface Events {
    fun onTuned(playing: NowPlaying)
    fun onEpisodeChange(playing: NowPlaying)
    /** O arquivo nao respondeu. Numa TV, tela preta muda parece app quebrado. */
    fun onStalled()
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

  private var sample: NowSample? = null
  private var playing: NowPlaying? = null
  private var channelNumber: Int? = null
  private var lastResyncMs = 0L
  private var loop: Job? = null
  private var vodChannel: ChannelSummary? = null
  private var vodQueue: List<EpisodeRef> = emptyList()

  init {
    exo.addListener(object : Player.Listener {
      override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
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
        // A grade nunca termina; a maratona sim.
        if (state != Player.STATE_ENDED || mode != PlaybackMode.ON_DEMAND) return
        events.onVodEnded()
      }
    })
  }

  val currentChannel: Int? get() = channelNumber

  val nowPlaying: NowPlaying? get() = playing

  /** false quando o canal nao existe. */
  suspend fun tune(channelNumber: Int): Boolean {
    stopLoop()
    // Sintonizar e sempre sair do sob demanda: o canal ao vivo nao divide a
    // tela com maratona nenhuma.
    resetVod()
    this.channelNumber = channelNumber

    val timed = api.now(channelNumber) ?: return false

    load(timed)
    events.onTuned(timed.data)
    startLoop()
    return true
  }

  /**
   * Reproducao sob demanda: sem grade, sem sync. Toca do inicio do episodio
   * escolhido e emenda os seguintes da serie, como uma maratona.
   */
  fun playOnDemand(channel: ChannelSummary, episodes: List<EpisodeRef>, startIndex: Int) {
    stopLoop()
    mode = PlaybackMode.ON_DEMAND
    vodChannel = channel
    vodQueue = episodes
    // Nao ha canal ao vivo por baixo: quem ficasse aqui faria o loop de sync
    // perseguir a grade de um canal que ninguem esta assistindo.
    channelNumber = null
    sample = null
    playing = null

    exo.setMediaItems(episodes.map(::mediaItem), startIndex, 0L)
    exo.playWhenReady = true
    exo.prepare()
    events.onVodEpisode(channel, episodes[startIndex])
  }

  /** So faz sentido no sob demanda; a grade nao tem pausa. */
  fun togglePause() {
    exo.playWhenReady = !exo.playWhenReady
  }

  /** Solta o decoder quando a TV dorme. A grade nao precisa de ninguem olhando. */
  fun stop() {
    stopLoop()
    resetVod()
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
    exo.release()
  }

  private fun load(timed: TimedNow) {
    val next = toSample(timed)
    sample = next
    playing = timed.data
    lastResyncMs = System.currentTimeMillis()

    // Projeta o offset ate o instante do seek: o request custa centenas de ms,
    // e sem isso o canal ja nasce atrasado.
    val start = max(0L, expectedOffsetMs(next, System.currentTimeMillis()))

    exo.setMediaItems(
      listOf(mediaItem(timed.data.episode), mediaItem(timed.data.next)),
      0,
      start,
    )
    exo.playWhenReady = true
    exo.prepare()
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
    if (mismatch) load(timed) else alignQueue(timed)

    if (episodeChanged || mismatch) events.onEpisodeChange(timed.data)
  }

  /**
   * Deixa a fila com exatamente dois itens: o que toca agora e o `next` que o
   * servidor acabou de dizer. Nao mexe no item seguinte quando ele ja e o certo
   * — remover e readicionar jogaria fora o buffer que o ExoPlayer ja carregou.
   */
  private fun alignQueue(timed: TimedNow) {
    while (exo.currentMediaItemIndex > 0) exo.removeMediaItem(0)

    val wanted = timed.data.next.id
    if (exo.mediaItemCount > 1) {
      if (exo.getMediaItemAt(1).mediaId == wanted) return
      while (exo.mediaItemCount > 1) exo.removeMediaItem(exo.mediaItemCount - 1)
    }
    exo.addMediaItem(mediaItem(timed.data.next))
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
    const val TAG = "RetroTv"

    /** De quanto em quanto tempo conferir o desvio. */
    const val SYNC_INTERVAL_MS = 1_000L

    /** Reconsulta o servidor de tempos em tempos para nao acumular erro de relogio. */
    const val RESYNC_INTERVAL_MS = 60_000L

    /** Folga antes de considerar que a virada travou. */
    const val END_GRACE_MS = 2_000L

    const val RETRY_DELAY_MS = 2_000L
  }
}
