package com.widetv.app

import android.graphics.Bitmap
import android.graphics.Rect
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.Toast
import androidx.activity.addCallback
import androidx.annotation.OptIn
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.core.view.doOnPreDraw
import androidx.lifecycle.lifecycleScope
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.widetv.app.databinding.ActivityMainBinding
import com.widetv.app.net.ApiClient
import com.widetv.app.net.AppSettings
import com.widetv.app.net.BadServerUrlException
import com.widetv.app.net.ChannelSummary
import com.widetv.app.net.EpisodeRef
import com.widetv.app.net.LibraryStatus
import com.widetv.app.net.NowPlaying
import com.widetv.app.net.ResumeEntry
import com.widetv.app.net.WatchProgress
import com.widetv.app.net.SettingsPatch
import com.widetv.app.net.Store
import com.widetv.app.net.TaskAccepted
import com.widetv.app.net.UnauthorizedException
import com.widetv.app.player.ChannelPlayer
import com.widetv.app.player.ProgressSnapshot
import com.widetv.app.player.ProgressState
import com.widetv.app.player.TrackPrefs
import com.widetv.app.player.decideProgress
import com.widetv.app.tuner.TunerEvent
import com.widetv.app.tuner.TunerResult
import com.widetv.app.tuner.TunerState
import com.widetv.app.tuner.initialTuner
import com.widetv.app.tuner.reduceTuner
import com.widetv.app.ui.BackLayer
import com.widetv.app.ui.EpisodeAdapter
import com.widetv.app.ui.HeroModel
import com.widetv.app.ui.NavEvent
import com.widetv.app.ui.NavResult
import com.widetv.app.ui.NavState
import com.widetv.app.ui.PosterAdapter
import com.widetv.app.ui.PosterLoader
import com.widetv.app.ui.ScreenId
import com.widetv.app.ui.ScrubEvent
import com.widetv.app.ui.ScrubResult
import com.widetv.app.ui.ScrubState
import com.widetv.app.ui.SeasonAdapter
import com.widetv.app.ui.SeasonTab
import com.widetv.app.ui.SettingsAdapter
import com.widetv.app.ui.SettingsCommand
import com.widetv.app.ui.SettingsEvent
import com.widetv.app.ui.SettingsField
import com.widetv.app.ui.SettingsGroup
import com.widetv.app.ui.SettingsResult
import com.widetv.app.ui.SettingsUiState
import com.widetv.app.ui.SettingsValue
import com.widetv.app.ui.TRACK_OFF
import com.widetv.app.ui.TallCard
import com.widetv.app.ui.TrackAdapter
import com.widetv.app.ui.TrackKind
import com.widetv.app.ui.TrackOption
import com.widetv.app.ui.TrackPanelEvent
import com.widetv.app.ui.TrackPanelResult
import com.widetv.app.ui.TrackPanelState
import com.widetv.app.ui.WideCard
import com.widetv.app.ui.ControlAction
import com.widetv.app.ui.ControlId
import com.widetv.app.ui.PlayerControlsEvent
import com.widetv.app.ui.PlayerControlsResult
import com.widetv.app.ui.PlayerControlsState
import com.widetv.app.ui.WideCardAdapter
import com.widetv.app.ui.activeTab
import com.widetv.app.ui.applySettingsValue
import com.widetv.app.ui.backLayer
import com.widetv.app.ui.barProgress
import com.widetv.app.ui.canonicalLang
import com.widetv.app.ui.controlRail
import com.widetv.app.ui.EpisodeProgress
import com.widetv.app.ui.episodeItems
import com.widetv.app.ui.formatChannelBadge
import com.widetv.app.ui.formatChannelNumber
import com.widetv.app.ui.formatClock
import com.widetv.app.ui.formatEpisodeSub
import com.widetv.app.ui.formatNowLine
import com.widetv.app.ui.formatScrubLeft
import com.widetv.app.ui.formatScrubNote
import com.widetv.app.ui.formatSeasonsMeta
import com.widetv.app.ui.formatTrackDetail
import com.widetv.app.ui.formatUpNextTime
import com.widetv.app.ui.heroFor
import com.widetv.app.ui.initialScrub
import com.widetv.app.ui.initialsOf
import com.widetv.app.ui.languageLabel
import com.widetv.app.ui.libraryBusy
import com.widetv.app.ui.liveRail
import com.widetv.app.ui.metadataText
import com.widetv.app.ui.packNav
import com.widetv.app.ui.panelNote
import com.widetv.app.ui.playerHint
import com.widetv.app.ui.railSticky
import com.widetv.app.ui.reduceNav
import com.widetv.app.ui.reducePlayerControls
import com.widetv.app.ui.reduceScrub
import com.widetv.app.ui.reduceSettings
import com.widetv.app.ui.reduceTrackPanel
import com.widetv.app.ui.restoreSeasonAt
import com.widetv.app.ui.resumeRail
import com.widetv.app.ui.rows
import com.widetv.app.ui.scanSummaryText
import com.widetv.app.ui.seasonAside
import com.widetv.app.ui.seasonIndices
import com.widetv.app.ui.seasonTabs
import com.widetv.app.ui.seriesResumeLabel
import com.widetv.app.ui.shelfRail
import com.widetv.app.ui.taskCard
import com.widetv.app.ui.unpackNav
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import java.io.IOException
import kotlin.math.abs

/**
 * Unica tela do app: acesso, acervo, serie, player e configuracoes empilhados
 * por visibilidade.
 *
 * Aqui so ha cola. Toda decisao esta em reducers e funcoes puras, testadas —
 * `ui/Nav.kt` (para onde cada tecla leva), `ui/Catalog.kt` (o que cada faixa
 * mostra), `ui/Seasons.kt` (as abas e as linhas de episodio),
 * `ui/TrackPanel.kt` (o painel de audio e legenda), `ui/Settings.kt` (a tela de
 * configuracoes), `tuner/Tuner.kt` (zap ao vivo) e `player/Sync.kt` (deriva da
 * grade). Este arquivo mexe em View, ExoPlayer e rede, e mais nada.
 */
@OptIn(UnstableApi::class)
class MainActivity : AppCompatActivity() {

  private lateinit var views: ActivityMainBinding
  private lateinit var store: Store
  private lateinit var api: ApiClient
  private lateinit var player: ChannelPlayer

  private lateinit var liveRow: WideCardAdapter
  private lateinit var resumeRow: WideCardAdapter
  private lateinit var shelfRow: PosterAdapter
  private lateinit var episodeRows: EpisodeAdapter
  private lateinit var seasonRows: SeasonAdapter
  private lateinit var trackRows: TrackAdapter
  private lateinit var playbackRows: SettingsAdapter
  private lateinit var libraryRows: SettingsAdapter

  private var channels: List<ChannelSummary> = emptyList()

  /** `GET /api/now`. Vazio quando a rota nao existe: a faixa some, o resto fica. */
  private var live: List<NowPlaying> = emptyList()

  /** `GET /api/history/resume`. Mesma regra do `live`. */
  private var resume: List<ResumeEntry> = emptyList()

  /**
   * `GET /api/history` por id de episodio: barra e marca de visto da lista de
   * episodios. Separado do [resume] porque aquele vem deduplicado por serie e
   * sem os ja vistos — util para a faixa, inutil para a lista.
   */
  private var history: Map<String, WatchProgress> = emptyMap()

  /** Texto da busca da topbar. Filtra so a faixa do acervo, sem rede. */
  private var query: String = ""

  private var nav = NavState()
  private var tuner: TunerState = initialTuner(0)
  private var panel = TrackPanelState()

  /**
   * Fileira de acoes do overlay e o cursor que anda nela. E o que torna audio,
   * legenda, episodios e mudo alcancaveis num controle que so tem D-PAD, OK e
   * VOLTAR.
   */
  private var controls = PlayerControlsState()

  /** Scrub do sob demanda: as setas movem este alvo, e o seek sai pelo tick. */
  private var scrub: ScrubState = initialScrub(0L)

  /**
   * Ultima gravacao de "onde parei". Zerado a cada episodio: dois episodios
   * podem parar no mesmo minuto, e o segundo tem que ser gravado.
   */
  private var progress = ProgressState()

  /**
   * Tela salva em `onSaveInstanceState`, esperando o acervo carregar para ser
   * reaberta. So da para validar o canal restaurado com a lista de canais na
   * mao — e ela chega pela rede, depois do `Authenticated`.
   */
  private var pendingRestore: NavState? = null

  /**
   * "Lembrar este idioma" do painel de trilhas. Estado LOCAL, e nao
   * `AppSettings`: desligado, a escolha vale so nesta sessao e nada e gravado no
   * servidor — guardar isso em `AppSettings` seria gravar justamente o que a
   * pessoa pediu para nao gravar.
   */
  private var rememberTrack: Boolean = true

  /** Preferencias do servidor. null enquanto `GET /api/settings` nao respondeu. */
  private var settings: AppSettings? = null
  private var settingsUi = SettingsUiState()
  private var libraryStatus: LibraryStatus? = null

  /** true quando a mensagem da tela e recusa ou falha, e nao confirmacao. */
  private var settingsAlert = false

  /** Episodios da serie aberta. Vazio enquanto o catalogo nao chegou. */
  private var episodes: List<EpisodeRef> = emptyList()
  private var seasons: List<SeasonTab> = emptyList()
  private var seasonAt: Int = 0

  /** Canal dono da lista [episodes]; null enquanto nenhuma serie carregou. */
  private var episodesChannel: Int? = null

  /**
   * Onde a tela de serie estava quando o player abriu: aba de temporada e
   * indice (na fila inteira do canal) do episodio que saiu tocando.
   *
   * E o que o VOLTAR do player restaura — a serie reabre no ponto exato, e nao
   * zerada na primeira aba. O `episodeIndex` anda junto com a maratona pelo
   * `onVodEpisode`: quem voltou do quinto episodio quer o foco no quinto, nao
   * no que apertou OK meia temporada atras.
   */
  private data class SeriesReturn(
    val channelNumber: Int,
    val seasonAt: Int,
    /** -1 quando o player abriu ao vivo: nao ha linha de episodio a focar. */
    val episodeIndex: Int,
  )

  private var seriesReturn: SeriesReturn? = null

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
  private var backdropJob: Job? = null
  private var heroJob: Job? = null
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

    wireHome()
    wireSeries()
    wirePlayer()
    wireSettings()

    // VOLTAR desce a hierarquia do `backLayer`: cada camada aberta no player
    // engole a tecla (painel de trilhas, digitos do tuner, overlay) antes de a
    // navegacao andar. A ordem mora no reducer; aqui so se descreve a tela.
    onBackPressedDispatcher.addCallback(this) {
      val typingChannel = tuner.buffer.isNotEmpty() && nav.screen == ScreenId.PLAYER
      val overlayVisible =
        views.overlay.visibility == View.VISIBLE && nav.screen == ScreenId.PLAYER
      val railCursorOn = controls.cursor != null && nav.screen == ScreenId.PLAYER
      when (backLayer(panel.open, typingChannel, railCursorOn, overlayVisible)) {
        BackLayer.CLOSE_PANEL -> applyPanel(reduceTrackPanel(panel, TrackPanelEvent.Close))

        // Cancela o "12_" digitado sem trocar o canal que esta no ar. O overlay
        // fica: ele e a proxima camada, e o VOLTAR seguinte o esconde.
        BackLayer.CLEAR_TUNER -> {
          tuner = initialTuner(tuner.current)
          views.osd.visibility = View.GONE
        }

        // Desistiu do menu: o video volta a obedecer as setas, com a barra ainda
        // na tela. O VOLTAR seguinte e que apaga tudo.
        BackLayer.CLEAR_RAIL ->
          applyControls(reducePlayerControls(controls, PlayerControlsEvent.ClearCursor))

        BackLayer.HIDE_OVERLAY -> hideOverlayNow()

        BackLayer.NAVIGATE -> {
          val result = reduceNav(nav, NavEvent.Back(now()))
          when {
            result.confirmExit -> {
              applyNav(result)
              Toast.makeText(this@MainActivity, R.string.home_exit_confirm, Toast.LENGTH_SHORT)
                .show()
            }

            !result.exit -> applyNav(result)

            else -> {
              isEnabled = false
              onBackPressedDispatcher.onBackPressed()
            }
          }
        }
      }
    }

    views.gateSubmit.setOnClickListener { submitGate() }

    // O Enter do teclado virtual anda o fluxo do portao: do servidor para a
    // senha, e da senha direto para o envio — sem obrigar ninguem a fechar o
    // teclado e cacar o botao com o D-pad.
    views.gateServer.setOnEditorActionListener { _, actionId, _ ->
      if (actionId == EditorInfo.IME_ACTION_NEXT) {
        views.gatePassword.requestFocus()
        true
      } else {
        false
      }
    }
    views.gatePassword.setOnEditorActionListener { _, actionId, _ ->
      if (actionId == EditorInfo.IME_ACTION_DONE) {
        submitGate()
        true
      } else {
        false
      }
    }

    lifecycleScope.launch {
      val event = if (hasAccess()) NavEvent.Authenticated else NavEvent.SessionLost
      // A tela salva so volta com sessao valida — e quem a reabre e o acervo,
      // depois de carregar os canais e validar o que foi salvo.
      if (event == NavEvent.Authenticated) {
        pendingRestore = unpackNav(savedInstanceState?.getString(KEY_NAV))
      }
      applyNav(reduceNav(nav, event))
      if (event == NavEvent.Authenticated) seedSettings()
    }
  }

  override fun onSaveInstanceState(outState: Bundle) {
    super.onSaveInstanceState(outState)
    outState.putString(KEY_NAV, packNav(nav))
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

  /**
   * true enquanto um 401 ja esta sendo tratado: os demais desistem em silencio.
   * E o que limita o relogin a UMA tentativa por evento — um servidor que aceita
   * a senha mas segue devolvendo 401 nao pode virar um loop de login.
   */
  private var handling401 = false

  /**
   * 401 no meio do uso. Antes de derrubar alguem para o portao, tenta refazer a
   * sessao em silencio com [hasAccess]: o cookie vence sozinho, e so cookie
   * invalido E senha rejeitada merecem a tela de senha de novo.
   *
   * A chamada que falhou NAO e refeita: com a sessao refeita, a proxima acao ja
   * funciona, e repetir requests por conta propria e o primeiro passo de um
   * loop.
   */
  private suspend fun onUnauthorized() {
    if (handling401) return
    handling401 = true
    try {
      if (hasAccess()) return
      applyNav(reduceNav(nav, NavEvent.SessionLost))
    } finally {
      handling401 = false
    }
  }

  /**
   * A TV acorda limpa. Retomar depois do standby nao e possivel de todo jeito:
   * a grade andou sozinha, e um episodio sob demanda pausado no escuro por
   * horas nao e um lugar de onde continuar.
   *
   * O rebaixamento acontece AQUI, e nao no `onStop`: trocar de tela com a
   * Activity invisivel deixaria o `requestFocus` da tela de chegada falar com
   * uma janela que nao existe, e o foco acordaria perdido.
   */
  override fun onStart() {
    super.onStart()
    if (nav.screen == ScreenId.PLAYER) applyNav(reduceNav(nav, NavEvent.Back(now())))
  }

  override fun onStop() {
    super.onStop()
    // O app foi para segundo plano com o episodio no ar (botao HOME da TV, troca
    // de entrada HDMI). Mesma razao do `applyNav`: depois do `stop` a posicao ja
    // nao existe.
    reportProgress(forced = true)
    stopTicker()
    stopStatusPoll()
    player.stop()
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
      // ANTES do stop: depois dele a posicao ja nao existe, e sair pelo VOLTAR
      // e justamente o jeito mais comum de terminar uma sessao.
      reportProgress(forced = true)
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
      ScreenId.PLAYER -> openPlayer()
      ScreenId.SETTINGS -> openSettings()
    }
  }

  private fun show(visible: Boolean) = if (visible) View.VISIBLE else View.GONE

  // ------------------------------------------------------------------ acesso

  private fun openGate() {
    views.gateServer.setText(store.serverUrl)
    // Primeiro uso: sem servidor guardado, o endereco e o primeiro campo a
    // preencher. Com ele na mao, so a senha falta.
    if (store.serverUrl.isEmpty()) {
      views.gateServer.requestFocus()
    } else {
      views.gatePassword.requestFocus()
    }
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

  private fun logout() {
    // A senha sai junto: sem isso o relogin automatico refaria a sessao no
    // proximo request e o botao nao teria feito nada.
    store.password = null
    channels = emptyList()
    live = emptyList()
    resume = emptyList()
    lifecycleScope.launch { api.logout() }
    applyNav(reduceNav(nav, NavEvent.SessionLost))
  }

  // ------------------------------------------------------------------ acervo

  private fun wireHome() {
    liveRow = WideCardAdapter(lifecycleScope, api, ::enterChannel)
    views.railLive.layoutManager = horizontal()
    views.railLive.adapter = liveRow

    resumeRow = WideCardAdapter(lifecycleScope, api, ::continueCard)
    views.railResume.layoutManager = horizontal()
    views.railResume.adapter = resumeRow

    shelfRow = PosterAdapter(lifecycleScope, api, ::openSeries)
    views.railShelf.layoutManager = horizontal()
    views.railShelf.adapter = shelfRow

    views.homeSettings.setOnClickListener { applyNav(reduceNav(nav, NavEvent.OpenSettings)) }
    views.homeLogout.setOnClickListener { logout() }

    views.heroPlay.setOnClickListener { heroChannel()?.let { enterLive(it.number) } }
    views.heroEpisodes.setOnClickListener { heroChannel()?.let { openSeries(it.number) } }
    views.heroFirst.setOnClickListener {
      heroChannel()?.let { channel ->
        // "Do inicio" precisa da lista de episodios, que so a tela de serie
        // carrega. Abrir a serie e o passo honesto: um botao que baixa 300
        // episodios em silencio deixaria a tela parada sem explicacao.
        openSeries(channel.number)
      }
    }

    views.topbarNavHome.setOnClickListener {
      views.rowsScroll.smoothScrollTo(0, 0)
      views.heroPlay.requestFocus()
    }
    views.topbarNavLive.setOnClickListener { focusRail(views.railLive) }
    views.topbarNavShelf.setOnClickListener { focusRail(views.railShelf) }

    views.topbarSearchInput.addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
      override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
      override fun afterTextChanged(s: Editable?) {
        query = s?.toString().orEmpty()
        renderShelf()
      }
    })

    // O campo de busca nao pode virar armadilha horizontal: dentro do texto a
    // seta move o cursor, mas com o cursor ja na ponta ela vira navegacao e sai
    // pelos vizinhos do XML (`nextFocusLeft`/`nextFocusRight=home_settings`).
    views.topbarSearchInput.setOnKeyListener { view, keyCode, event ->
      if (event.action != KeyEvent.ACTION_DOWN) return@setOnKeyListener false
      val input = view as EditText
      val atStart = input.selectionStart <= 0 && input.selectionEnd <= 0
      val atEnd = input.selectionStart >= input.length() && input.selectionEnd >= input.length()
      val direction = when {
        keyCode == KeyEvent.KEYCODE_DPAD_LEFT && atStart -> View.FOCUS_LEFT
        keyCode == KeyEvent.KEYCODE_DPAD_RIGHT && atEnd -> View.FOCUS_RIGHT
        else -> return@setOnKeyListener false
      }
      val next = input.focusSearch(direction) ?: return@setOnKeyListener false
      next.requestFocus()
    }

    // A nav do topo acende sozinha conforme o foco anda: marcar so no clique
    // faria "Ao vivo" continuar aceso depois de a seta ja ter descido ao acervo.
    views.home.viewTreeObserver.addOnGlobalFocusChangeListener { _, focused ->
      if (focused != null && views.home.visibility == View.VISIBLE) markTopNav(focused)
    }
  }

  private fun horizontal() = LinearLayoutManager(this, RecyclerView.HORIZONTAL, false)

  /** @param focusOn serie de onde o VOLTAR veio, para o foco cair nela. */
  private fun openHome(focusOn: Int?) {
    if (channels.isNotEmpty()) {
      views.homeStatus.visibility = View.GONE
      focusShelf(focusOn)
      // A grade andou enquanto alguem estava na serie ou no player: as duas
      // faixas de cima falam de AGORA, e mostrar o episodio de meia hora atras
      // seria pior do que nao ter faixa nenhuma.
      loadRails()
      return
    }

    views.homeStatus.setText(R.string.home_loading)
    views.homeStatus.visibility = View.VISIBLE

    lifecycleScope.launch {
      val loaded = try {
        api.channels()
      } catch (error: UnauthorizedException) {
        onUnauthorized()
        return@launch
      } catch (error: IOException) {
        views.homeStatus.setText(R.string.gate_offline)
        return@launch
      }

      channels = loaded
      renderShelf()
      views.homeStatus.visibility = if (loaded.isEmpty()) View.VISIBLE else View.GONE
      if (loaded.isEmpty()) {
        views.homeStatus.setText(R.string.home_empty)
        consumePendingRestore()
        return@launch
      }
      renderHero()
      focusShelf(focusOn)
      loadRails()
      consumePendingRestore()
    }
  }

  /**
   * Reabre a tela salva antes da recriacao da Activity, agora que os canais
   * chegaram e da para conferir se a serie salva ainda existe: a biblioteca
   * pode ter mudado entre uma sessao e outra, e restaurar uma tela de serie
   * vazia seria pior que ficar no acervo, que ja esta na tela.
   */
  private fun consumePendingRestore() {
    val target = pendingRestore ?: return
    pendingRestore = null
    when (target.screen) {
      ScreenId.SERIES -> {
        val channelNumber = target.channelNumber ?: return
        if (channels.none { it.number == channelNumber }) return
        applyNav(reduceNav(nav, NavEvent.OpenSeries(channelNumber)))
      }

      ScreenId.SETTINGS -> applyNav(reduceNav(nav, NavEvent.OpenSettings))

      // HOME ja esta na tela. PLAYER nunca sai do `unpackNav` como alvo, e um
      // GATE salvo nao tem o que restaurar: a sessao acabou de ser validada.
      else -> Unit
    }
  }

  /**
   * As duas faixas novas, cada uma por conta propria.
   *
   * As rotas sao NOVAS: um servidor mais antigo devolve 404 e a faixa
   * correspondente simplesmente nao aparece. Por isso as duas sao independentes
   * e nenhuma delas propaga erro — o acervo ja esta na tela e continua inteiro.
   */
  private fun loadRails() {
    lifecycleScope.launch {
      live = runCatching { api.nowAll() }.getOrDefault(emptyList())
      renderLive()
      renderHero()
    }
    lifecycleScope.launch {
      resume = runCatching { api.resume() }.getOrDefault(emptyList())
      renderResume()
    }
    // O historico cru nao alimenta faixa nenhuma: ele e o que a lista de
    // episodios da serie consulta para desenhar a barra e a marca de visto.
    lifecycleScope.launch {
      history = runCatching { api.history() }.getOrDefault(emptyList())
        .associateBy { it.episodeId }
      if (nav.screen == ScreenId.SERIES) renderSeasons()
    }
  }

  private fun renderShelf() {
    shelfRow.items = shelfRail(channels, query)
    views.rowShelf.visibility = show(shelfRow.itemCount > 0)
    views.rowShelfAside.text = if (query.isEmpty()) "A → Z" else "${shelfRow.itemCount} encontradas"
    wireRailFocus()
  }

  private fun renderLive() {
    liveRow.items = liveRail(live, now())
    views.rowLive.visibility = show(liveRow.itemCount > 0)
    views.rowLiveAside.text = "${liveRow.itemCount} canais"
    wireRailFocus()
  }

  private fun renderResume() {
    resumeRow.items = resumeRail(resume)
    views.rowResume.visibility = show(resumeRow.itemCount > 0)
    wireRailFocus()
  }

  /**
   * Canal do hero: o ultimo assistido, ou o primeiro do acervo.
   *
   * Abrir sempre no canal 1 faria quem assiste a mesma serie todo dia comecar de
   * um estranho toda vez.
   */
  private fun heroChannel(): ChannelSummary? {
    val last = store.readLastChannel(channelNumbers())
    return channels.firstOrNull { it.number == last } ?: channels.firstOrNull()
  }

  private fun renderHero() {
    val channel = heroChannel() ?: return
    val playing = live.firstOrNull { it.channel.number == channel.number }
    val hero = heroFor(channel, playing, now())

    views.heroChipText.text = hero.chip
    views.heroTitle.text = hero.title
    views.heroMeta.text = hero.meta
    views.heroText.text = hero.text
    views.heroText.visibility = show(hero.text.isNotEmpty())

    loadHeroArt(hero)
  }

  private fun loadHeroArt(hero: HeroModel) {
    heroJob?.cancel()
    views.heroArt.setImageBitmap(null)
    views.heroArt.visibility = View.GONE

    val path = hero.artUrl ?: return
    val width = resources.displayMetrics.widthPixels
    val height = resources.getDimensionPixelSize(R.dimen.hero_h)
    heroJob = lifecycleScope.launch {
      val bitmap = PosterLoader.load(api, path, width, height)
      // O hero pode ter mudado enquanto a arte vinha.
      if (bitmap != null && heroChannel()?.number == hero.channelNumber) {
        views.heroArt.setImageBitmap(bitmap)
        views.heroArt.visibility = View.VISIBLE
      }
    }
  }

  /**
   * Vizinhos verticais do D-pad entre hero e faixas.
   *
   * Resolvidos aqui, e nao no XML, porque dependem de quais faixas existem nesta
   * sessao: sem historico nao ha "Continuar assistindo", e um `nextFocusDown`
   * fixo apontaria para uma faixa invisivel.
   */
  private fun wireRailFocus() {
    val rails = mutableListOf<Int>()
    if (views.rowLive.visibility == View.VISIBLE) rails += R.id.rail_live
    if (views.rowResume.visibility == View.VISIBLE) rails += R.id.rail_resume
    if (views.rowShelf.visibility == View.VISIBLE) rails += R.id.rail_shelf

    rails.forEachIndexed { index, id ->
      // A primeira faixa sobe para o hero; a ultima nao desce para lugar nenhum.
      val up = if (index == 0) R.id.hero_play else rails[index - 1]
      val down = if (index == rails.lastIndex) id else rails[index + 1]
      when (id) {
        R.id.rail_live -> liveRow.wireFocus(up, down)
        R.id.rail_resume -> resumeRow.wireFocus(up, down)
        R.id.rail_shelf -> shelfRow.wireFocus(up, down)
      }
    }

    // Para CIMA o XML ja resolve (hero → topbar, topbar → hero): esses vizinhos
    // nao dependem de quais faixas existem. So o caminho para baixo e que muda.
    val first = rails.firstOrNull() ?: View.NO_ID
    for (button in listOf(views.heroPlay, views.heroEpisodes, views.heroFirst)) {
      button.nextFocusDownId = first
    }

    // A nav do topo espelha quais faixas existem nesta sessao: item de faixa
    // ausente fica apagado em vez de prometer um clique para lugar nenhum.
    // Segue focavel de proposito — desabilitar quebraria a corrente de
    // nextFocus do topo — e o clique cai na faixa visivel mais proxima.
    views.topbarNavLive.alpha =
      if (views.rowLive.visibility == View.VISIBLE) 1f else NAV_DIM_ALPHA
    views.topbarNavShelf.alpha =
      if (views.rowShelf.visibility == View.VISIBLE) 1f else NAV_DIM_ALPHA
  }

  /**
   * Foco na faixa pedida ou, quando ela nao existe nesta sessao, na faixa
   * visivel mais proxima; sem faixa nenhuma, o hero. Um clique na nav nunca
   * morre num `requestFocus` de view GONE, que falha em silencio.
   */
  private fun focusRail(target: RecyclerView) {
    val ordered = listOf(
      views.rowLive to views.railLive,
      views.rowResume to views.railResume,
      views.rowShelf to views.railShelf,
    )
    val visible = ordered.filter { (row, _) -> row.visibility == View.VISIBLE }
    if (visible.isEmpty()) {
      views.heroPlay.requestFocus()
      return
    }
    val at = ordered.indexOfFirst { (_, rail) -> rail === target }
    val pick = visible.firstOrNull { (_, rail) -> rail === target }
      ?: visible.minByOrNull { pair -> abs(ordered.indexOf(pair) - at) }!!
    pick.second.requestFocus()
  }

  /** Acende o item da nav correspondente a secao onde o foco esta. */
  private fun markTopNav(focused: View) {
    val inLive = isInside(focused, views.railLive)
    val inShelf = isInside(focused, views.railShelf) || isInside(focused, views.railResume)
    views.topbarNavHome.isSelected = !inLive && !inShelf
    views.topbarNavLive.isSelected = inLive
    views.topbarNavShelf.isSelected = inShelf
  }

  private fun isInside(view: View, ancestor: View): Boolean {
    var at: View? = view
    while (at != null) {
      if (at === ancestor) return true
      at = at.parent as? View
    }
    return false
  }

  /**
   * O foco so pode pousar depois que o RecyclerView criou o card. Espera o
   * desenho, e nao um `post`: a fila de mensagens nao garante que o layout ja
   * aconteceu, e o card ainda nao existiria para receber o foco.
   */
  private fun focusShelf(channelNumber: Int?) {
    val at = shelfRow.items.indexOfFirst { it.channelNumber == channelNumber }
    if (at < 0) {
      views.heroPlay.requestFocus()
      return
    }
    views.railShelf.scrollToPosition(at)
    views.railShelf.doOnPreDraw {
      val row = views.railShelf.findViewHolderForAdapterPosition(at)?.itemView
      if (row != null) {
        row.requestFocus()
        return@doOnPreDraw
      }
      // O card ainda nao nasceu neste quadro (o layout do RecyclerView e
      // assincrono): espera mais um desenho. O invalidate garante que esse
      // desenho existe. Falhando de novo, o hero e o fallback deterministico —
      // foco perdido ao acaso e pior que foco no lugar de sempre.
      views.railShelf.invalidate()
      views.railShelf.doOnPreDraw {
        views.railShelf.findViewHolderForAdapterPosition(at)?.itemView?.requestFocus()
          ?: views.heroPlay.requestFocus()
      }
    }
  }

  private fun openSeries(card: TallCard) = openSeries(card.channelNumber)

  private fun openSeries(channelNumber: Int) {
    applyNav(reduceNav(nav, NavEvent.OpenSeries(channelNumber)))
  }

  /** Card da faixa "No ar agora": entra no canal, na grade, direto. */
  private fun enterChannel(card: WideCard) = enterLive(card.channelNumber)

  /**
   * Card da faixa "Continuar assistindo".
   *
   * Abre a SERIE, e nao o player: retomar precisa da fila inteira de episodios
   * para a maratona continuar depois deste, e a lista so existe na tela de
   * serie. La o botao primario ja nasce escrito "Continuar SxxExx".
   */
  private fun continueCard(card: WideCard) = openSeries(card.channelNumber)

  private fun enterLive(channelNumber: Int) {
    applyNav(reduceNav(nav, NavEvent.OpenPlayer(channelNumber)))
    tuner = initialTuner(channelNumber)
    lifecycleScope.launch { tune(channelNumber) }
  }

  // ------------------------------------------------------------------- serie

  private fun wireSeries() {
    episodeRows = EpisodeAdapter(lifecycleScope, api, ::playFrom)
    views.seriesEpisodes.layoutManager = LinearLayoutManager(this)
    views.seriesEpisodes.adapter = episodeRows

    seasonRows = SeasonAdapter(::pickSeason)
    views.seasonTabs.layoutManager = horizontal()
    views.seasonTabs.adapter = seasonRows

    views.seriesBack.setOnClickListener { onBackPressedDispatcher.onBackPressed() }
    views.seriesLive.setOnClickListener { watchLive() }
    views.seriesStart.setOnClickListener { playSeasonStart() }
    views.seriesResume.setOnClickListener { resumeSeries() }
  }

  private fun showSeries(channelNumber: Int) {
    val channel = channels.firstOrNull { it.number == channelNumber } ?: return

    views.seriesTitle.text = channel.name
    views.seriesChannel.text = formatChannelBadge(channel.number)
    views.seriesMeta.text =
      formatSeasonsMeta(channel.year, channel.seasons.size, channel.episodeCount)
    views.seriesOverview.text = channel.overview ?: ""
    views.seriesOverview.visibility = show(channel.overview != null)
    views.seriesInitials.text = initialsOf(channel.name)
    views.seriesResumeText.text = seriesResumeLabel(resumeFor(channelNumber))

    loadPoster(channel)
    loadBackdrop(channel)

    // Volta do player da MESMA serie, com a lista ainda na mao: nada de zerar a
    // aba nem esvaziar os episodios — a tela reabre no ponto exato de onde o
    // player saiu, com o foco na linha do episodio que tocava.
    val saved = seriesReturn?.takeIf { it.channelNumber == channelNumber }
    if (saved != null && episodesChannel == channelNumber && episodes.isNotEmpty()) {
      // Consumido: o estado vale para ESTA volta. Ficar vivo para sempre faria
      // uma visita nova, dias depois, reabrir numa aba que ja nao diz nada.
      seriesReturn = null
      seasonAt = restoreSeasonAt(seasons, saved.seasonAt, resumeSeason(channelNumber))
      renderSeasons()
      focusEpisodeRow(saved.episodeIndex)
      return
    }

    // As abas nascem de `ChannelSummary.seasons`, que ja esta na mao: esperar a
    // lista de episodios faria a barra aparecer depois, empurrando a tela.
    seasons = seasonTabs(channel.seasons, emptyList())
    seasonAt = 0
    episodes = emptyList()
    renderSeasons()
    loadEpisodes(channelNumber)

    // O foco vai para o botao primario: e o que a maioria quer, e sair dele para
    // a lista de episodios e uma seta para baixo.
    views.seriesResume.requestFocus()
  }

  /**
   * Scroll e foco na linha do episodio dado, esperando o RecyclerView criar a
   * linha (mesmo protocolo do `focusShelf`). Sem a linha na aba ativa — a
   * maratona pode ter atravessado a temporada — o botao primario e o fallback
   * deterministico: e o `series_resume`, que ja diz de onde continuar.
   */
  private fun focusEpisodeRow(episodeIndex: Int) {
    val at = episodeRows.items.indexOfFirst { it.index == episodeIndex }
    if (at < 0) {
      views.seriesResume.requestFocus()
      return
    }
    views.seriesEpisodes.scrollToPosition(at)
    views.seriesEpisodes.doOnPreDraw {
      views.seriesEpisodes.findViewHolderForAdapterPosition(at)?.itemView?.requestFocus()
        ?: views.seriesResume.requestFocus()
    }
  }

  private fun resumeFor(channelNumber: Int): ResumeEntry? =
    resume.firstOrNull { it.channelNumber == channelNumber }

  private fun loadPoster(channel: ChannelSummary) {
    posterJob?.cancel()
    showSeriesPoster(null)

    val path = channel.posterUrl ?: return
    val width = resources.getDimensionPixelSize(R.dimen.series_cover_w)
    posterJob = lifecycleScope.launch {
      val bitmap = PosterLoader.load(api, path, width)
      // A serie pode ter mudado enquanto a capa vinha: sem esta conferencia,
      // uma capa atrasada pousaria na serie errada.
      if (nav.channelNumber == channel.number) showSeriesPoster(bitmap)
    }
  }

  private fun showSeriesPoster(bitmap: Bitmap?) {
    views.seriesPoster.setImageBitmap(bitmap)
    views.seriesPoster.visibility = show(bitmap != null)
    views.seriesInitials.visibility = show(bitmap == null)
  }

  private fun loadBackdrop(channel: ChannelSummary) {
    backdropJob?.cancel()
    views.seriesBackdrop.setImageBitmap(null)
    views.seriesBackdrop.visibility = View.GONE

    val path = channel.backdropUrl ?: return
    val width = resources.displayMetrics.widthPixels
    val height = resources.getDimensionPixelSize(R.dimen.shero_h)
    backdropJob = lifecycleScope.launch {
      val bitmap = PosterLoader.load(api, path, width, height)
      if (bitmap != null && nav.channelNumber == channel.number) {
        views.seriesBackdrop.setImageBitmap(bitmap)
        views.seriesBackdrop.visibility = View.VISIBLE
      }
    }
  }

  private fun loadEpisodes(channelNumber: Int) {
    // A lista some antes da resposta chegar: um OK apressado nao pode tocar o
    // episodio da serie anterior.
    episodes = emptyList()
    episodesChannel = null
    episodeRows.items = emptyList()

    episodesJob?.cancel()
    episodesJob = lifecycleScope.launch {
      val loaded = try {
        api.episodes(channelNumber)
      } catch (error: UnauthorizedException) {
        onUnauthorized()
        return@launch
      } catch (error: IOException) {
        return@launch
      }

      if (nav.channelNumber != channelNumber) return@launch
      episodes = loaded.orEmpty()
      episodesChannel = channelNumber
      val channel = channels.firstOrNull { it.number == channelNumber }
      seasons = seasonTabs(channel?.seasons.orEmpty(), episodes)
      // A aba que abre e a da retomada: quem parou na quarta temporada nao quer
      // rolar tres abas para achar de onde continuar. Com estado salvo de uma
      // ida ao player (a lista se esvaziou no caminho), a aba salva vence.
      seasonAt = restoreSeasonAt(
        seasons,
        seriesReturn?.takeIf { it.channelNumber == channelNumber }?.seasonAt,
        resumeSeason(channelNumber),
      )
      renderSeasons()
    }
  }

  private fun resumeSeason(channelNumber: Int): Int? {
    val id = resumeFor(channelNumber)?.episode?.id ?: return null
    return episodes.firstOrNull { it.id == id }?.season
  }

  private fun pickSeason(at: Int) {
    seasonAt = at
    renderSeasons()
  }

  private fun renderSeasons() {
    seasonRows.items = seasons
    seasonRows.selected = seasonAt
    views.seasonTabs.visibility = show(seasons.isNotEmpty())

    val indices = currentSeasonIndices()
    views.seasonAside.text = seasonAside(episodes, indices)
    episodeRows.items = episodeItems(episodes, indices, progressByEpisode())
  }

  private fun currentSeasonIndices(): List<Int> =
    seasonIndices(episodes, seasons.getOrNull(seasonAt)?.season, hasTabs = seasons.isNotEmpty())

  /**
   * O que o historico sabe de cada episodio, por id.
   *
   * Vem de `GET /api/history`, e nao da faixa de retomada: aquela chega
   * deduplicada por serie e sem os episodios ja vistos, que e exatamente o
   * contrario do que esta lista precisa mostrar.
   */
  private fun progressByEpisode(): Map<String, EpisodeProgress> =
    history.mapValues { (_, row) -> EpisodeProgress(row.positionMs, row.watchedAt != null) }

  /** ASSISTIR AO VIVO: entra na grade do canal, no ponto em que ela esta agora. */
  private fun watchLive() {
    val channelNumber = nav.channelNumber ?: return
    // Ao vivo nao ha episodio a focar na volta, mas a aba aberta se preserva.
    seriesReturn = SeriesReturn(channelNumber, seasonAt, episodeIndex = -1)
    enterLive(channelNumber)
  }

  /** DO INICIO: primeiro episodio da temporada aberta. */
  private fun playSeasonStart() {
    val first = currentSeasonIndices().firstOrNull() ?: return
    playFrom(first)
  }

  /** CONTINUAR: o episodio guardado, no ponto em que ele parou. */
  private fun resumeSeries() {
    val channelNumber = nav.channelNumber ?: return
    val entry = resumeFor(channelNumber) ?: return playSeasonStart()
    val at = episodes.indexOfFirst { it.id == entry.episode.id }
    if (at < 0) return playSeasonStart()
    playFrom(at, entry.positionMs)
  }

  /** OK numa linha do catalogo: maratona a partir dali. */
  private fun playFrom(index: Int, positionMs: Long = 0L) {
    val channelNumber = nav.channelNumber ?: return
    val channel = channels.firstOrNull { it.number == channelNumber } ?: return
    if (index !in episodes.indices) return

    // Foto da tela antes de sair: e para ca que o VOLTAR do player devolve.
    seriesReturn = SeriesReturn(channelNumber, seasonAt, index)
    applyNav(reduceNav(nav, NavEvent.OpenPlayer(channelNumber)))
    // Episodio novo, contagem de "onde parei" nova.
    progress = ProgressState()
    player.playOnDemand(channel, episodes, index, positionMs)
  }

  // ----------------------------------------------------------- configuracoes

  private fun wireSettings() {
    playbackRows = SettingsAdapter(SettingsGroup.PLAYBACK)
    views.settingsPlayback.layoutManager = LinearLayoutManager(this)
    views.settingsPlayback.adapter = playbackRows

    libraryRows = SettingsAdapter(SettingsGroup.LIBRARY)
    views.settingsLibrary.layoutManager = LinearLayoutManager(this)
    views.settingsLibrary.adapter = libraryRows

    views.settingsBack.setOnClickListener { onBackPressedDispatcher.onBackPressed() }
  }

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
        onUnauthorized()
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
    // cima do `AppSettings` de verdade — nunca de um palpite. Mas as setas e o
    // OK morrem aqui mesmo assim: se caissem no `super`, o foco nativo vagaria
    // durante o carregamento e a tela acordaria com dois destaques. So o
    // VOLTAR (e as demais teclas) seguem para o `super`.
    val current = settings ?: return when (keyCode) {
      KeyEvent.KEYCODE_DPAD_UP,
      KeyEvent.KEYCODE_DPAD_DOWN,
      KeyEvent.KEYCODE_DPAD_LEFT,
      KeyEvent.KEYCODE_DPAD_RIGHT,
      KeyEvent.KEYCODE_DPAD_CENTER,
      KeyEvent.KEYCODE_ENTER,
      -> true

      else -> super.onKeyDown(keyCode, event)
    }
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
      is SettingsCommand.GenerateThumbs -> runTask { api.generateThumbs(command.reset) }
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
        onUnauthorized()
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
      SettingsField.AUTO_THUMBS -> SettingsPatch.autoThumbs(flag)
      SettingsField.SMART_GROUPING -> SettingsPatch.smartGrouping(flag)
      // Inalcancavel: o reducer so emite `Patch` para as linhas de valor.
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
        onUnauthorized()
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
    playbackRows.bind(settingsUi, settings)
    libraryRows.bind(settingsUi, settings)

    // So a lista que tem o cursor rola: mover as duas faria a de baixo saltar
    // sozinha enquanto o dedo anda na de cima.
    scrollToCursor(views.settingsPlayback, playbackRows.cursorInGroup(settingsUi))
    scrollToCursor(views.settingsLibrary, libraryRows.cursorInGroup(settingsUi))

    val message = settingsUi.message
    views.settingsMessage.text = message ?: ""
    views.settingsMessage.visibility = show(message != null)
    views.settingsMessage.setTextColor(
      getColor(if (settingsAlert) R.color.live else R.color.accent),
    )
  }

  /**
   * Traz a linha do cursor para dentro da tela.
   *
   * As duas listas sao `wrap_content` dentro de um `NestedScrollView`: elas nao
   * rolam por si, quem rola e o de fora. E a linha nao e focavel — o cursor e do
   * reducer —, entao ninguem a traz para a tela sozinho. Pedir o retangulo faz o
   * scroll de fora obedecer.
   */
  private fun scrollToCursor(list: RecyclerView, at: Int) {
    if (at < 0) return
    list.doOnPreDraw {
      val row = list.findViewHolderForAdapterPosition(at)?.itemView ?: return@doOnPreDraw
      row.requestRectangleOnScreen(Rect(0, 0, row.width, row.height), false)
    }
  }

  private fun renderStatus() {
    val status = libraryStatus

    // Um cartao so para as duas tarefas que medem progresso: qual delas ele
    // mostra e decisao do reducer, nao daqui.
    val card = status?.let { taskCard(it) }
    views.scanState.text = card?.text ?: ""
    views.scanState.visibility = show(card != null)

    val percent = card?.percent
    views.settingsProgress.visibility = show(percent != null)
    if (percent != null) views.settingsProgress.progress = percent

    val pct = card?.percentText
    views.scanPct.text = pct ?: ""
    views.scanPct.visibility = show(pct != null)

    // O cartao inteiro so existe enquanto ha tarefa: um bloco vazio dizendo
    // "Varredura em andamento" com a barra parada seria pior que nenhum bloco.
    views.scanCard.visibility = show(card != null)

    val summary = status?.let { scanSummaryText(it) }
    views.settingsScanSummary.text = summary ?: ""
    views.settingsScanSummary.visibility = show(summary != null)

    val metadata = status?.let { metadataText(it) }
    views.settingsMetadata.text = metadata ?: ""
    views.settingsMetadata.visibility = show(metadata != null)
  }

  // ------------------------------------------------------------------ player

  private fun wirePlayer() {
    trackRows = TrackAdapter()
    views.trackList.layoutManager = LinearLayoutManager(this)
    views.trackList.adapter = trackRows

    views.playToggle.setOnClickListener { togglePause() }
    views.seekBack.setOnClickListener { seek(-SEEK_MS) }
    views.seekFwd.setOnClickListener { seek(SEEK_MS) }
    views.tracksOpen.setOnClickListener { openPanel() }
    views.actionEpisodes.setOnClickListener { openEpisodesFromPlayer() }
    views.actionPrev.setOnClickListener { skipEpisode(forward = false) }
    views.actionNext.setOnClickListener { skipEpisode(forward = true) }
    views.actionWatched.setOnClickListener { toggleWatched() }
    views.actionMute.setOnClickListener { toggleMute() }
    views.tracksClose.setOnClickListener {
      applyPanel(reduceTrackPanel(panel, TrackPanelEvent.Close))
    }
    views.tabAudio.setOnClickListener {
      applyPanel(reduceTrackPanel(panel, TrackPanelEvent.Tab(TrackKind.AUDIO)))
    }
    views.tabSubs.setOnClickListener {
      applyPanel(reduceTrackPanel(panel, TrackPanelEvent.Tab(TrackKind.TEXT)))
    }
  }

  private fun openPlayer() {
    views.root.requestFocus()
    // Alvo de scrub de uma sessao anterior nao pode vazar para esta.
    scrub = initialScrub(0L)
    // Nem o cursor da fileira: a visita comeca com o video mandando nas setas.
    controls = PlayerControlsState()
    startTicker()
    poke()
  }

  private suspend fun tune(channelNumber: Int) {
    val ok = try {
      player.tune(channelNumber)
    } catch (error: UnauthorizedException) {
      onUnauthorized()
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

    // VOLTAR nunca reacende o overlay que ele proprio vai esconder: segue
    // direto para o dispatcher, sem passar pelo poke().
    if (keyCode == KeyEvent.KEYCODE_BACK) return super.onKeyDown(keyCode, event)

    // Qualquer tecla traz o overlay de volta. E o mesmo relogio do OSD: um
    // segundo timer daria duas contagens diferentes para a mesma inatividade.
    poke()

    val live = player.mode == ChannelPlayer.PlaybackMode.LIVE

    // O D-PAD e o OK passam INTEIROS pelo `PlayerControls`. Antes daqui cada
    // tecla decidia sozinha o que fazer, e o resultado era um painel de audio
    // preso no MENU: uma tecla que a maioria dos controles nao tem. Agora quem
    // sabe o que a seta faz e o reducer, que conhece o cursor.
    controlEventOf(keyCode)?.let { controlEvent ->
      applyControls(reducePlayerControls(controls, controlEvent), event.repeatCount)
      return true
    }

    when (keyCode) {
      // MENU segue abrindo o painel para quem TEM a tecla. Nao e mais o unico
      // caminho — e por isso deixou de ser um problema.
      KeyEvent.KEYCODE_MENU -> {
        openPanel()
        return true
      }

      KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
      KeyEvent.KEYCODE_MEDIA_PAUSE,
      KeyEvent.KEYCODE_MEDIA_PLAY,
      -> {
        // A grade nao tem pausa. A tecla morre aqui mesmo assim: deixar o
        // sistema fazer alguma coisa com ela seria pior do que nao fazer nada.
        if (!live) togglePause()
        return true
      }

      KeyEvent.KEYCODE_MUTE, KeyEvent.KEYCODE_VOLUME_MUTE -> {
        toggleMute()
        return true
      }

      KeyEvent.KEYCODE_CHANNEL_UP -> return step(1, event.repeatCount)

      KeyEvent.KEYCODE_CHANNEL_DOWN -> return step(-1, event.repeatCount)

      KeyEvent.KEYCODE_MEDIA_REWIND -> {
        if (!live) return scrubBy(-1, event.repeatCount)
        showOsd(formatScrubNote(live = true, remainingMs = 0L))
        return true
      }

      KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> {
        if (!live) return scrubBy(1, event.repeatCount)
        showOsd(formatScrubNote(live = true, remainingMs = 0L))
        return true
      }

      KeyEvent.KEYCODE_MEDIA_NEXT, KeyEvent.KEYCODE_MEDIA_SKIP_FORWARD -> {
        // Ao vivo "proximo" e o proximo CANAL, como no zap. Sob demanda e o
        // proximo episodio da fila, que o playOnDemand enfileirou inteira.
        if (live) return step(1, 0)
        skipEpisode(forward = true)
        return true
      }

      KeyEvent.KEYCODE_MEDIA_PREVIOUS, KeyEvent.KEYCODE_MEDIA_SKIP_BACKWARD -> {
        if (live) return step(-1, 0)
        skipEpisode(forward = false)
        return true
      }

      KeyEvent.KEYCODE_MEDIA_STOP -> {
        // Parar e sair do player: a navegacao ja sabe para quem o abriu.
        applyNav(reduceNav(nav, NavEvent.Back(now())))
        return true
      }
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

  /** As cinco teclas que o controle da sala tem de verdade. O resto e extra. */
  private fun controlEventOf(keyCode: Int): PlayerControlsEvent? = when (keyCode) {
    KeyEvent.KEYCODE_DPAD_UP -> PlayerControlsEvent.Up
    KeyEvent.KEYCODE_DPAD_DOWN -> PlayerControlsEvent.Down
    KeyEvent.KEYCODE_DPAD_LEFT -> PlayerControlsEvent.Left
    KeyEvent.KEYCODE_DPAD_RIGHT -> PlayerControlsEvent.Right
    KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER -> PlayerControlsEvent.Ok
    else -> null
  }

  /**
   * Executa o que o reducer decidiu.
   *
   * @param repeatCount da tecla presa; so o zap e o salto o usam, porque so eles
   *   tem escada de passo (`Tuner` e `Scrub`). Andar na fileira com a tecla
   *   presa anda de um em um, que e o certo para um menu de cinco botoes.
   */
  private fun applyControls(result: PlayerControlsResult, repeatCount: Int = 0) {
    controls = result.state
    when (val action = result.action) {
      null -> Unit
      ControlAction.TogglePause -> togglePause()
      is ControlAction.Seek -> scrubBy(action.delta, repeatCount)
      ControlAction.ZapUp -> step(1, repeatCount)
      ControlAction.ZapDown -> step(-1, repeatCount)
      ControlAction.OpenTracks -> openPanel()
      ControlAction.OpenEpisodes -> openEpisodesFromPlayer()
      ControlAction.PrevEpisode -> skipEpisode(forward = false)
      ControlAction.NextEpisode -> skipEpisode(forward = true)
      ControlAction.ToggleMute -> toggleMute()
      ControlAction.ToggleWatched -> toggleWatched()
      // Sobrou so a seta lateral ao vivo com o cursor desligado, e o reducer ja
      // a transforma em entrada na fileira. Mantido pelo `when` exaustivo.
      ControlAction.LiveSeekRefused -> showOsd(formatScrubNote(live = true, remainingMs = 0L))
    }
    // `poke` ja redesenha. O cursor aceso segura o overlay na tela: reagendar o
    // timer depois de cada tecla e o que impede o menu de apagar debaixo do dedo.
    poke(sticky = railSticky(controls))
  }

  private fun toggleMute() {
    player.volume = if (player.volume > 0f) 0f else 1f
    renderOverlay()
  }

  /**
   * Botao "Episodios" da fileira: sai do player para a tela da serie que esta
   * tocando. Ao vivo isso e o canal sintonizado agora, e nao o que abriu o
   * player — e a mesma regra que o VOLTAR ja segue (`NavState.channelNumber`).
   */
  private fun openEpisodesFromPlayer() {
    val channelNumber = nav.channelNumber ?: return
    applyNav(reduceNav(nav, NavEvent.OpenSeries(channelNumber)))
  }

  private fun togglePause(): Boolean {
    player.togglePause()
    // Pausar e um bom momento para gravar: quem pausa costuma sair logo depois,
    // e ali o proximo tique pode nunca chegar.
    reportProgress(forced = true)
    renderOverlay()
    return true
  }

  /**
   * Grava onde o episodio parou.
   *
   * A DECISAO e do `decideProgress`; aqui so ha a leitura do player e a chamada
   * de rede, que nao pode derrubar nada — `saveProgress` engole falha de rede de
   * proposito, e a proxima gravacao conserta o atraso sozinha.
   *
   * @param forced momento em que perder a posicao seria irreversivel: pausa,
   *   troca de episodio, saida do player, app indo para segundo plano.
   */
  private fun reportProgress(forced: Boolean = false) {
    val episode = player.currentEpisode ?: return
    val durationMs = player.exo.duration.coerceAtLeast(0L)
    val decision = decideProgress(
      progress,
      ProgressSnapshot(
        live = player.mode == ChannelPlayer.PlaybackMode.LIVE,
        positionMs = player.exo.currentPosition.coerceAtLeast(0L),
        durationMs = durationMs,
      ),
      now(),
      forced,
    )
    progress = decision.state
    if (!decision.send) return
    sendProgress(episode.id, decision.state.lastPositionMs, durationMs)
  }

  private fun sendProgress(episodeId: String, positionMs: Long, durationMs: Long) {
    lifecycleScope.launch { api.saveProgress(episodeId, positionMs, durationMs) }
  }

  /** Salto imediato dos botoes do overlay: clique nao repete, nao precisa de reducer. */
  private fun seek(deltaMs: Long): Boolean {
    player.seekBy(deltaMs)
    renderOverlay()
    return true
  }

  /**
   * Setas laterais sob demanda passam pelo reducer de scrub, como o zap passa
   * pelo sintonizador: a tecla presa so move um alvo na barra, e o seek de
   * verdade sai UMA vez, pelo tick, quando a mao solta.
   */
  private fun scrubBy(delta: Int, repeatCount: Int): Boolean {
    // Gesto novo parte de onde o video esta agora; no meio de um gesto o
    // reducer ja sabe de onde continuar.
    if (scrub.targetMs == null) {
      scrub = initialScrub(player.exo.currentPosition.coerceAtLeast(0L))
    }
    applyScrub(reduceScrub(scrub, ScrubEvent.Step(delta, repeatCount, now()), scrubDurationMs()))
    return true
  }

  private fun scrubDurationMs(): Long = player.exo.duration.coerceAtLeast(0L)

  private fun applyScrub(result: ScrubResult) {
    scrub = result.state
    result.seekTo?.let { player.seekTo(it) }
    // Preview e commit redesenham a barra: enquanto o gesto dura, o relogio do
    // overlay mostra o alvo (renderOverlay le `scrub.targetMs`).
    if (result.seekTo != null || result.preview != null) renderOverlay()
  }

  /**
   * Pula para o episodio vizinho da fila sob demanda. So VOD: ao vivo a fila do
   * ExoPlayer pode nem ter o `next` ainda — ele so entra depois do probe
   * confirmar que o stream existe — e "proximo" significa outro canal.
   */
  private fun skipEpisode(forward: Boolean) {
    // Grava a posicao do episodio que esta SAINDO, antes de a fila andar.
    reportProgress(forced = true)
    // O alvo de scrub pendente era do episodio antigo: um commit atrasado nao
    // pode cair no meio do episodio novo.
    scrub = initialScrub(0L)
    if (forward) player.exo.seekToNextMediaItem() else player.exo.seekToPreviousMediaItem()
    renderOverlay()
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

  /**
   * Um relogio so para o OSD e para o overlay.
   *
   * Os dois somem juntos depois da mesma inatividade porque sao a mesma coisa
   * para quem esta olhando: informacao por cima do video. Dois timers dariam
   * duas contagens e um piscaria antes do outro.
   */
  private fun poke(sticky: Boolean = false) {
    views.overlay.visibility = View.VISIBLE
    renderOverlay()
    osdHide?.cancel()
    // Com o cursor na fileira de acoes o overlay fica: quem esta escolhendo
    // alguma coisa nao pode ver o menu apagar debaixo do dedo aos 3 s.
    if (sticky) return
    osdHide = lifecycleScope.launch {
      delay(OSD_HOLD_MS)
      // Sem `cancel` aqui: quem esconde por tempo E o timer, e mandar o timer
      // cancelar a si mesmo no meio do proprio corpo e uma armadilha.
      applyOverlayHidden()
    }
  }

  /**
   * Esconde overlay e OSD agora, sem esperar o timer: e o VOLTAR agindo como
   * camada. O timer morre junto para nao apagar de novo o que ja esta apagado.
   */
  private fun hideOverlayNow() {
    osdHide?.cancel()
    applyOverlayHidden()
  }

  /** O que sobra na tela quando o overlay sai — pelo timer ou pelo VOLTAR. */
  private fun applyOverlayHidden() {
    views.overlay.visibility = View.GONE
    views.osd.visibility = View.GONE
    // O cursor nao sobrevive ao overlay: reaparecer com um botao ja aceso faria
    // o proximo OK disparar o que ninguem escolheu nesta visita.
    controls = reducePlayerControls(controls, PlayerControlsEvent.Hide).state
    // O overlay tem botoes focaveis. Sumindo com o foco dentro deles, a proxima
    // tecla nao teria onde chegar: a raiz e para onde ele volta.
    views.root.requestFocus()
  }

  private fun showOsd(text: String, sticky: Boolean = false) {
    views.osd.text = text
    views.osd.visibility = View.VISIBLE
    poke(sticky)
  }

  private fun renderOverlay() {
    val live = player.mode == ChannelPlayer.PlaybackMode.LIVE
    val exo = player.exo

    views.liveBadge.visibility = show(live)
    val channelNumber = nav.channelNumber
    views.channelBadge.text = channelNumber?.let { formatChannelBadge(it) } ?: ""
    views.channelBadge.visibility = show(channelNumber != null)

    views.overlayShow.text = player.currentChannelName ?: ""
    views.overlayTitle.text = player.currentEpisode?.let { formatEpisodeSub(it) } ?: ""

    // "A seguir" ao vivo vem da grade, com hora marcada; sob demanda vem do
    // proximo da fila, e nao ha hora nenhuma a prometer.
    val next = player.nextEpisode
    views.upnext.visibility = show(next != null)
    views.upnextTitle.text = next?.let { formatEpisodeSub(it) } ?: ""
    val endsAtMs = player.nowPlaying?.endsAtMs
    views.upnextTime.text = if (live && endsAtMs != null) formatUpNextTime(endsAtMs, now()) else ""
    views.upnextTime.visibility = show(live && endsAtMs != null)

    // Durante o scrub a barra e o relogio mostram o ALVO do reducer, nao a
    // posicao real: e o preview andando antes de o seek acontecer.
    val position = scrub.targetMs ?: exo.currentPosition.coerceAtLeast(0L)
    val duration = exo.duration.coerceAtLeast(0L)
    views.scrubBar.progress = barProgress(position, duration)
    views.scrubLeft.text = formatScrubLeft(position)
    views.scrubRight.text = formatClock(duration)
    views.scrubNote.text = formatScrubNote(live, duration - position)

    // Ao vivo os controles de transporte nao existem: a posicao pertence a
    // grade, e um botao de pausa aceso seria uma promessa que o player recusa.
    // Some de verdade (GONE) e nao so apagado, senao o foco pousaria neles.
    views.playToggle.visibility = show(!live)
    views.seekBack.visibility = show(!live)
    views.seekFwd.visibility = show(!live)
    views.playToggle.isSelected = player.isPlaying

    renderRail(live)
    renderVolume()
    views.overlayHint.text = playerHint(controls)
  }

  /**
   * Fileira de acoes: quais botoes existem neste modo e onde esta o cursor.
   *
   * O estado do reducer e reconciliado com o mundo AQUI, num `Sync`, porque o
   * mundo muda sem passar por tecla nenhuma — o episodio vira sozinho no fim do
   * arquivo, e com ele mudam "anterior" e "proximo".
   */
  private fun renderRail(live: Boolean) {
    val exo = player.exo
    controls = reducePlayerControls(
      controls,
      PlayerControlsEvent.Sync(
        live = live,
        muted = player.volume <= 0f,
        watched = isWatched(player.currentEpisode?.id),
        hasPrev = !live && exo.hasPreviousMediaItem(),
        hasNext = !live && exo.hasNextMediaItem(),
      ),
    ).state

    val rail = controlRail(controls)
    val buttons = mapOf(
      ControlId.TRACKS to views.tracksOpen,
      ControlId.EPISODES to views.actionEpisodes,
      ControlId.PREV to views.actionPrev,
      ControlId.NEXT to views.actionNext,
      ControlId.WATCHED to views.actionWatched,
      ControlId.MUTE to views.actionMute,
    )
    for ((id, button) in buttons) {
      val at = rail.indexOf(id)
      button.visibility = show(at >= 0)
      // Cursor por `isActivated`, e nao por foco: os botoes do overlay nao sao
      // focaveis, senao o foco nativo brigaria com o reducer pelas mesmas setas.
      button.isActivated = at >= 0 && at == controls.cursor
    }

    views.actionMute.text = getString(
      if (controls.muted) R.string.player_action_unmute else R.string.player_action_mute,
    )
    // O rotulo diz o ESTADO, e nao a acao: "Já vi" aceso ao lado de um episodio
    // ja marcado seria a unica forma de saber que ele esta marcado.
    views.actionWatched.text = getString(
      if (controls.watched) R.string.player_action_unwatched else R.string.player_action_watched,
    )
  }

  private fun isWatched(episodeId: String?): Boolean =
    episodeId != null && history[episodeId]?.watchedAt != null

  /**
   * "Ja vi" / "Nao vi" do episodio no ar.
   *
   * O espelho local muda ANTES da resposta: a fileira esta aberta na tela e um
   * rotulo que so vira depois do round-trip pareceria botao que nao funciona. A
   * releitura do historico depois confirma (ou desfaz) o palpite.
   */
  private fun toggleWatched() {
    val episode = player.currentEpisode ?: return
    val target = !isWatched(episode.id)

    // A partir daqui a gravacao automatica cala para este episodio: o tique de
    // 10 s mandaria uma posicao no meio do arquivo e o servidor desmarcaria o
    // que a pessoa acabou de marcar. O proximo episodio zera o freio.
    progress = progress.copy(manual = true)

    val previous = history
    history = history.toMutableMap().apply {
      val row = previous[episode.id]
      this[episode.id] = WatchProgress(
        episodeId = episode.id,
        positionMs = if (target) 0L else row?.positionMs ?: 0L,
        durationMs = row?.durationMs ?: episode.durationMs,
        updatedAt = now(),
        watchedAt = if (target) now() else null,
      )
    }
    showOsd(
      getString(
        if (target) R.string.player_marked_watched else R.string.player_marked_unwatched,
      ),
    )

    lifecycleScope.launch {
      if (api.setWatched(episode.id, target)) {
        history = runCatching { api.history() }.getOrDefault(emptyList())
          .associateBy { it.episodeId }
      } else {
        history = previous
      }
      renderOverlay()
    }
  }

  /**
   * Preenchimento do volume: largura, e nao escala.
   *
   * O trilho e uma `View` dentro de outra, e mexer na largura evita o borrao que
   * um `scaleX` deixaria numa barra de 3dp de altura.
   */
  private fun renderVolume() {
    val track = views.volume.width
    // Antes do primeiro layout nao ha trilho para dividir; o proximo tique
    // redesenha com a medida certa.
    if (track <= 0) return
    val params = views.volumeFill.layoutParams
    params.width = (track * player.volume).toInt().coerceIn(0, track)
    views.volumeFill.layoutParams = params
  }

  /**
   * O commit por tempo do sintonizador precisa de um pulso externo: o reducer e
   * puro justamente para nao ter timer proprio. O mesmo pulso redesenha o
   * overlay enquanto ele esta na tela.
   */
  private fun startTicker() {
    if (ticker != null) return
    ticker = lifecycleScope.launch {
      while (isActive) {
        delay(TICK_MS)
        if (views.overlay.visibility == View.VISIBLE) renderOverlay()
        // Onde parei. O `decideProgress` e que segura a cadencia; aqui so ha o
        // pulso, o mesmo que ja move o sintonizador e o scrub.
        reportProgress()
        // O commit atrasado do scrub sai do MESMO pulso do sintonizador: um
        // segundo timer daria duas contagens para a mesma ociosidade.
        if (scrub.targetMs != null) {
          applyScrub(reduceScrub(scrub, ScrubEvent.Tick(now()), scrubDurationMs()))
        }
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
    // Abrir um painel vazio nao ajuda; sumir em silencio, menos ainda — quem
    // apertou fica sem saber se o comando chegou. O OSD diz o que houve.
    if (audio.isEmpty() && text.isEmpty()) {
      showOsd(getString(R.string.player_no_tracks))
      return
    }

    applyPanel(
      reduceTrackPanel(
        panel,
        TrackPanelEvent.Open(
          audio,
          text,
          getString(R.string.tracks_off),
          remember = rememberTrack,
        ),
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
    val isDefault = (format.selectionFlags and C.SELECTION_FLAG_DEFAULT) != 0
    return TrackOption(
      id = index.toString(),
      label = if (isForced) getString(R.string.tracks_forced, name) else name,
      selected = group.isSelected,
      detail = formatTrackDetail(format.sampleMimeType, channelsOf(format), index),
      // A etiqueta diz o que o CONTAINER marcou como padrao. E o unico jeito de
      // distinguir duas dublagens do mesmo idioma antes de ouvir as duas.
      tag = if (isDefault) "padrão" else null,
    )
  }

  private fun channelsOf(format: Format): Int =
    if (format.channelCount == Format.NO_VALUE) 0 else format.channelCount

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
      // As setas laterais trocam de aba, que e a unica outra dimensao que o
      // painel tem: nao ha o que editar dentro de uma linha de trilha.
      KeyEvent.KEYCODE_DPAD_LEFT ->
        applyPanel(reduceTrackPanel(panel, TrackPanelEvent.Tab(TrackKind.AUDIO)))

      KeyEvent.KEYCODE_DPAD_RIGHT ->
        applyPanel(reduceTrackPanel(panel, TrackPanelEvent.Tab(TrackKind.TEXT)))

      KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER ->
        applyPanel(reduceTrackPanel(panel, TrackPanelEvent.Select))

      // "Lembrar este idioma" e a ultima linha da lista, alcancavel pela seta:
      // o OK nela alterna via reducer. MENU continua como atalho para os
      // controles que ainda tem a tecla.
      KeyEvent.KEYCODE_MENU -> toggleRemember()

      else -> return super.onKeyDown(keyCode, event)
    }
    return true
  }

  /** Atalho de MENU: mesmo efeito do OK na linha de lembrar, sem mover o cursor. */
  private fun toggleRemember() {
    rememberTrack = !rememberTrack
    if (panel.open) {
      panel = panel.copy(remember = rememberTrack)
      trackRows.rows = rows(panel)
    }
    renderPanelFooter()
  }

  private fun renderPanelFooter() {
    views.panelNote.text = panelNote(rememberTrack)
  }

  private fun applyPanel(result: TrackPanelResult) {
    panel = result.state
    // O OK caiu na linha de lembrar: o reducer ja alternou, a Activity so copia
    // — `rememberTrack` sobrevive ao painel fechado e decide o pushPreference.
    if (result.toggleRemember) rememberTrack = panel.remember

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

    val tab = activeTab(panel)
    views.tabAudio.isSelected = tab == TrackKind.AUDIO
    views.tabSubs.isSelected = tab == TrackKind.TEXT
    views.tracksSub.text = player.currentEpisode?.let { formatEpisodeSub(it) } ?: ""
    renderPanelFooter()

    views.tracks.visibility = View.VISIBLE
    views.tracksVeil.visibility = View.VISIBLE
    views.osd.visibility = View.GONE
    views.overlay.visibility = View.GONE
    // Dono unico de foco tambem com o painel aberto: o cursor e do reducer, e
    // as teclas precisam continuar chegando na raiz — espelho do closePanel().
    views.root.requestFocus()
  }

  private fun closePanel() {
    panel = TrackPanelState()
    views.tracks.visibility = View.GONE
    views.tracksVeil.visibility = View.GONE
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
   * Com "Lembrar este idioma" DESLIGADO nao sai request nenhum: a escolha ja
   * valeu no player e no `Store` desta sessao, e gravar mesmo assim seria fazer
   * exatamente o que o interruptor diz que nao acontece.
   *
   * Ligado, a preferencia e da casa inteira, e nao so desta TV. Falhar aqui nao
   * pode atrapalhar quem esta assistindo — o `Store` ja guardou a escolha e o
   * player ja obedeceu —, por isso o erro morre em silencio.
   *
   * A resposta NAO volta para `player.prefs`: reaplica-la chamaria `applyPrefs`,
   * que limpa os overrides, e a faixa exata que acabou de ser fixada morreria
   * no meio da cena.
   */
  private fun pushPreference(body: JsonObject) {
    if (!rememberTrack) return
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

    override fun onPreparing() {
      // O servidor esta gerando o remux do episodio (202). O player espera e
      // segue sozinho; aqui e so para a tela preta ter uma explicacao.
      showOsd(getString(R.string.preparing_stream))
    }

    override fun onError(error: Throwable) {
      if (error is UnauthorizedException) {
        lifecycleScope.launch { onUnauthorized() }
      } else {
        Log.w(TAG, "erro no player", error)
      }
    }

    override fun onVodEpisode(channel: ChannelSummary, episode: EpisodeRef) {
      // A maratona andou: o VOLTAR devolve a serie na linha do episodio que
      // TOCAVA, nao na do que apertou OK meia temporada atras.
      seriesReturn?.takeIf { it.channelNumber == channel.number }?.let { saved ->
        val at = episodes.indexOfFirst { it.id == episode.id }
        if (at >= 0) seriesReturn = saved.copy(episodeIndex = at)
      }
      // Episodio novo, contagem nova: o `lastPositionMs` do anterior nao pode
      // calar a primeira gravacao deste.
      progress = ProgressState()
      showOsd(formatNowLine(channel, episode))
    }

    override fun onVodEpisodeFinished(episode: EpisodeRef, positionMs: Long) {
      // A fila emendou sozinha. Este e o UNICO ponto em que a posicao final do
      // episodio que acabou ainda existe — depois da transicao o player ja conta
      // do zero, e sem esta gravacao o episodio jamais seria marcado como visto.
      sendProgress(episode.id, positionMs, episode.durationMs)
      progress = ProgressState()
    }

    override fun onVodEnded() {
      // Ultimo da fila: nao ha transicao para o `onVodEpisodeFinished` pegar, e
      // a posicao ainda esta no fim do arquivo. Grava antes de sair.
      reportProgress(forced = true)
      // A maratona acabou. Volta para a serie, que e de onde ela saiu — tela
      // preta com o app aberto nao e um lugar onde deixar alguem.
      applyNav(reduceNav(nav, NavEvent.Back(now())))
    }
  }

  private companion object {
    const val TAG = "WideTv"

    /** Chave do snapshot de navegacao no `Bundle` da Activity. */
    const val KEY_NAV = "nav"
    const val OSD_HOLD_MS = 3_000L
    const val SEEK_MS = 10_000L

    /** Fino o suficiente para o commit de 250ms do passo nao parecer travado. */
    const val TICK_MS = 100L

    /** Item da nav do topo cuja faixa nao existe nesta sessao: apagado, nao sumido. */
    const val NAV_DIM_ALPHA = 0.4f

    /**
     * Um scan mede milhares de arquivos: a contagem anda devagar e perguntar
     * mais que isso so gastaria rede para redesenhar o mesmo numero.
     */
    const val STATUS_POLL_MS = 2_000L
  }
}
