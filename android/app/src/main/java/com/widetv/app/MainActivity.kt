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
import com.widetv.app.ui.HeroModel
import com.widetv.app.ui.NavEvent
import com.widetv.app.ui.NavResult
import com.widetv.app.ui.NavState
import com.widetv.app.ui.PosterAdapter
import com.widetv.app.ui.PosterLoader
import com.widetv.app.ui.ScreenId
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
import com.widetv.app.ui.WideCardAdapter
import com.widetv.app.ui.activeTab
import com.widetv.app.ui.applySettingsValue
import com.widetv.app.ui.barProgress
import com.widetv.app.ui.canonicalLang
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
import com.widetv.app.ui.initialsOf
import com.widetv.app.ui.languageLabel
import com.widetv.app.ui.libraryBusy
import com.widetv.app.ui.liveRail
import com.widetv.app.ui.metadataText
import com.widetv.app.ui.panelNote
import com.widetv.app.ui.playerHint
import com.widetv.app.ui.reduceNav
import com.widetv.app.ui.reduceSettings
import com.widetv.app.ui.reduceTrackPanel
import com.widetv.app.ui.resumeRail
import com.widetv.app.ui.rows
import com.widetv.app.ui.scanSummaryText
import com.widetv.app.ui.seasonAside
import com.widetv.app.ui.seasonIndices
import com.widetv.app.ui.seasonTabs
import com.widetv.app.ui.seriesResumeLabel
import com.widetv.app.ui.shelfRail
import com.widetv.app.ui.taskCard
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

  /** Texto da busca da topbar. Filtra so a faixa do acervo, sem rede. */
  private var query: String = ""

  private var nav = NavState()
  private var tuner: TunerState = initialTuner(0)
  private var panel = TrackPanelState()

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
      ScreenId.PLAYER -> openPlayer()
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
    views.topbarNavLive.setOnClickListener { views.railLive.requestFocus() }
    views.topbarNavShelf.setOnClickListener { views.railShelf.requestFocus() }

    views.topbarSearchInput.addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
      override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
      override fun afterTextChanged(s: Editable?) {
        query = s?.toString().orEmpty()
        renderShelf()
      }
    })

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
        applyNav(reduceNav(nav, NavEvent.SessionLost))
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
        return@launch
      }
      renderHero()
      focusShelf(focusOn)
      loadRails()
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
      views.railShelf.findViewHolderForAdapterPosition(at)?.itemView?.requestFocus()
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

    // As abas nascem de `ChannelSummary.seasons`, que ja esta na mao: esperar a
    // lista de episodios faria a barra aparecer depois, empurrando a tela.
    seasons = seasonTabs(channel.seasons, emptyList())
    seasonAt = 0
    episodes = emptyList()
    renderSeasons()

    loadPoster(channel)
    loadBackdrop(channel)
    loadEpisodes(channelNumber)

    // O foco vai para o botao primario: e o que a maioria quer, e sair dele para
    // a lista de episodios e uma seta para baixo.
    views.seriesResume.requestFocus()
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
      val channel = channels.firstOrNull { it.number == channelNumber }
      seasons = seasonTabs(channel?.seasons.orEmpty(), episodes)
      // A aba que abre e a da retomada: quem parou na quarta temporada nao quer
      // rolar tres abas para achar de onde continuar.
      seasonAt = seasons.indexOfFirst { it.season == resumeSeason(channelNumber) }
        .coerceAtLeast(0)
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
   * Onde cada episodio parou, por id.
   *
   * Vem de `GET /api/history/resume`, que so guarda a ultima parada de cada
   * canal: na pratica uma linha por serie ganha estado, e o resto da lista fica
   * limpa. E o que o servidor sabe.
   */
  private fun progressByEpisode(): Map<String, Long> =
    resume.associate { it.episode.id to it.positionMs }

  /** ASSISTIR AO VIVO: entra na grade do canal, no ponto em que ela esta agora. */
  private fun watchLive() {
    val channelNumber = nav.channelNumber ?: return
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

    applyNav(reduceNav(nav, NavEvent.OpenPlayer(channelNumber)))
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

    // Tela cheia nao faz sentido numa TV: o app JA ocupa o painel inteiro, e um
    // botao que nao muda nada e um botao que mente.
    views.fullscreen.visibility = View.GONE

    views.playToggle.setOnClickListener { togglePause() }
    views.seekBack.setOnClickListener { seek(-SEEK_MS) }
    views.seekFwd.setOnClickListener { seek(SEEK_MS) }
    views.tracksOpen.setOnClickListener { openPanel() }
    views.tracksClose.setOnClickListener {
      applyPanel(reduceTrackPanel(panel, TrackPanelEvent.Close))
    }
    views.tabAudio.setOnClickListener {
      applyPanel(reduceTrackPanel(panel, TrackPanelEvent.Tab(TrackKind.AUDIO)))
    }
    views.tabSubs.setOnClickListener {
      applyPanel(reduceTrackPanel(panel, TrackPanelEvent.Tab(TrackKind.TEXT)))
    }
    views.trackRemember.setOnClickListener { toggleRemember() }
  }

  private fun openPlayer() {
    views.root.requestFocus()
    views.overlayHint.text = playerHint(player.mode == ChannelPlayer.PlaybackMode.LIVE)
    startTicker()
    poke()
  }

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

    // Qualquer tecla traz o overlay de volta. E o mesmo relogio do OSD: um
    // segundo timer daria duas contagens diferentes para a mesma inatividade.
    poke()

    val live = player.mode == ChannelPlayer.PlaybackMode.LIVE

    when (keyCode) {
      KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER -> {
        // Ao vivo nao ha pausa: o OK abre o painel, que e a unica coisa que a
        // grade deixa escolher. Sob demanda ele pausa, como em qualquer player.
        if (live) openPanel() else togglePause()
        return true
      }

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
        player.volume = if (player.volume > 0f) 0f else 1f
        renderOverlay()
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

  private fun togglePause(): Boolean {
    player.togglePause()
    renderOverlay()
    return true
  }

  private fun seek(deltaMs: Long): Boolean {
    player.seekBy(deltaMs)
    renderOverlay()
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
    if (sticky) return
    osdHide = lifecycleScope.launch {
      delay(OSD_HOLD_MS)
      views.overlay.visibility = View.GONE
      views.osd.visibility = View.GONE
      // O overlay tem botoes focaveis. Sumindo com o foco dentro deles, a
      // proxima tecla nao teria onde chegar: a raiz e para onde ele volta.
      views.root.requestFocus()
    }
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

    val position = exo.currentPosition.coerceAtLeast(0L)
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

    renderVolume()
    views.overlayHint.text = playerHint(live)
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

      // O interruptor de "lembrar" nao entra no cursor: ele nao e uma escolha de
      // faixa, e enfia-lo na lista faria a seta parar num lugar que nao toca
      // nada. MENU e a tecla que ja abriu este painel.
      KeyEvent.KEYCODE_MENU -> toggleRemember()

      else -> return super.onKeyDown(keyCode, event)
    }
    return true
  }

  private fun toggleRemember() {
    rememberTrack = !rememberTrack
    renderPanelFooter()
  }

  private fun renderPanelFooter() {
    views.trackRememberSwitch.isChecked = rememberTrack
    views.panelNote.text = panelNote(rememberTrack)
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

    val tab = activeTab(panel)
    views.tabAudio.isSelected = tab == TrackKind.AUDIO
    views.tabSubs.isSelected = tab == TrackKind.TEXT
    views.tracksSub.text = player.currentEpisode?.let { formatEpisodeSub(it) } ?: ""
    renderPanelFooter()

    views.tracks.visibility = View.VISIBLE
    views.tracksVeil.visibility = View.VISIBLE
    views.osd.visibility = View.GONE
    views.overlay.visibility = View.GONE
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
      views.overlayHint.text = playerHint(live = true)
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
      views.overlayHint.text = playerHint(live = false)
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

    /** Fino o suficiente para o commit de 250ms do passo nao parecer travado. */
    const val TICK_MS = 100L

    /**
     * Um scan mede milhares de arquivos: a contagem anda devagar e perguntar
     * mais que isso so gastaria rede para redesenhar o mesmo numero.
     */
    const val STATUS_POLL_MS = 2_000L
  }
}
