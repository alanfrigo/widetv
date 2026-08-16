package com.widetv.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Fileira de acoes do player: quem entra nela, como o cursor anda e o que cada
 * tecla dispara em cada modo.
 *
 * O contrato que estes testes protegem e o de um controle que so tem D-PAD, OK e
 * VOLTAR: nenhum comando pode depender de MENU, de teclas de midia ou de teclado.
 */
class PlayerControlsTest {

  private val vod = PlayerControlsState(visible = true, live = false, hasPrev = true, hasNext = true)
  private val liveOn = PlayerControlsState(visible = true, live = true)

  private fun press(
    state: PlayerControlsState,
    vararg keys: PlayerControlsEvent,
  ): PlayerControlsResult {
    var result = PlayerControlsResult(state)
    for (key in keys) result = reducePlayerControls(result.state, key)
    return result
  }

  // Montagem da fileira

  @Test
  fun `sob demanda a fileira tem tudo o que o episodio permite`() {
    assertEquals(
      listOf(
        ControlId.TRACKS,
        ControlId.EPISODES,
        ControlId.PREV,
        ControlId.NEXT,
        ControlId.WATCHED,
        ControlId.MUTE,
      ),
      controlRail(vod),
    )
  }

  @Test
  fun `ao vivo a fileira nao tem anterior, proximo nem ja vi`() {
    // "Proximo" ao vivo e outro canal, e isso mora nas setas de cima e de baixo.
    // Marcar como visto o que a grade esta passando nao mudaria nada do que vem.
    assertEquals(listOf(ControlId.TRACKS, ControlId.EPISODES, ControlId.MUTE), controlRail(liveOn))
  }

  @Test
  fun `no ultimo episodio o botao de proximo some`() {
    val rail = controlRail(vod.copy(hasNext = false))
    assertFalse(rail.contains(ControlId.NEXT))
    assertTrue(rail.contains(ControlId.PREV))
  }

  // Cursor desligado: os gestos de sempre continuam valendo

  @Test
  fun `sob demanda OK sem cursor pausa`() {
    assertEquals(ControlAction.TogglePause, press(vod, PlayerControlsEvent.Ok).action)
  }

  @Test
  fun `ao vivo OK sem cursor abre audio e legendas`() {
    assertEquals(ControlAction.OpenTracks, press(liveOn, PlayerControlsEvent.Ok).action)
  }

  @Test
  fun `sob demanda as setas laterais sem cursor saltam no tempo`() {
    assertEquals(ControlAction.Seek(-1), press(vod, PlayerControlsEvent.Left).action)
    assertEquals(ControlAction.Seek(1), press(vod, PlayerControlsEvent.Right).action)
  }

  @Test
  fun `ao vivo as setas de cima e de baixo zapeiam mesmo com o cursor aceso`() {
    val onRail = press(liveOn, PlayerControlsEvent.Right).state
    assertNotNull(onRail.cursor)
    assertEquals(ControlAction.ZapUp, press(onRail, PlayerControlsEvent.Up).action)
    assertEquals(ControlAction.ZapDown, press(onRail, PlayerControlsEvent.Down).action)
  }

  // Entrada na fileira

  @Test
  fun `sob demanda a seta para cima liga o cursor no primeiro botao`() {
    val result = press(vod, PlayerControlsEvent.Up)
    assertEquals(0, result.state.cursor)
    assertNull("entrar na fileira nao dispara nada", result.action)
  }

  @Test
  fun `ao vivo a seta lateral liga o cursor em vez de morrer num aviso`() {
    val result = press(liveOn, PlayerControlsEvent.Left)
    assertEquals(0, result.state.cursor)
    assertNull(result.action)
  }

  @Test
  fun `sob demanda a seta para baixo desliga o cursor e devolve o salto`() {
    val onRail = press(vod, PlayerControlsEvent.Up).state
    val off = press(onRail, PlayerControlsEvent.Down).state
    assertNull(off.cursor)
    assertEquals(ControlAction.Seek(1), press(off, PlayerControlsEvent.Right).action)
  }

  // Cursor ligado: andar e ativar

  @Test
  fun `com o cursor aceso as setas laterais andam entre os botoes`() {
    val state = press(vod, PlayerControlsEvent.Up, PlayerControlsEvent.Right).state
    assertEquals(1, state.cursor)
    assertEquals(ControlId.EPISODES, focusedControl(state))
  }

  @Test
  fun `a borda da fileira nao da a volta`() {
    val first = press(vod, PlayerControlsEvent.Up, PlayerControlsEvent.Left).state
    assertEquals(0, first.cursor)

    var last = press(vod, PlayerControlsEvent.Up)
    repeat(controlRail(vod).size + 3) {
      last = press(last.state, PlayerControlsEvent.Right)
    }
    assertEquals(controlRail(vod).lastIndex, last.state.cursor)
  }

  @Test
  fun `OK sobre cada botao dispara a acao daquele botao`() {
    val expected = mapOf(
      ControlId.TRACKS to ControlAction.OpenTracks,
      ControlId.EPISODES to ControlAction.OpenEpisodes,
      ControlId.PREV to ControlAction.PrevEpisode,
      ControlId.NEXT to ControlAction.NextEpisode,
      ControlId.WATCHED to ControlAction.ToggleWatched,
      ControlId.MUTE to ControlAction.ToggleMute,
    )
    controlRail(vod).forEachIndexed { at, id ->
      val state = vod.copy(cursor = at)
      assertEquals(id.name, expected[id], press(state, PlayerControlsEvent.Ok).action)
    }
  }

  @Test
  fun `o painel de audio e legendas e alcancavel so com D-pad e OK nos dois modos`() {
    // E a razao de este arquivo existir: sem MENU, sem tecla de midia, sem teclado.
    val fromVod = press(vod, PlayerControlsEvent.Up, PlayerControlsEvent.Ok)
    assertEquals(ControlAction.OpenTracks, fromVod.action)

    val fromLive = press(liveOn, PlayerControlsEvent.Right, PlayerControlsEvent.Ok)
    assertEquals(ControlAction.OpenTracks, fromLive.action)
  }

  // Visibilidade

  @Test
  fun `qualquer tecla traz o overlay de volta`() {
    val hidden = PlayerControlsState(visible = false)
    assertTrue(press(hidden, PlayerControlsEvent.Ok).state.visible)
    assertTrue(press(hidden, PlayerControlsEvent.Right).state.visible)
    assertTrue(press(hidden, PlayerControlsEvent.Up).state.visible)
  }

  @Test
  fun `com o cursor aceso o overlay nao pode sumir sozinho`() {
    assertFalse(railSticky(vod))
    assertTrue(railSticky(press(vod, PlayerControlsEvent.Up).state))
  }

  @Test
  fun `esconder o overlay desliga o cursor`() {
    val onRail = press(vod, PlayerControlsEvent.Up).state
    val hidden = press(onRail, PlayerControlsEvent.Hide).state
    assertFalse(hidden.visible)
    assertNull(hidden.cursor)
  }

  @Test
  fun `VOLTAR desliga o cursor sem esconder o overlay`() {
    val onRail = press(vod, PlayerControlsEvent.Up).state
    val cleared = press(onRail, PlayerControlsEvent.ClearCursor).state
    assertNull(cleared.cursor)
    assertTrue(cleared.visible)
  }

  // Sincronia com o mundo

  @Test
  fun `a fileira encolhendo prende o cursor na ultima coluna`() {
    // Cursor em MUDO, a ultima coluna; o ultimo episodio tira PROXIMO e a
    // fileira encolhe uma casa por baixo do cursor.
    val onMute = vod.copy(cursor = controlRail(vod).lastIndex)
    val synced = press(
      onMute,
      PlayerControlsEvent.Sync(
        live = false,
        muted = false,
        watched = false,
        hasPrev = true,
        hasNext = false,
      ),
    ).state
    assertEquals(controlRail(synced).lastIndex, synced.cursor)
    assertEquals(ControlId.MUTE, focusedControl(synced))
  }

  @Test
  fun `sincronizar nao mexe no cursor desligado nem dispara acao`() {
    val result = press(
      vod,
      PlayerControlsEvent.Sync(
        live = false,
        muted = true,
        watched = false,
        hasPrev = false,
        hasNext = false,
      ),
    )
    assertNull(result.state.cursor)
    assertNull(result.action)
    assertTrue(result.state.muted)
  }
}
