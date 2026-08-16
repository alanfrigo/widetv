package com.widetv.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Navegacao entre as cinco telas. Substitui o `MenuTest` do app antigo, cujo
 * menu de canais e episodios virou o acervo e a tela de serie.
 */
class NavTest {

  private val gate = NavState(ScreenId.GATE)
  private val home = NavState(ScreenId.HOME)
  private val series = NavState(ScreenId.SERIES, 7)
  private val player = NavState(ScreenId.PLAYER, 7)
  private val settings = NavState(ScreenId.SETTINGS)

  // Entrada e saida da sessao

  @Test
  fun `sessao valida abre o acervo`() {
    val result = reduceNav(gate, NavEvent.Authenticated)
    assertEquals(ScreenId.HOME, result.state.screen)
    assertNull(result.state.channelNumber)
  }

  @Test
  fun `401 cai no portao venha de onde vier`() {
    for (from in listOf(home, series, player)) {
      val result = reduceNav(from, NavEvent.SessionLost)
      assertEquals(ScreenId.GATE, result.state.screen)
      assertNull(result.state.channelNumber)
    }
  }

  // Descida

  @Test
  fun `abrir uma serie guarda o numero do canal`() {
    val result = reduceNav(home, NavEvent.OpenSeries(7))
    assertEquals(ScreenId.SERIES, result.state.screen)
    assertEquals(7, result.state.channelNumber)
  }

  @Test
  fun `o portao nao abre serie nenhuma`() {
    val result = reduceNav(gate, NavEvent.OpenSeries(7))
    assertEquals(gate, result.state)
  }

  @Test
  fun `o player abre da serie e tambem do acervo`() {
    assertEquals(ScreenId.PLAYER, reduceNav(series, NavEvent.OpenPlayer(7)).state.screen)
    // O hero e a faixa "No ar agora" entram no canal sem passar pela serie: era
    // exatamente o atalho que a grade 5xN nao tinha.
    val fromHome = reduceNav(home, NavEvent.OpenPlayer(7))
    assertEquals(ScreenId.PLAYER, fromHome.state.screen)
    assertEquals(7, fromHome.state.channelNumber)
  }

  @Test
  fun `o portao nao abre player nenhum`() {
    assertEquals(gate, reduceNav(gate, NavEvent.OpenPlayer(7)).state)
    assertEquals(settings, reduceNav(settings, NavEvent.OpenPlayer(7)).state)
  }

  // Configuracoes

  @Test
  fun `o acervo abre as configuracoes e esquece o canal`() {
    val result = reduceNav(home, NavEvent.OpenSettings)
    assertEquals(ScreenId.SETTINGS, result.state.screen)
    assertNull(result.state.channelNumber)
  }

  @Test
  fun `o portao nao abre configuracao nenhuma`() {
    assertEquals(gate, reduceNav(gate, NavEvent.OpenSettings).state)
  }

  @Test
  fun `voltar das configuracoes cai no acervo`() {
    val result = reduceNav(settings, NavEvent.Back(atMs = 0))
    assertEquals(ScreenId.HOME, result.state.screen)
    assertFalse(result.exit)
  }

  // Zap ao vivo

  @Test
  fun `zapear troca a serie sem sair do player`() {
    val result = reduceNav(player, NavEvent.LiveTuned(12))
    assertEquals(ScreenId.PLAYER, result.state.screen)
    assertEquals(12, result.state.channelNumber)
  }

  @Test
  fun `zapear fora do player nao muda nada`() {
    assertEquals(series, reduceNav(series, NavEvent.LiveTuned(12)).state)
    assertEquals(home, reduceNav(home, NavEvent.LiveTuned(12)).state)
  }

  // Retrace: VOLTAR do player refaz o caminho de quem o abriu (`cameFrom`).
  // Decisao de produto consciente: isso vence a semantica Netflix de "cair na
  // serie do que esta tocando" quando o player veio do acervo.

  @Test
  fun `player aberto do acervo volta ao acervo`() {
    val opened = reduceNav(home, NavEvent.OpenPlayer(7)).state
    val zapped = reduceNav(opened, NavEvent.LiveTuned(12)).state
    val back = reduceNav(zapped, NavEvent.Back(atMs = 0))
    assertEquals(ScreenId.HOME, back.state.screen)
    assertNull(back.state.channelNumber)
  }

  @Test
  fun `player aberto da serie volta a serie mesmo apos zapear`() {
    val opened = reduceNav(series, NavEvent.OpenPlayer(7)).state
    val zapped = reduceNav(opened, NavEvent.LiveTuned(12)).state
    val back = reduceNav(zapped, NavEvent.Back(atMs = 0))
    assertEquals(ScreenId.SERIES, back.state.screen)
    // A serie mostrada e a do canal que esta tocando agora, nao a que abriu.
    assertEquals(12, back.state.channelNumber)
  }

  // Subida

  @Test
  fun `voltar da serie limpa o canal e volta ao acervo`() {
    val result = reduceNav(series, NavEvent.Back(atMs = 0))
    assertEquals(ScreenId.HOME, result.state.screen)
    assertNull(result.state.channelNumber)
    assertFalse(result.exit)
  }

  @Test
  fun `primeiro VOLTAR no acervo pede confirmacao`() {
    val result = reduceNav(home, NavEvent.Back(atMs = 1_000))
    assertFalse(result.exit)
    assertTrue(result.confirmExit)
    assertEquals(ScreenId.HOME, result.state.screen)
    assertEquals(1_000L, result.state.exitArmedAtMs)
  }

  @Test
  fun `segundo VOLTAR dentro de 2s sai`() {
    val armed = reduceNav(home, NavEvent.Back(atMs = 1_000)).state
    val result = reduceNav(armed, NavEvent.Back(atMs = 1_000 + EXIT_CONFIRM_WINDOW_MS))
    assertTrue(result.exit)
    assertFalse(result.confirmExit)
  }

  @Test
  fun `VOLTAR apos janela vencida re-arma`() {
    val armed = reduceNav(home, NavEvent.Back(atMs = 1_000)).state
    val late = reduceNav(armed, NavEvent.Back(atMs = 1_000 + EXIT_CONFIRM_WINDOW_MS + 1))
    assertFalse(late.exit)
    assertTrue(late.confirmExit)
    assertEquals(1_000 + EXIT_CONFIRM_WINDOW_MS + 1, late.state.exitArmedAtMs)
    // E a partir do novo timestamp a janela vale de novo.
    assertTrue(reduceNav(late.state, NavEvent.Back(atMs = late.state.exitArmedAtMs!! + 1)).exit)
  }

  @Test
  fun `voltar no portao fecha o app sem confirmacao`() {
    val result = reduceNav(gate, NavEvent.Back(atMs = 0))
    assertTrue(result.exit)
    assertFalse(result.confirmExit)
  }

  @Test
  fun `VOLTAR desce do player ate a saida com confirmacao no acervo`() {
    var state = reduceNav(series, NavEvent.OpenPlayer(7)).state
    state = reduceNav(state, NavEvent.Back(atMs = 0)).state
    assertEquals(ScreenId.SERIES, state.screen)
    state = reduceNav(state, NavEvent.Back(atMs = 100)).state
    assertEquals(ScreenId.HOME, state.screen)
    val first = reduceNav(state, NavEvent.Back(atMs = 200))
    assertFalse(first.exit)
    assertTrue(first.confirmExit)
    assertTrue(reduceNav(first.state, NavEvent.Back(atMs = 300)).exit)
  }

  // Hierarquia do VOLTAR dentro do player: cada camada engole a tecla antes de
  // deixar a navegacao andar.

  @Test
  fun `painel de trilhas aberto vence a digitacao do tuner`() {
    assertEquals(
      BackLayer.CLOSE_PANEL,
      backLayer(panelOpen = true, typingChannel = true, overlayVisible = true),
    )
  }

  @Test
  fun `digitacao pendente vence o overlay`() {
    assertEquals(
      BackLayer.CLEAR_TUNER,
      backLayer(panelOpen = false, typingChannel = true, overlayVisible = true),
    )
  }

  @Test
  fun `overlay visivel vence a navegacao`() {
    assertEquals(
      BackLayer.HIDE_OVERLAY,
      backLayer(panelOpen = false, typingChannel = false, overlayVisible = true),
    )
  }

  @Test
  fun `tela limpa deixa o VOLTAR navegar`() {
    assertEquals(
      BackLayer.NAVIGATE,
      backLayer(panelOpen = false, typingChannel = false, overlayVisible = false),
    )
  }

  // Snapshot da navegacao: sobrevive a recriacao da Activity via pack/unpack.

  @Test
  fun `round-trip preserva acervo serie e configuracoes`() {
    for (state in listOf(home, series, settings)) {
      assertEquals(state, unpackNav(packNav(state)))
    }
  }

  @Test
  fun `player salvo restaura na serie que o abriu`() {
    val opened = reduceNav(series, NavEvent.OpenPlayer(7)).state
    val restored = unpackNav(packNav(opened))
    assertEquals(ScreenId.SERIES, restored!!.screen)
    assertEquals(7, restored.channelNumber)
  }

  @Test
  fun `player aberto do acervo restaura no acervo sem canal`() {
    val opened = reduceNav(home, NavEvent.OpenPlayer(7)).state
    val restored = unpackNav(packNav(opened))
    assertEquals(ScreenId.HOME, restored!!.screen)
    assertNull(restored.channelNumber)
  }

  @Test
  fun `zapear antes de salvar restaura na serie do canal atual`() {
    val opened = reduceNav(series, NavEvent.OpenPlayer(7)).state
    val zapped = reduceNav(opened, NavEvent.LiveTuned(12)).state
    val restored = unpackNav(packNav(zapped))
    assertEquals(ScreenId.SERIES, restored!!.screen)
    assertEquals(12, restored.channelNumber)
  }

  @Test
  fun `o relogio do duplo-VOLTAR nao atravessa a recriacao`() {
    val armed = reduceNav(home, NavEvent.Back(atMs = 1_000)).state
    assertNull(unpackNav(packNav(armed))!!.exitArmedAtMs)
  }

  @Test
  fun `snapshot ilegivel devolve null`() {
    assertNull(unpackNav(null))
    assertNull(unpackNav(""))
    assertNull(unpackNav("HOME"))
    assertNull(unpackNav("PALCO|7|SERIES"))
    assertNull(unpackNav("PLAYER|7|PALCO"))
  }
}
