package com.widetv.app

import android.graphics.Bitmap
import android.os.Bundle
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import androidx.activity.addCallback
import androidx.annotation.OptIn
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.core.view.doOnPreDraw
import androidx.lifecycle.lifecycleScope
import androidx.media3.common.C
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.LinearLayoutManager
import com.widetv.app.databinding.ActivityMainBinding
import com.widetv.app.net.ApiClient
import com.widetv.app.net.AppSettings
import com.widetv.app.net.BadServerUrlException
import com.widetv.app.net.ChannelSummary
import com.widetv.app.net.EpisodeRef
import com.widetv.app.net.LibraryStatus
import com.widetv.app.net.NowPlaying
import com.widetv.app.net.SettingsPatch
import com.widetv.app.net.Store
import com.widetv.app.net.TaskAccepted
import com.widetv.app.net.UnauthorizedException
import com.widetv.app.player.ChannelPlayer
import com.widetv.app.player.TrackPrefs
import com.widetv.app.tuner.TunerEvent
import com.widetv.app.tuner.TunerResult
import com.widetv.app.tuner.TunerState
import com.widetv.app.tuner.initialTuner
import com.widetv.app.tuner.reduceTuner
import com.widetv.app.ui.EpisodeAdapter
import com.widetv.app.ui.NavEvent
import com.widetv.app.ui.NavResult
import com.widetv.app.ui.NavState
import com.widetv.app.ui.PosterAdapter
import com.widetv.app.ui.PosterLoader
import com.widetv.app.ui.ScreenId
import com.widetv.app.ui.SettingsAdapter
import com.widetv.app.ui.SettingsCommand
import com.widetv.app.ui.SettingsEvent
import com.widetv.app.ui.SettingsField
import com.widetv.app.ui.SettingsResult
import com.widetv.app.ui.SettingsUiState
import com.widetv.app.ui.SettingsValue
import com.widetv.app.ui.TRACK_OFF
import com.widetv.app.ui.TrackAdapter
import com.widetv.app.ui.TrackKind
import com.widetv.app.ui.TrackOption
import com.widetv.app.ui.TrackPanelEvent
import com.widetv.app.ui.TrackPanelResult
import com.widetv.app.ui.TrackPanelState
import com.widetv.app.ui.applySettingsValue
import com.widetv.app.ui.canonicalLang
import com.widetv.app.ui.formatChannelNumber
import com.widetv.app.ui.formatNowLine
import com.widetv.app.ui.formatSeriesMeta
import com.widetv.app.ui.initialsOf
import com.widetv.app.ui.languageLabel
import com.widetv.app.ui.libraryBusy
import com.widetv.app.ui.metadataText
import com.widetv.app.ui.reduceNav
import com.widetv.app.ui.reduceSettings
import com.widetv.app.ui.reduceTrackPanel
import com.widetv.app.ui.rows
import com.widetv.app.ui.scanProgressPercent
import com.widetv.app.ui.scanProgressText
import com.widetv.app.ui.scanSummaryText
import com.widetv.app.ui.settingsRows
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import java.io.IOException

/**
 * Unica tela do app: acesso, acervo, serie, player e configuracoes empilhados
 * por visibilidade.
 *
 * Aqui so ha cola. Toda decisao esta em reducers puros e testados —
 * `ui/Nav.kt` (para onde cada tecla leva), `ui/TrackPanel.kt` (o painel de
 * audio e legenda), `ui/Settings.kt` (a tela de configuracoes),
 * `tuner/Tuner.kt` (zap ao vivo) e `player/Sync.kt` (deriva da grade). Este
 * arquivo mexe em View, ExoPlayer e rede, e mais nada.
 */
@OptIn(UnstableApi::class)
class MainActivity : AppCompatActivity() {

  private lateinit var views: ActivityMainBinding
  private lateinit var store: Store
  private lateinit var api: ApiClient
  private lateinit var player: ChannelPlayer

  private lateinit var posters: PosterAdapter
  private lateinit var episodeRows: EpisodeAdapter
  private lateinit var trackRows: TrackAdapter
  private lateinit var settingRows: SettingsAdapter

  private var channels: List<ChannelSummary> = emptyList()
  private var nav = NavState()
  private var tuner: TunerState = initialTuner(0)
  private var panel = TrackPanelState()

  /** Preferencias do servidor. null enquanto `GET /api/settings` nao respondeu. */
  private var settings: AppSettings? = null
  private var settingsUi = SettingsUiState()
  private var libraryStatus: LibraryStatus? = null

  /** true quando a mensagem da tela e recusa ou falha, e nao confirmacao. */
  private var settingsAlert = false

  /** Episodios da serie aberta. Vazio enquanto o catalogo nao chegou. */
  private var episodes: List<EpisodeRef> = emptyList()

  /**
   * Grupos de trilha do item que esta tocando, na mesma ordem das opcoes do
   * painel: o `id` da opcao e o indice aqui. E o que traduz a escolha do reducer
   * de volta em algo que o ExoPlayer entende.
   */
  private var audioGroups: List<Tracks.Group> = emptyList()
  private var textGroups: List<Tracks.Group> = emptyList()

  private var ticker: Job? = null
  private var osdHide: Job? = null
  private var episodesJob: Job? = null
  private var posterJob: Job? = null
  private var settingsJob: Job? = null
  private var statusPoll: Job? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    views = ActivityMainBinding.inflate(layoutInflater)
    setContentView(views.root)

    // Um canal ao vivo nao tem pausa: deixar a TV apagar no meio seria perder a
    // grade sem que ninguem tenha pedido.
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    goFullscreen()

    store = Store(this)
    api = ApiClient(store)
    player = ChannelPlayer(
      context = this,
      api = api,
      scope = lifecycleScope,
      events = playerEvents,
      initialPrefs = TrackPrefs(store.audioLang, store.subtitleLang),
    )
    views.stage.player = player.exo

    posters = PosterAdapter(lifecycleScope, api, ::openSeries)
    views.homeGrid.layoutManager = GridLayoutManager(this, GRID_COLUMNS)
    views.homeGrid.adapter = posters

    episodeRows = EpisodeAdapter(::playFrom)
    views.seriesEpisodes.layoutManager = LinearLayoutManager(this)
    views.seriesEpisodes.adapter = episodeRows

    trackRows = TrackAdapter()
    views.trackList.layoutManager = LinearLayoutManager(this)
    views.trackList.adapter = trackRows

    settingRows = SettingsAdapter()
    views.settingsList.layoutManager = LinearLayoutManager(this)
    views.settingsList.adapter = settingRows

    // VOLTAR e uma so tecla com dois donos: fecha o painel de trilhas quando ele
    // esta aberto e, fora disso, desce um degrau da navegacao.
    onBackPressedDispatcher.addCallback(this) {
      if (panel.open) {
        applyPanel(reduceTrackPanel(panel, TrackPanelEvent.Close))
        return@addCallback
      }
      val result = reduceNav(nav, NavEvent.Back)
      if (!result.exit) {
        applyNav(result)
        return@addCallback
      }
      isEnabled = false
      onBackPressedDispatcher.onBackPressed()
    }

    views.gateSubmit.setOnClickListener { submitGate() }
    views.seriesLive.setOnClickListener { watchLive() }
    views.seriesStart.setOnClickListener { playFrom(0) }
    views.homeSettings.setOnClickListener { applyNav(reduceNav(nav, NavEvent.OpenSettings)) }

    lifecycleScope.launch {
      val event = if (hasAccess()) NavEvent.Authenticated else NavEvent.SessionLost
      applyNav(reduceNav(nav, event))
      if (event == NavEvent.Authenticated) seedSettings()
    }
  }

  /**
   * Semeia a preferencia de trilha com a do servidor, uma vez por abertura.
   *
   * Falhar aqui nao pode segurar a entrada no acervo, e por isso o resultado e
   * ignorado em silencio: o `Store` guarda a ultima preferencia conhecida
   * justamente para o app abrir certo com a rota fora do ar.
   */
  private suspend fun seedSettings() {
    val loaded = runCatching { api.settings() }.getOrNull() ?: return
    adoptSettings(loaded)
  }

  /**
   * Sessao viva, ou refeita em silencio com a senha guardada.
   *
   * O cookie vence sozinho de tempos em tempos. Mandar alguem digitar a senha
   * num controle remoto por causa disso seria cobrar o preco de um detalhe de
   * implementacao — e o app ja tem a credencial na mao.
   */
  private suspend fun hasAccess(): Boolean {
    if (runCatching { api.hasSession() }.getOrDefault(false)) return true
    val password = store.password ?: return false
    return runCatching { api.login(password) }.getOrDefault(false)
  }

  override fun onStop() {
    super.onStop()
    stopTicker()
    stopStatusPoll()
    player.stop()
    // A TV acorda limpa. Retomar depois do standby nao e possivel de todo jeito:
    // a grade andou sozinha, e um episodio sob demanda pausado no escuro por
    // horas nao e um lugar de onde continuar.
    if (nav.screen == ScreenId.PLAYER) applyNav(reduceNav(nav, NavEvent.Back))
  }

  override fun onDestroy() {
    super.onDestroy()
    player.release()
  }

  /** A TV nao tem barra de navegacao para ganhar: a imagem ocupa tudo. */
  private fun goFullscreen() {
    WindowCompat.setDecorFitsSystemWindows(window, false)
    WindowInsetsControllerCompat(window, views.root).apply {
      hide(WindowInsetsCompat.Type.systemBars())
      systemBarsBehavior =
        WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    }
  }

  // ---------------------------------------------------------------- navegacao

  private fun applyNav(result: NavResult) {
    val previous = nav
    nav = result.state

    // Sair do player e sempre parar de tocar: som de episodio por baixo do
    // catalogo seria um aparelho que nao obedece ao VOLTAR.
    if (previous.screen == ScreenId.PLAYER && nav.screen != ScreenId.PLAYER) {
      stopTicker()
      player.stop()
      closePanel()
    }

    // Sair das configuracoes para a pergunta de status de fundo: o scan continua
    // no servidor, mas ninguem esta olhando o progresso.
    if (previous.screen == ScreenId.SETTINGS && nav.screen != ScreenId.SETTINGS) stopStatusPoll()

    views.gate.visibility = show(nav.screen == ScreenId.GATE)
    views.home.visibility = show(nav.screen == ScreenId.HOME)
    views.series.visibility = show(nav.screen == ScreenId.SERIES)
    views.playerScreen.visibility = show(nav.screen == ScreenId.PLAYER)
    views.settings.visibility = show(nav.screen == ScreenId.SETTINGS)

    when (nav.screen) {
      ScreenId.GATE -> openGate()
      ScreenId.HOME -> openHome(focusOn = previous.channelNumber)
      ScreenId.SERIES -> nav.channelNumber?.let { showSeries(it) }
      ScreenId.PLAYER -> views.root.requestFocus()
      ScreenId.SETTINGS -> openSettings()
    }
  }

  private fun show(visible: Boolean) = if (visible) View.VISIBLE else View.GONE

  // ------------------------------------------------------------------ acesso

  private fun openGate() {
    views.gateServer.setText(store.serverUrl)
    views.gatePassword.requestFocus()
  }

  private fun submitGate() {
    val password = views.gatePassword.text.toString()
    if (password.isEmpty()) return

    val server = Store.normalizeUrl(views.gateServer.text.toString())
    if (server.isEmpty()) {
      views.gateError.setText(R.string.gate_no_server)
      return
    }
    store.serverUrl = server
    views.gateError.text = ""

    lifecycleScope.launch {
      val ok = try {
        api.login(password)
      } catch (error: BadServerUrlException) {
        views.gateError.setText(R.string.gate_no_server)
        return@launch
      } catch (error: IOException) {
        views.gateError.setText(R.string.gate_offline)
        return@launch
      }

      if (!ok) {
        views.gateError.setText(R.string.gate_error)
        return@launch
      }

      // So guarda a senha depois que o servidor a aceitou: guardar uma senha
      // errada faria o relogin automatico bater na porta para sempre.
      store.password = password
      views.gatePassword.setText("")
      applyNav(reduceNav(nav, NavEvent.Authenticated))
    }
  }

  // ------------------------------------------------------------------ acervo

  /** @param focusOn serie de onde o VOLTAR veio, para o foco cair nela. */
  private fun openHome(focusOn: Int?) {
    if (channels.isNotEmpty()) {
      views.homeStatus.visibility = View.GONE
      focusCard(cardIndexOf(focusOn))
      return
    }

    views.homeStatus.setText(R.string.home_loading)
    views.homeStatus.visibility = View.VISIBLE

    lifecycleScope.launch {
      val loaded = try {
        api.channels()
      } catch (error: UnauthorizedException) {
        applyNav(reduceNav(nav, NavEvent.SessionLost))
        return@launch
      } catch (error: IOException) {
        views.homeStatus.setText(R.string.gate_offline)
        return@launch
      }

      channels = loaded
      posters.items = loaded
      views.homeStatus.visibility = if (loaded.isEmpty()) View.VISIBLE else View.GONE
      if (loaded.isEmpty()) {
        views.homeStatus.setText(R.string.home_empty)
        return@launch
      }
      focusCard(cardIndexOf(focusOn))
    }
  }

  /**
   * Onde o foco pousa ao abrir o acervo: a serie de onde o VOLTAR veio ou, na
   * primeira vez, a ultima que foi assistida ao vivo. Abrir sempre no primeiro
   * card faria quem tem 400 series recomecar a busca a cada volta.
   */
  private fun cardIndexOf(channelNumber: Int?): Int {
    val wanted = channelNumber ?: store.readLastChannel(channelNumbers()) ?: return 0
    return channels.indexOfFirst { it.number == wanted }
  }

  /**
   * O foco so pode pousar depois que o RecyclerView criou o card. Espera o
   * desenho, e nao um `post`: a fila de mensagens nao garante que o layout ja
   * aconteceu, e a linha ainda nao existiria para receber o foco.
   */
  private fun focusCard(index: Int) {
    val at = if (index < 0) 0 else index
    views.homeGrid.scrollToPosition(at)
    views.homeGrid.doOnPreDraw {
      views.homeGrid.findViewHolderForAdapterPosition(at)?.itemView?.requestFocus()
    }
  }

  private fun openSeries(channel: ChannelSummary) {
    applyNav(reduceNav(nav, NavEvent.OpenSeries(channel.number)))
  }

  // ------------------------------------------------------------------- serie

  private fun showSeries(channelNumber: Int) {
    val channel = channels.firstOrNull { it.number == channelNumber } ?: return

    views.seriesTitle.text = channel.name
    views.seriesMeta.text = formatSeriesMeta(channel.year, channel.episodeCount)
    views.seriesOverview.text = channel.overview ?: ""
    views.seriesOverview.visibility = if (channel.overview == null) View.GONE else View.VISIBLE
    views.seriesInitials.text = initialsOf(channel.name)

    loadPoster(channel)
    loadEpisodes(channelNumber)

    // O foco vai para ASSISTIR AO VIVO: e o botao que a maioria quer, e sair
    // dele para a lista de episodios e uma seta para baixo.
    views.seriesLive.requestFocus()
  }

  private fun loadPoster(channel: ChannelSummary) {
    posterJob?.cancel()
    showSeriesPoster(null)

    val path = channel.posterUrl ?: return
    val width = resources.getDimensionPixelSize(R.dimen.series_poster_width)
    posterJob = lifecycleScope.launch {
      val bitmap = PosterLoader.load(api, path, width)
      // A serie pode ter mudado enquanto a capa vinha: sem esta conferencia,
      // uma capa atrasada pousaria na serie errada.
      if (nav.channelNumber == channel.number) showSeriesPoster(bitmap)
    }
  }

  private fun showSeriesPoster(bitmap: Bitmap?) {
    views.seriesPoster.setImageBitmap(bitmap)
    views.seriesPoster.visibility = if (bitmap == null) View.GONE else View.VISIBLE
    views.seriesInitials.visibility = if (bitmap == null) View.VISIBLE else View.GONE
  }

  private fun loadEpisodes(channelNumber: Int) {
    // A lista some antes da resposta chegar: um OK apressado nao pode tocar o
    // episodio da serie anterior.
    episodes = emptyList()
    episodeRows.items = emptyList()

    episodesJob?.cancel()
    episodesJob = lifecycleScope.launch {
      val loaded = try {
        api.episodes(channelNumber)
      } catch (error: UnauthorizedException) {
        applyNav(reduceNav(nav, NavEvent.SessionLost))
        return@launch
      } catch (error: IOException) {
        return@launch
      }

      if (nav.channelNumber != channelNumber) return@launch
      episodes = loaded.orEmpty()
      episodeRows.items = episodes
    }
  }

  /** ASSISTIR AO VIVO: entra na grade do canal, no ponto em que ela esta agora. */
  private fun watchLive() {
    val channelNumber = nav.channelNumber ?: return
    applyNav(reduceNav(nav, NavEvent.OpenPlayer(channelNumber)))
    tuner = initialTuner(channelNumber)
    lifecycleScope.launch { tune(channelNumber) }
    startTicker()
  }

  /** DO INICIO, ou OK numa linha do catalogo: maratona a partir dali. */
  private fun playFrom(index: Int) {
    val channelNumber = nav.channelNumber ?: return
    val channel = channels.firstOrNull { it.number == channelNumber } ?: return
    if (index !in episodes.indices) return

    applyNav(reduceNav(nav, NavEvent.OpenPlayer(channelNumber)))
    player.playOnDemand(channel, episodes, index)
  }

  // ----------------------------------------------------------- configuracoes

  private fun openSettings() {
    // O cursor e do reducer: o foco fica na raiz para as setas chegarem
    // inteiras ao `onKeyDown`, como no painel de trilhas.
    views.root.requestFocus()
    settingsUi = SettingsUiState()
    settingsAlert = false
    renderSettings()
    renderStatus()
    loadSettings()
    startStatusPoll()
  }

  private fun loadSettings() {
    settingsJob?.cancel()
    settingsJob = lifecycleScope.launch {
      val loaded = try {
        api.settings()
      } catch (error: UnauthorizedException) {
        applyNav(reduceNav(nav, NavEvent.SessionLost))
        return@launch
      } catch (error: IOException) {
        showSettingsMessage(getString(R.string.gate_offline), alert = true)
        return@launch
      }
      adoptSettings(loaded)
    }
  }

  /**
   * Adota o `AppSettings` que o servidor confirmou.
   *
   * O `Store` e a preferencia do player andam junto porque o servidor e a fonte
   * da verdade da escolha de idioma: mudar "audio em portugues" aqui tem que
   * valer no proximo episodio sem passar pelo painel de trilhas.
   */
  private fun adoptSettings(next: AppSettings) {
    settings = next
    store.applyServerSettings(next)
    player.prefs = TrackPrefs(next.audioLang, next.subtitleLang)
    renderSettings()
  }

  private fun handleSettingsKey(keyCode: Int, event: KeyEvent): Boolean {
    // Antes de o GET responder nao ha valor para mudar, e o reducer decide em
    // cima do `AppSettings` de verdade — nunca de um palpite. As teclas seguem
    // para o `super` para o VOLTAR continuar funcionando.
    val current = settings ?: return super.onKeyDown(keyCode, event)
    val settingsEvent = when (keyCode) {
      KeyEvent.KEYCODE_DPAD_UP -> SettingsEvent.Up
      KeyEvent.KEYCODE_DPAD_DOWN -> SettingsEvent.Down
      KeyEvent.KEYCODE_DPAD_LEFT -> SettingsEvent.Left
      KeyEvent.KEYCODE_DPAD_RIGHT -> SettingsEvent.Right
      KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER -> SettingsEvent.Select
      else -> return super.onKeyDown(keyCode, event)
    }
    applySettings(reduceSettings(settingsUi, settingsEvent, current))
    return true
  }

  private fun applySettings(result: SettingsResult) {
    settingsUi = result.state
    renderSettings()

    when (val command = result.command) {
      is SettingsCommand.Patch -> sendPatch(command)
      is SettingsCommand.Scan -> runTask { api.startScan(command.mode) }
      is SettingsCommand.RefreshMetadata -> runTask { api.refreshMetadata(command.reset) }
      null -> Unit
    }
  }

  private fun sendPatch(command: SettingsCommand.Patch) {
    val previous = settings ?: return
    // Otimista: a linha muda agora. Esperar o round-trip inteiro entre a seta e
    // o valor faria o controle remoto parecer quebrado.
    adoptSettings(applySettingsValue(previous, command.field, command.value))

    lifecycleScope.launch {
      val applied = try {
        api.patchSettings(bodyOf(command))
      } catch (error: UnauthorizedException) {
        applyNav(reduceNav(nav, NavEvent.SessionLost))
        return@launch
      } catch (error: IOException) {
        // PATCH que falha nao pode deixar a tela mentindo: o valor volta ao que
        // o servidor confirmou por ultimo, e o aviso explica por que ele voltou.
        adoptSettings(previous)
        showSettingsMessage(getString(R.string.settings_save_failed), alert = true)
        return@launch
      }
      adoptSettings(applied)
    }
  }

  /**
   * Traducao do comando do reducer em corpo de PATCH.
   *
   * Mora aqui, e nao em `ui/Settings.kt`, para o reducer continuar sem saber
   * que existe JSON do outro lado — e o mesmo motivo pelo qual o painel de
   * trilhas devolve um `id` opaco em vez de um `Tracks.Group`.
   */
  private fun bodyOf(command: SettingsCommand.Patch): JsonObject {
    val text = (command.value as? SettingsValue.Text)?.value
    val flag = (command.value as? SettingsValue.Flag)?.value ?: false
    return when (command.field) {
      SettingsField.AUDIO_LANG -> SettingsPatch.audioLang(text)
      SettingsField.SUBTITLE_LANG -> SettingsPatch.subtitleLang(text)
      SettingsField.RESCAN_TIME -> SettingsPatch.rescanTime(text)
      SettingsField.SUBTITLES_AUTO -> SettingsPatch.subtitlesAuto(flag)
      SettingsField.AUTO_REMUX -> SettingsPatch.autoRemux(flag)
      SettingsField.SMART_GROUPING -> SettingsPatch.smartGrouping(flag)
      // Inalcancavel: o reducer so emite `Patch` para as seis linhas de cima.
      // Objeto vazio e o unico no-op honesto no contrato.
      else -> JsonObject(emptyMap())
    }
  }

  /**
   * Dispara uma tarefa de fundo e devolve a linha ao normal.
   *
   * 202 e 409 chegam aqui do mesmo jeito, como resposta: um vira "iniciado", o
   * outro vira "ja esta rodando". Quem conta o resto e o polling.
   */
  private fun runTask(start: suspend () -> TaskAccepted) {
    lifecycleScope.launch {
      val accepted = try {
        start()
      } catch (error: UnauthorizedException) {
        applyNav(reduceNav(nav, NavEvent.SessionLost))
        return@launch
      } catch (error: IOException) {
        settingsUi = settingsUi.copy(busy = null)
        showSettingsMessage(getString(R.string.gate_offline), alert = true)
        return@launch
      }

      settingsUi = settingsUi.copy(busy = null)
      showSettingsMessage(
        if (accepted.started) getString(R.string.settings_started)
        else accepted.reason ?: getString(R.string.settings_already_running),
        alert = !accepted.started,
      )
      startStatusPoll()
    }
  }

  /**
   * Estado da biblioteca de 2 em 2 segundos, e SO enquanto ha o que ver.
   *
   * O loop morre em tres lugares: quando o scan e a busca de capas param, ao
   * sair da tela de configuracoes e no `onStop`. Um loop vivo com a tela
   * fechada e vazamento — bate na API para sempre, segura o `lifecycleScope`
   * ocupado e ninguem nunca mais o cancela.
   */
  private fun startStatusPoll() {
    statusPoll?.cancel()
    statusPoll = lifecycleScope.launch {
      while (isActive) {
        val status = try {
          api.libraryStatus()
        } catch (error: IOException) {
          // Servidor fora do ar no meio de um scan: para de perguntar em vez de
          // acumular request numa rede que nao responde.
          break
        }
        libraryStatus = status
        renderStatus()
        if (!libraryBusy(status)) break
        delay(STATUS_POLL_MS)
      }
    }
  }

  private fun stopStatusPoll() {
    statusPoll?.cancel()
    statusPoll = null
  }

  private fun showSettingsMessage(text: String, alert: Boolean) {
    settingsAlert = alert
    settingsUi = settingsUi.copy(message = text)
    renderSettings()
  }

  private fun renderSettings() {
    settingRows.bind(settingsRows(), settingsUi, settings)
    views.settingsList.scrollToPosition(settingsUi.cursor)

    val message = settingsUi.message
    views.settingsMessage.text = message ?: ""
    views.settingsMessage.visibility = show(message != null)
    views.settingsMessage.setTextColor(
      getColor(if (settingsAlert) R.color.danger else R.color.accent),
    )
  }

  private fun renderStatus() {
    val status = libraryStatus

    val progress = status?.let { scanProgressText(it) }
    views.settingsProgressText.text = progress ?: ""
    views.settingsProgressText.visibility = show(progress != null)

    val percent = status?.let { scanProgressPercent(it) }
    views.settingsProgress.visibility = show(percent != null)
    if (percent != null) views.settingsProgress.progress = percent

    val summary = status?.let { scanSummaryText(it) }
    views.settingsScanSummary.text = summary ?: ""
    views.settingsScanSummary.visibility = show(summary != null)

    val metadata = status?.let { metadataText(it) }
    views.settingsMetadata.text = metadata ?: ""
    views.settingsMetadata.visibility = show(metadata != null)
  }

  // ------------------------------------------------------------------ player

  private suspend fun tune(channelNumber: Int) {
    val ok = try {
      player.tune(channelNumber)
    } catch (error: UnauthorizedException) {
      applyNav(reduceNav(nav, NavEvent.SessionLost))
      return
    } catch (error: IOException) {
      Log.w(TAG, "falha ao sintonizar $channelNumber", error)
      false
    }

    if (!ok) {
      showOsd(getString(R.string.no_signal))
      return
    }
    // So grava depois de sintonizar de verdade: guardar um canal que nao abriu
    // deixaria a proxima abertura comecando errado.
    store.writeLastChannel(channelNumber)
    applyNav(reduceNav(nav, NavEvent.LiveTuned(channelNumber)))
  }

  override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
    // No portao e nas listas quem manda e o foco nativo: os campos precisam das
    // setas para andar entre si.
    if (nav.screen == ScreenId.GATE) return super.onKeyDown(keyCode, event)
    // As configuracoes tem cursor proprio, como o painel de trilhas: a lista
    // mistura linhas que a seta lateral edita com linhas que so o OK dispara.
    if (nav.screen == ScreenId.SETTINGS) return handleSettingsKey(keyCode, event)
    if (panel.open) return handlePanelKey(keyCode, event)
    if (nav.screen != ScreenId.PLAYER) return super.onKeyDown(keyCode, event)

    val live = player.mode == ChannelPlayer.PlaybackMode.LIVE

    when (keyCode) {
      KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_MENU -> {
        openPanel()
        return true
      }

      KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
      KeyEvent.KEYCODE_MEDIA_PAUSE,
      KeyEvent.KEYCODE_MEDIA_PLAY,
      -> {
        // A grade nao tem pausa. A tecla morre aqui mesmo assim: deixar o
        // sistema fazer alguma coisa com ela seria pior do que nao fazer nada.
        if (!live) player.togglePause()
        return true
      }

      KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_CHANNEL_UP ->
        if (live) return step(1, event.repeatCount)

      KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_CHANNEL_DOWN ->
        if (live) return step(-1, event.repeatCount)

      KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_MEDIA_REWIND ->
        if (!live) return seek(-SEEK_MS)

      KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent.KEYCODE_MEDIA_FAST_FORWARD ->
        if (!live) return seek(SEEK_MS)
    }

    // Sintonia direta por digito, como num controle antigo. So ao vivo: numa
    // maratona nao ha canal para onde ir.
    val digit = digitOf(keyCode)
    if (live && digit != null) {
      applyTuner(reduceTuner(tuner, TunerEvent.Digit(digit, now()), channelNumbers()))
      return true
    }

    return super.onKeyDown(keyCode, event)
  }

  private fun seek(deltaMs: Long): Boolean {
    player.seekBy(deltaMs)
    return true
  }

  private fun step(delta: Int, repeatCount: Int): Boolean {
    applyTuner(reduceTuner(tuner, TunerEvent.Step(delta, repeatCount, now()), channelNumbers()))
    return true
  }

  private fun applyTuner(result: TunerResult) {
    tuner = result.state

    if (result.invalid) {
      showOsd(getString(R.string.no_signal))
      return
    }
    if (result.digits != null) {
      showOsd("${result.digits}_")
      return
    }
    result.preview?.let { showOsd(labelFor(it)) }
    result.tuneTo?.let { target -> lifecycleScope.launch { tune(target) } }
  }

  private fun channelNumbers(): List<Int> = channels.map { it.number }

  private fun digitOf(keyCode: Int): Char? =
    if (keyCode in KeyEvent.KEYCODE_0..KeyEvent.KEYCODE_9) {
      '0' + (keyCode - KeyEvent.KEYCODE_0)
    } else {
      null
    }

  private fun labelFor(channelNumber: Int): String {
    val channel = channels.firstOrNull { it.number == channelNumber }
      ?: return formatChannelNumber(channelNumber)
    return formatNowLine(channel, null)
  }

  private fun showOsd(text: String, sticky: Boolean = false) {
    views.osd.text = text
    views.osd.visibility = View.VISIBLE
    osdHide?.cancel()
    if (sticky) return
    osdHide = lifecycleScope.launch {
      delay(OSD_HOLD_MS)
      views.osd.visibility = View.GONE
    }
  }

  /**
   * O commit por tempo do sintonizador precisa de um pulso externo: o reducer e
   * puro justamente para nao ter timer proprio.
   */
  private fun startTicker() {
    if (ticker != null) return
    ticker = lifecycleScope.launch {
      while (isActive) {
        delay(TICK_MS)
        if (tuner.buffer.isEmpty() && tuner.pending == null) continue
        applyTuner(reduceTuner(tuner, TunerEvent.Tick(now()), channelNumbers()))
      }
    }
  }

  private fun stopTicker() {
    ticker?.cancel()
    ticker = null
  }

  private fun now() = System.currentTimeMillis()

  // --------------------------------------------------- painel de audio/legenda

  /**
   * Le as trilhas do item que esta tocando e entrega ao reducer ja rotuladas.
   *
   * A ordem dos grupos aqui vira o `id` das opcoes: o painel devolve o indice, e
   * a traducao de volta em `Tracks.Group` e uma indexacao.
   */
  private fun openPanel() {
    val groups = player.tracks.groups
    audioGroups = groups.filter { it.type == C.TRACK_TYPE_AUDIO && it.isSupported }
    textGroups = groups.filter { it.type == C.TRACK_TYPE_TEXT && it.isSupported }

    val audio = audioGroups.mapIndexed { index, group -> option(index, group, forced = false) }
    val text = textGroups.mapIndexed { index, group -> option(index, group, forced = true) }
    if (audio.isEmpty() && text.isEmpty()) return

    applyPanel(
      reduceTrackPanel(
        panel,
        TrackPanelEvent.Open(audio, text, getString(R.string.tracks_off)),
      ),
    )
  }

  /**
   * Rotulo de uma trilha: o que o container escreveu, o nome do idioma, ou o
   * codigo cru como ultimo recurso. Um "eng" na tela nao ajuda ninguem a
   * escolher a dublagem.
   */
  private fun option(index: Int, group: Tracks.Group, forced: Boolean): TrackOption {
    val format = group.getTrackFormat(0)
    val name = format.label
      ?: languageLabel(format.language)
      ?: getString(R.string.tracks_unnamed, index + 1)

    val isForced = forced && (format.selectionFlags and C.SELECTION_FLAG_FORCED) != 0
    return TrackOption(
      id = index.toString(),
      label = if (isForced) getString(R.string.tracks_forced, name) else name,
      selected = group.isSelected,
    )
  }

  /**
   * O painel come as setas e o OK, e mais nada.
   *
   * VOLTAR precisa chegar ao `super`: e ele que arma o rastreamento da tecla, e
   * sem isso o `onBackPressedDispatcher` — que e quem fecha o painel — nunca
   * seria chamado no `onKeyUp`.
   */
  private fun handlePanelKey(keyCode: Int, event: KeyEvent): Boolean {
    when (keyCode) {
      KeyEvent.KEYCODE_DPAD_UP -> applyPanel(reduceTrackPanel(panel, TrackPanelEvent.Move(-1)))
      KeyEvent.KEYCODE_DPAD_DOWN -> applyPanel(reduceTrackPanel(panel, TrackPanelEvent.Move(1)))
      KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER ->
        applyPanel(reduceTrackPanel(panel, TrackPanelEvent.Select))

      else -> return super.onKeyDown(keyCode, event)
    }
    return true
  }

  private fun applyPanel(result: TrackPanelResult) {
    panel = result.state

    result.choose?.let { choice ->
      when (choice.kind) {
        TrackKind.AUDIO -> chooseAudio(choice.id)
        TrackKind.TEXT -> chooseSubtitle(choice.id)
      }
    }

    if (result.close) {
      closePanel()
      return
    }

    trackRows.rows = rows(panel)
    trackRows.cursor = panel.cursor
    views.trackList.scrollToPosition(panel.cursor)
    views.tracks.visibility = View.VISIBLE
    views.osd.visibility = View.GONE
  }

  private fun closePanel() {
    panel = TrackPanelState()
    views.tracks.visibility = View.GONE
    views.root.requestFocus()
  }

  private fun chooseAudio(id: String) {
    val group = audioGroups.getOrNull(id.toIntOrNull() ?: return) ?: return
    // Guarda o IDIOMA e fixa o GRUPO: o idioma atravessa episodios e reinicios,
    // o grupo resolve o caso de duas faixas dividirem a mesma tag.
    val lang = group.getTrackFormat(0).language ?: C.LANGUAGE_UNDETERMINED
    store.audioLang = lang
    player.prefs = player.prefs.copy(audioLang = lang)
    player.overrideAudio(group)
    pushPreference(SettingsPatch.audioLang(canonicalLang(lang)))
  }

  private fun chooseSubtitle(id: String) {
    if (id == TRACK_OFF) {
      store.subtitleLang = null
      player.prefs = player.prefs.copy(subtitleLang = null)
      // null tambem no servidor: o contrato usa `subtitleLang: null` para
      // "desativadas", que e a mesma semantica do `Store`.
      pushPreference(SettingsPatch.subtitleLang(null))
      return
    }
    val group = textGroups.getOrNull(id.toIntOrNull() ?: return) ?: return
    val lang = group.getTrackFormat(0).language ?: C.LANGUAGE_UNDETERMINED
    store.subtitleLang = lang
    player.prefs = player.prefs.copy(subtitleLang = lang)
    player.overrideText(group)
    pushPreference(SettingsPatch.subtitleLang(canonicalLang(lang)))
  }

  /**
   * Manda para o servidor a escolha feita no painel, sem esperar resposta.
   *
   * A preferencia agora e da casa inteira, e nao so desta TV. Falhar aqui nao
   * pode atrapalhar quem esta assistindo — o `Store` ja guardou a escolha e o
   * player ja obedeceu —, por isso o erro morre em silencio.
   *
   * A resposta NAO volta para `player.prefs`: reaplica-la chamaria `applyPrefs`,
   * que limpa os overrides, e a faixa exata que acabou de ser fixada morreria
   * no meio da cena.
   */
  private fun pushPreference(body: JsonObject) {
    lifecycleScope.launch {
      val applied = runCatching { api.patchSettings(body) }.getOrNull() ?: return@launch
      settings = applied
      store.applyServerSettings(applied)
    }
  }

  // ------------------------------------------------------------------ eventos

  private val playerEvents = object : ChannelPlayer.Events {
    override fun onTuned(playing: NowPlaying) {
      showOsd(formatNowLine(playing.channel, playing.episode))
    }

    override fun onEpisodeChange(playing: NowPlaying) {
      showOsd(formatNowLine(playing.channel, playing.episode))
    }

    override fun onStalled() {
      showOsd(getString(R.string.no_signal))
    }

    override fun onError(error: Throwable) {
      if (error is UnauthorizedException) {
        applyNav(reduceNav(nav, NavEvent.SessionLost))
      } else {
        Log.w(TAG, "erro no player", error)
      }
    }

    override fun onVodEpisode(channel: ChannelSummary, episode: EpisodeRef) {
      showOsd(formatNowLine(channel, episode))
    }

    override fun onVodEnded() {
      // A maratona acabou. Volta para a serie, que e de onde ela saiu — tela
      // preta com o app aberto nao e um lugar onde deixar alguem.
      applyNav(reduceNav(nav, NavEvent.Back))
    }
  }

  private companion object {
    const val TAG = "WideTv"
    const val OSD_HOLD_MS = 3_000L
    const val SEEK_MS = 10_000L
    const val GRID_COLUMNS = 5

    /** Fino o suficiente para o commit de 250ms do passo nao parecer travado. */
    const val TICK_MS = 100L

    /**
     * Um scan mede milhares de arquivos: a contagem anda devagar e perguntar
     * mais que isso so gastaria rede para redesenhar o mesmo numero.
     */
    const val STATUS_POLL_MS = 2_000L
  }
}
