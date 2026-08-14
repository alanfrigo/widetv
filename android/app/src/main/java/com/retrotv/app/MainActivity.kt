package com.retrotv.app

import android.content.Context
import android.media.AudioManager
import android.os.Bundle
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import androidx.activity.addCallback
import androidx.annotation.OptIn
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.doOnPreDraw
import androidx.media3.common.util.UnstableApi
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import com.retrotv.app.databinding.ActivityMainBinding
import com.retrotv.app.databinding.CrtRowBinding
import com.retrotv.app.net.ApiClient
import com.retrotv.app.net.BadServerUrlException
import com.retrotv.app.net.ChannelSummary
import com.retrotv.app.net.DisplayMode
import com.retrotv.app.net.EpisodeRef
import com.retrotv.app.net.NowPlaying
import com.retrotv.app.net.Store
import com.retrotv.app.net.UnauthorizedException
import com.retrotv.app.player.ChannelPlayer
import com.retrotv.app.tuner.TunerEvent
import com.retrotv.app.tuner.TunerResult
import com.retrotv.app.tuner.TunerState
import com.retrotv.app.tuner.initialTuner
import com.retrotv.app.tuner.reduceTuner
import com.retrotv.app.ui.CrtKnob
import com.retrotv.app.ui.CrtSettings
import com.retrotv.app.ui.MenuAdapter
import com.retrotv.app.ui.MenuEvent
import com.retrotv.app.ui.MenuLevel
import com.retrotv.app.ui.MenuResult
import com.retrotv.app.ui.MenuState
import com.retrotv.app.ui.formatChannelNumber
import com.retrotv.app.ui.formatMenuChannelRow
import com.retrotv.app.ui.formatMenuEpisodeRow
import com.retrotv.app.ui.formatTuneLine
import com.retrotv.app.ui.formatVolumeBar
import com.retrotv.app.ui.reduceMenu
import java.io.IOException

/**
 * Unica tela do app. Equivale a `src/web/main.ts`: so cola.
 *
 * Toda a decisao esta em `Sync.kt`, `Tuner.kt` e `Osd.kt`, que sao puros e
 * testados. Este arquivo so mexe em View e ExoPlayer.
 */
@OptIn(UnstableApi::class)
class MainActivity : AppCompatActivity() {

  private lateinit var views: ActivityMainBinding
  private lateinit var store: Store
  private lateinit var api: ApiClient
  private lateinit var player: ChannelPlayer
  private lateinit var audio: AudioManager

  private var channels: List<ChannelSummary> = emptyList()
  private var tuner: TunerState = initialTuner(0)
  private var ticker: Job? = null
  private var osdHide: Job? = null
  private var crt = CrtSettings()
  private var mode: DisplayMode = DisplayMode.CRT

  private var menu = MenuState()
  private var vodEpisodes: List<EpisodeRef> = emptyList()
  private var episodesJob: Job? = null
  private lateinit var menuAdapter: MenuAdapter

  /** Cada ajuste do painel e a linha que o mostra. */
  private val knobs: List<Pair<CrtKnob, CrtRowBinding>> by lazy {
    listOf(
      CrtKnob.SCANLINES to views.rowScanlines,
      CrtKnob.VIGNETTE_STRENGTH to views.rowVignette,
      CrtKnob.VIGNETTE_RADIUS to views.rowRadius,
      CrtKnob.STATIC to views.rowStatic,
    )
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    views = ActivityMainBinding.inflate(layoutInflater)
    setContentView(views.root)

    // Um canal ao vivo nao tem pausa: deixar a TV apagar no meio seria perder a
    // grade sem que ninguem tenha pedido.
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

    store = Store(this)
    api = ApiClient(store)
    audio = getSystemService(Context.AUDIO_SERVICE) as AudioManager

    player = ChannelPlayer(this, api, lifecycleScope, playerEvents)
    views.stage.player = player.exo

    crt = store.crt
    // A moldura e da TV, nao do arquivo. Comeca no ultimo modo visto para nao
    // abrir 4:3 e pular para 16:9 quando o servidor responder; o `start()`
    // confirma (ou corrige) logo depois.
    mode = DisplayMode.from(store.displayMode)
    applyDisplayMode()

    menuAdapter = MenuAdapter(::activateRow)
    views.menuList.layoutManager = LinearLayoutManager(this)
    views.menuList.adapter = menuAdapter

    // Voltar fecha o painel em vez de sair do app. Sem isto, ajustar o tubo e
    // desligar a TV seriam a mesma tecla.
    onBackPressedDispatcher.addCallback(this) {
      if (views.menu.visibility == View.VISIBLE) {
        applyMenu(reduceMenu(menu, MenuEvent.Back))
        return@addCallback
      }
      if (views.settings.visibility == View.VISIBLE) {
        closeSettings()
        return@addCallback
      }
      isEnabled = false
      onBackPressedDispatcher.onBackPressed()
    }

    views.gateSubmit.setOnClickListener { submitGate() }

    lifecycleScope.launch {
      if (runCatching { api.hasSession() }.getOrDefault(false)) start() else openGate()
    }
  }

  override fun onStart() {
    super.onStart()
    // Volta do standby: a grade andou enquanto a TV dormia, entao nunca se
    // retoma da posicao antiga — pergunta-se de novo onde o canal esta.
    //
    // Um episodio sob demanda que estava tocando morre aqui, de proposito: o
    // estado de repouso deste aparelho e a grade ao vivo, e voltar do standby
    // no meio de um episodio pausado seria uma TV que nao liga.
    if (channels.isNotEmpty() && views.gate.visibility != View.VISIBLE) {
      // Menu aberto no momento do standby mostraria linhas velhas por cima da
      // sintonia nova; a TV acorda sempre limpa, direto na grade.
      if (views.menu.visibility == View.VISIBLE) closeMenu()
      lifecycleScope.launch { tune(tuner.current) }
      startTicker()
    }
  }

  override fun onStop() {
    super.onStop()
    stopTicker()
    player.stop()
  }

  override fun onDestroy() {
    super.onDestroy()
    player.release()
  }

  // Portao de acesso

  private fun openGate() {
    // Fecha antes de pedir a senha: menu aberto por cima do portao seguraria o
    // foco longe do campo.
    if (views.menu.visibility == View.VISIBLE) closeMenu()
    views.gateServer.setText(store.serverUrl)
    views.gate.visibility = View.VISIBLE
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
      views.gate.visibility = View.GONE
      views.root.requestFocus()
      start()
    }
  }

  // Ligar a TV

  private suspend fun start() {
    channels = try {
      api.channels()
    } catch (error: UnauthorizedException) {
      openGate()
      return
    } catch (error: IOException) {
      showOsd(getString(R.string.gate_offline), sticky = true)
      return
    }

    // Modo de apresentacao, ja com a sessao validada acima. Um `null` aqui e
    // sempre "o servidor nao disse": 404 (servidor antigo) cai no CRT, rede
    // fora cai no ultimo modo visto. Servidor alcancavel sempre vence.
    val wire = try {
      api.config()?.displayMode
    } catch (error: IOException) {
      null
    }
    mode = DisplayMode.from(wire ?: store.displayMode)
    if (wire != null) store.displayMode = wire
    applyDisplayMode()

    if (channels.isEmpty()) {
      showOsd(getString(R.string.no_channels), sticky = true)
      return
    }

    // Volta no canal onde parou. Canal salvo que sumiu do acervo cai no primeiro.
    val initial = store.readLastChannel(channelNumbers()) ?: channels.first().number
    tuner = initialTuner(initial)
    tune(initial)
    startTicker()
  }

  private fun channelNumbers(): List<Int> = channels.map { it.number }

  private suspend fun tune(channelNumber: Int) {
    flashStatic()
    val ok = try {
      player.tune(channelNumber)
    } catch (error: UnauthorizedException) {
      openGate()
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
  }

  // Controle remoto

  override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
    if (views.gate.visibility == View.VISIBLE) return super.onKeyDown(keyCode, event)
    if (views.settings.visibility == View.VISIBLE) {
      // As setas verticais caem no `super` de proposito: quem anda entre as
      // linhas e o proprio sistema de foco.
      return handleSettingsKey(keyCode) || super.onKeyDown(keyCode, event)
    }
    if (views.menu.visibility == View.VISIBLE) return handleMenuKey(keyCode)

    when (keyCode) {
      KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_CHANNEL_UP ->
        return step(1, event.repeatCount)

      KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_CHANNEL_DOWN ->
        return step(-1, event.repeatCount)

      KeyEvent.KEYCODE_DPAD_RIGHT -> return changeVolume(AudioManager.ADJUST_RAISE)
      KeyEvent.KEYCODE_DPAD_LEFT -> return changeVolume(AudioManager.ADJUST_LOWER)

      KeyEvent.KEYCODE_MUTE, KeyEvent.KEYCODE_VOLUME_MUTE, KeyEvent.KEYCODE_M ->
        return changeVolume(AudioManager.ADJUST_TOGGLE_MUTE)

      // A grade nao tem pausa; o catalogo sob demanda tem. Nos dois casos a
      // tecla morre aqui: deixar o sistema fazer alguma coisa com ela seria
      // pior do que nao fazer nada.
      KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
      KeyEvent.KEYCODE_MEDIA_PAUSE,
      KeyEvent.KEYCODE_MEDIA_PLAY,
      -> {
        if (player.mode == ChannelPlayer.PlaybackMode.ON_DEMAND) player.togglePause()
        return true
      }

      // OK abre o menu — mas so no modo panoramico. Em CRT a tecla segue o
      // caminho de sempre, que e nao ter dono.
      KeyEvent.KEYCODE_DPAD_CENTER,
      KeyEvent.KEYCODE_ENTER,
      KeyEvent.KEYCODE_MENU,
      -> {
        if (mode == DisplayMode.WIDESCREEN && channels.isNotEmpty()) {
          applyMenu(reduceMenu(menu, MenuEvent.Open))
          return true
        }
      }
    }

    val digit = digitOf(keyCode)
    if (digit != null) {
      apply(reduceTuner(tuner, TunerEvent.Digit(digit, now()), channelNumbers()))
      return true
    }

    return super.onKeyDown(keyCode, event)
  }

  private fun step(delta: Int, repeatCount: Int): Boolean {
    apply(reduceTuner(tuner, TunerEvent.Step(delta, repeatCount, now()), channelNumbers()))
    return true
  }

  private fun apply(result: TunerResult) {
    tuner = result.state

    if (result.secret) {
      openSettings()
      return
    }
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

  private fun digitOf(keyCode: Int): Char? =
    if (keyCode in KeyEvent.KEYCODE_0..KeyEvent.KEYCODE_9) {
      '0' + (keyCode - KeyEvent.KEYCODE_0)
    } else {
      null
    }

  /**
   * Volume pelo sistema, nao pelo ExoPlayer: quem manda no som da TV e o
   * AudioManager, e mexer so no player deixaria o indicador do aparelho mentindo.
   * A barra verde e desenhada aqui para nao chamar a UI do sistema por cima do
   * canal.
   */
  private fun changeVolume(direction: Int): Boolean {
    audio.adjustStreamVolume(AudioManager.STREAM_MUSIC, direction, 0)
    val max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
    val level = if (max == 0) 0f else audio.getStreamVolume(AudioManager.STREAM_MUSIC) / max.toFloat()
    showOsd(formatVolumeBar(level, audio.isStreamMute(AudioManager.STREAM_MUSIC)))
    return true
  }

  // OSD

  private fun labelFor(channelNumber: Int): String {
    val channel = channels.firstOrNull { it.number == channelNumber }
      ?: return formatChannelNumber(channelNumber)
    return formatTuneLine(channel, null)
  }

  // Menu de canais e episodios (so no modo panoramico)

  /**
   * O menu e modal: consome tudo enquanto esta aberto.
   *
   * As setas verticais so chegam aqui nas bordas da lista — no meio quem anda
   * entre as linhas e o foco nativo do RecyclerView. Deixar qualquer tecla
   * vazar daqui zaparia o canal por baixo do menu.
   *
   * @return sempre true.
   */
  private fun handleMenuKey(keyCode: Int): Boolean {
    when (keyCode) {
      KeyEvent.KEYCODE_BACK -> applyMenu(reduceMenu(menu, MenuEvent.Back))

      KeyEvent.KEYCODE_DPAD_RIGHT -> {
        if (menu.level is MenuLevel.Channels) {
          val channel = channels.getOrNull(focusedMenuPosition()) ?: return true
          applyMenu(reduceMenu(menu, MenuEvent.DrillChannel(channel.number)))
        }
      }

      KeyEvent.KEYCODE_DPAD_LEFT -> {
        if (menu.level is MenuLevel.Episodes) applyMenu(reduceMenu(menu, MenuEvent.Back))
      }
    }
    return true
  }

  /** Linha em foco agora, ou `NO_POSITION` quando o foco ainda nao pousou. */
  private fun focusedMenuPosition(): Int =
    views.menuList.focusedChild?.let(views.menuList::getChildAdapterPosition)
      ?: RecyclerView.NO_POSITION

  /** OK numa linha. O que ela significa depende do nivel em que o menu esta. */
  private fun activateRow(position: Int) {
    when (menu.level) {
      is MenuLevel.Channels -> {
        val channel = channels.getOrNull(position) ?: return
        applyMenu(reduceMenu(menu, MenuEvent.ActivateChannel(channel.number)))
      }

      is MenuLevel.Episodes -> {
        // Lista vazia e a linha de CARREGANDO…, de erro ou de acervo vazio: nao
        // ha episodio nenhum atras dela para tocar.
        if (vodEpisodes.isEmpty()) return
        applyMenu(reduceMenu(menu, MenuEvent.ActivateEpisode(position)))
      }
    }
  }

  /**
   * Cola entre o reducer e a tela: tudo que o menu faz no mundo — pintar
   * linhas, buscar catalogo, sintonizar, reproduzir — sai daqui.
   */
  private fun applyMenu(result: MenuResult) {
    val previous = menu
    menu = result.state

    if (result.close) {
      closeMenu()
      result.tuneTo?.let { target ->
        // Realinhar o sintonizador e obrigatorio: sem isto o proximo canal+
        // partiria do canal em que o menu foi aberto.
        tuner = initialTuner(target)
        lifecycleScope.launch { tune(target) }
      }
      result.playFrom?.let { index -> startVod(previous.level, index) }
      return
    }

    result.loadEpisodes?.let { channelNumber ->
      showEpisodes(channelNumber)
      return
    }

    // Tecla que nao existe neste nivel: o reducer devolveu o mesmo estado e nao
    // ha nada a repintar.
    if (previous == menu && views.menu.visibility == View.VISIBLE) return

    // Abriu agora, ou voltou do catalogo. No segundo caso o foco volta para a
    // linha do canal que estava aberto, e nao para o topo da lista.
    showChannels(focusOn = (previous.level as? MenuLevel.Episodes)?.channelNumber)
  }

  private fun showChannels(focusOn: Int?) {
    episodesJob?.cancel()
    vodEpisodes = emptyList()

    menuAdapter.rows = channels.map { channel ->
      val (label, value) = formatMenuChannelRow(channel)
      MenuAdapter.Row(label, value)
    }
    views.menuTitle.setText(R.string.menu_title_channels)
    views.menuHint.setText(R.string.menu_hint_channels)
    views.menu.visibility = View.VISIBLE
    views.osd.visibility = View.GONE

    val at = if (focusOn == null) 0 else channels.indexOfFirst { it.number == focusOn }
    focusRow(maxOf(0, at))
  }

  private fun showEpisodes(channelNumber: Int) {
    val channel = channels.firstOrNull { it.number == channelNumber }
    views.menuTitle.text =
      if (channel == null) formatChannelNumber(channelNumber) else formatTuneLine(channel, null)
    views.menuHint.setText(R.string.menu_hint_episodes)

    // A lista some antes da resposta chegar: um OK apressado na linha de espera
    // nao pode tocar o episodio do canal anterior.
    vodEpisodes = emptyList()
    menuAdapter.rows = listOf(MenuAdapter.Row(getString(R.string.menu_loading), ""))
    // A propria linha de espera recebe o foco: menu sem foco nenhum e menu sem
    // VOLTAR, e a resposta pode demorar.
    focusRow(0)

    episodesJob?.cancel()
    episodesJob = lifecycleScope.launch {
      val episodes = try {
        api.episodes(channelNumber)
      } catch (error: UnauthorizedException) {
        openGate()
        return@launch
      } catch (error: IOException) {
        menuAdapter.rows = listOf(MenuAdapter.Row(getString(R.string.gate_offline), ""))
        return@launch
      }

      // Canal que sumiu no rescan (404) e canal sem episodios dizem a mesma
      // coisa para quem esta olhando: nao ha o que assistir aqui.
      if (episodes.isNullOrEmpty()) {
        menuAdapter.rows = listOf(MenuAdapter.Row(getString(R.string.menu_empty), ""))
        return@launch
      }

      vodEpisodes = episodes
      menuAdapter.rows = episodes.map { episode ->
        val (label, value) = formatMenuEpisodeRow(episode)
        MenuAdapter.Row(label, value)
      }
      focusRow(0)
    }
  }

  /**
   * O foco so pode pousar depois que o RecyclerView criou a linha. Espera o
   * desenho, e nao um `post`: a fila de mensagens nao garante que o layout ja
   * aconteceu, e a linha ainda nao existiria para receber o foco.
   */
  private fun focusRow(position: Int) {
    views.menuList.scrollToPosition(position)
    views.menuList.doOnPreDraw {
      views.menuList.findViewHolderForAdapterPosition(position)?.itemView?.requestFocus()
    }
  }

  private fun closeMenu() {
    episodesJob?.cancel()
    episodesJob = null
    menu = MenuState()
    views.menu.visibility = View.GONE
    views.root.requestFocus()
  }

  /** Sai da grade e entra na maratona do canal aberto no menu. */
  private fun startVod(level: MenuLevel, index: Int) {
    val channelNumber = (level as? MenuLevel.Episodes)?.channelNumber ?: return
    val channel = channels.firstOrNull { it.number == channelNumber } ?: return
    if (index !in vodEpisodes.indices) return
    player.playOnDemand(channel, vodEpisodes, index)
  }

  // Painel de servico (codigo 9992)

  /**
   * Abre por cima do canal, sem pausar nada: ajustar scanline olhando tela preta
   * nao diz nada sobre como o desenho vai ficar.
   */
  private fun openSettings() {
    refreshSettings()
    views.settings.visibility = View.VISIBLE
    views.osd.visibility = View.GONE
    views.rowScanlines.root.requestFocus()
  }

  private fun closeSettings() {
    store.crt = crt
    views.settings.visibility = View.GONE
    views.root.requestFocus()
  }

  private fun refreshSettings() {
    for ((knob, row) in knobs) {
      row.rowLabel.text = knob.label
      row.rowValue.text = knob.format(crt)
    }
    views.rowDefaults.rowLabel.setText(R.string.settings_defaults)
    views.rowDefaults.rowValue.setText(R.string.settings_defaults_action)
  }

  /** @return true quando a tecla foi consumida aqui. */
  private fun handleSettingsKey(keyCode: Int): Boolean {
    when (keyCode) {
      KeyEvent.KEYCODE_DPAD_LEFT -> return nudgeFocused(-1)
      KeyEvent.KEYCODE_DPAD_RIGHT -> return nudgeFocused(1)

      KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER -> {
        if (!views.rowDefaults.root.isFocused) return false
        crt = CrtSettings()
        applyCrt()
        refreshSettings()
        return true
      }

      KeyEvent.KEYCODE_BACK -> {
        closeSettings()
        return true
      }
    }
    return false
  }

  private fun nudgeFocused(direction: Int): Boolean {
    val (knob, _) = knobs.firstOrNull { it.second.root.isFocused } ?: return false
    crt = knob.nudge(crt, direction)
    applyCrt()
    refreshSettings()
    return true
  }

  /** Unico lugar que traduz o modo em geometria e camadas. */
  private fun applyDisplayMode() {
    views.tube.setAspectRatio(if (mode == DisplayMode.WIDESCREEN) 16f / 9f else 4f / 3f)
    applyCrt()
  }

  /** Unico lugar que traduz ajuste em pixel. */
  private fun applyCrt() {
    // Fora do CRT o tubo nao existe: o desenho vai limpo na tela panoramica.
    // Some por visibilidade, nao por alpha, para o painel de servico continuar
    // guardando os valores que a pessoa ajustou.
    val tube = if (mode == DisplayMode.CRT) View.VISIBLE else View.GONE
    views.scanlines.visibility = tube
    views.vignette.visibility = tube

    views.scanlines.alpha = crt.scanlineAlpha
    views.vignette.strength = crt.vignetteStrength
    views.vignette.radiusFraction = crt.vignetteRadius

    // O chuvisco e momentaneo: quem le `crt.staticPeak` e o `flashStatic`.
    if (mode != DisplayMode.CRT) {
      views.staticFlash.animate().cancel()
      views.staticFlash.alpha = 0f
    }
  }

  /** Estalo de estatica na troca de canal. Curto: e tempero, nao espera. */
  private fun flashStatic() {
    if (mode != DisplayMode.CRT) return
    views.staticFlash.animate().cancel()
    views.staticFlash.alpha = crt.staticPeak
    views.staticFlash.animate().alpha(0f).setDuration(STATIC_MS).start()
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
        apply(reduceTuner(tuner, TunerEvent.Tick(now()), channelNumbers()))
      }
    }
  }

  private fun stopTicker() {
    ticker?.cancel()
    ticker = null
  }

  private fun now() = System.currentTimeMillis()

  private val playerEvents = object : ChannelPlayer.Events {
    override fun onTuned(playing: NowPlaying) {
      showOsd(formatTuneLine(playing.channel, playing.episode))
    }

    override fun onEpisodeChange(playing: NowPlaying) {
      showOsd(formatTuneLine(playing.channel, playing.episode))
    }

    override fun onStalled() {
      showOsd(getString(R.string.no_signal))
    }

    override fun onError(error: Throwable) {
      if (error is UnauthorizedException) openGate() else Log.w(TAG, "erro no player", error)
    }

    override fun onVodEpisode(channel: ChannelSummary, episode: EpisodeRef) {
      showOsd(formatTuneLine(channel, episode))
    }

    override fun onVodEnded() {
      // A maratona acabou. Volta ao vivo: uma TV nunca fica em tela morta.
      lifecycleScope.launch { tune(tuner.current) }
    }
  }

  private companion object {
    const val TAG = "RetroTv"
    const val OSD_HOLD_MS = 3_000L
    const val STATIC_MS = 320L

    /** Fino o suficiente para o commit de 250ms do passo nao parecer travado. */
    const val TICK_MS = 100L
  }
}
