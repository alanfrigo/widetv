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
  fun `o player so abre a partir da serie`() {
    assertEquals(ScreenId.PLAYER, reduceNav(series, NavEvent.OpenPlayer(7)).state.screen)
    assertEquals(home, reduceNav(home, NavEvent.OpenPlayer(7)).state)
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
    val result = reduceNav(settings, NavEvent.Back)
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
  fun `voltar do player cai na serie que esta tocando, e nao na que o abriu`() {
    val zapped = reduceNav(player, NavEvent.LiveTuned(12)).state
    val back = reduceNav(zapped, NavEvent.Back)
    assertEquals(ScreenId.SERIES, back.state.screen)
    assertEquals(12, back.state.channelNumber)
  }

  @Test
  fun `zapear fora do player nao muda nada`() {
    assertEquals(series, reduceNav(series, NavEvent.LiveTuned(12)).state)
    assertEquals(home, reduceNav(home, NavEvent.LiveTuned(12)).state)
  }

  // Subida

  @Test
  fun `voltar da serie limpa o canal e volta ao acervo`() {
    val result = reduceNav(series, NavEvent.Back)
    assertEquals(ScreenId.HOME, result.state.screen)
    assertNull(result.state.channelNumber)
    assertFalse(result.exit)
  }

  @Test
  fun `voltar no acervo fecha o app`() {
    val result = reduceNav(home, NavEvent.Back)
    assertTrue(result.exit)
    assertEquals(ScreenId.HOME, result.state.screen)
  }

  @Test
  fun `voltar no portao fecha o app`() {
    assertTrue(reduceNav(gate, NavEvent.Back).exit)
  }

  @Test
  fun `tres VOLTAR levam do player ate a saida`() {
    var state = player
    state = reduceNav(state, NavEvent.Back).state
    assertEquals(ScreenId.SERIES, state.screen)
    state = reduceNav(state, NavEvent.Back).state
    assertEquals(ScreenId.HOME, state.screen)
    assertTrue(reduceNav(state, NavEvent.Back).exit)
  }
}
