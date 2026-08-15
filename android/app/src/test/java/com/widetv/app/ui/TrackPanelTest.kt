package com.widetv.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Painel de audio e legenda: cursor, marcacao e o que o player recebe de volta. */
class TrackPanelTest {

  private val off = "Desativadas"

  private fun option(id: String, label: String, selected: Boolean = false) =
    TrackOption(id, label, selected)

  private fun open(
    audio: List<TrackOption> = listOf(
      option("0", "Portugues", selected = true),
      option("1", "English"),
    ),
    text: List<TrackOption> = listOf(option("0", "Portugues")),
  ) = reduceTrackPanel(TrackPanelState(), TrackPanelEvent.Open(audio, text, off)).state

  // Montagem das linhas

  @Test
  fun `abrir monta cabecalho, audios e legendas com a linha de desligar`() {
    val rows = rows(open())
    assertEquals(
      listOf(
        TrackRow.Header(TrackKind.AUDIO),
        TrackRow.Option(TrackKind.AUDIO, option("0", "Portugues", selected = true)),
        TrackRow.Option(TrackKind.AUDIO, option("1", "English")),
        TrackRow.Header(TrackKind.TEXT),
        TrackRow.Option(TrackKind.TEXT, option(TRACK_OFF, off, selected = true)),
        TrackRow.Option(TrackKind.TEXT, option("0", "Portugues")),
      ),
      rows,
    )
  }

  @Test
  fun `sem legenda nenhuma a secao inteira some, inclusive o desligar`() {
    val rows = rows(open(text = emptyList()))
    assertTrue(rows.none { it is TrackRow.Header && it.kind == TrackKind.TEXT })
    assertTrue(rows.none { it is TrackRow.Option && it.option.id == TRACK_OFF })
  }

  @Test
  fun `legenda ja tocando tira a marca de Desativadas`() {
    val state = open(text = listOf(option("0", "Portugues", selected = true)))
    val offRow = rows(state).filterIsInstance<TrackRow.Option>().first { it.option.id == TRACK_OFF }
    assertFalse(offRow.option.selected)
  }

  @Test
  fun `abrir pousa o cursor no que esta tocando`() {
    // Linha 0 e o cabecalho de AUDIO; linha 1 e o portugues, que esta selecionado.
    assertEquals(1, open().cursor)
  }

  @Test
  fun `sem nada selecionado o cursor pousa na primeira opcao`() {
    val state = open(audio = listOf(option("0", "English")), text = emptyList())
    assertEquals(1, state.cursor)
  }

  // Cursor

  @Test
  fun `descer pula o cabecalho da secao seguinte`() {
    val state = open()
    // 1 (portugues) -> 2 (english) -> 4 (Desativadas), pulando o cabecalho 3.
    val a = reduceTrackPanel(state, TrackPanelEvent.Move(1)).state
    assertEquals(2, a.cursor)
    val b = reduceTrackPanel(a, TrackPanelEvent.Move(1)).state
    assertEquals(4, b.cursor)
  }

  @Test
  fun `subir tambem pula cabecalho`() {
    var state = open()
    repeat(2) { state = reduceTrackPanel(state, TrackPanelEvent.Move(1)).state }
    assertEquals(4, state.cursor)
    assertEquals(2, reduceTrackPanel(state, TrackPanelEvent.Move(-1)).state.cursor)
  }

  @Test
  fun `no topo a seta para cima nao faz nada`() {
    val state = open()
    assertEquals(1, reduceTrackPanel(state, TrackPanelEvent.Move(-1)).state.cursor)
  }

  @Test
  fun `no fim a seta para baixo nao da a volta`() {
    var state = open()
    repeat(10) { state = reduceTrackPanel(state, TrackPanelEvent.Move(1)).state }
    val last = rows(state).lastIndex
    assertEquals(last, state.cursor)
    assertEquals(last, reduceTrackPanel(state, TrackPanelEvent.Move(1)).state.cursor)
  }

  @Test
  fun `painel fechado ignora as setas`() {
    val closed = TrackPanelState()
    assertEquals(closed, reduceTrackPanel(closed, TrackPanelEvent.Move(1)).state)
  }

  // Escolha

  @Test
  fun `OK num audio devolve a escolha e move a marca`() {
    val state = reduceTrackPanel(open(), TrackPanelEvent.Move(1)).state
    val result = reduceTrackPanel(state, TrackPanelEvent.Select)

    assertEquals(TrackChoice(TrackKind.AUDIO, "1"), result.choose)
    assertEquals(listOf(false, true), result.state.audio.map { it.selected })
    // O painel continua aberto: escolher audio e legenda sao duas escolhas, nao
    // duas visitas.
    assertFalse(result.close)
    assertTrue(result.state.open)
  }

  @Test
  fun `escolher audio nao mexe na marca das legendas`() {
    val before = open()
    val result = reduceTrackPanel(before, TrackPanelEvent.Select)
    assertEquals(before.text, result.state.text)
  }

  @Test
  fun `OK em Desativadas devolve a escolha de desligar`() {
    var state = open()
    repeat(2) { state = reduceTrackPanel(state, TrackPanelEvent.Move(1)).state }
    val result = reduceTrackPanel(state, TrackPanelEvent.Select)
    assertEquals(TrackChoice(TrackKind.TEXT, TRACK_OFF), result.choose)
    assertTrue(result.state.text.first { it.id == TRACK_OFF }.selected)
  }

  @Test
  fun `OK numa legenda tira a marca de Desativadas`() {
    var state = open()
    repeat(3) { state = reduceTrackPanel(state, TrackPanelEvent.Move(1)).state }
    val result = reduceTrackPanel(state, TrackPanelEvent.Select)
    assertEquals(TrackChoice(TrackKind.TEXT, "0"), result.choose)
    assertFalse(result.state.text.first { it.id == TRACK_OFF }.selected)
  }

  @Test
  fun `OK com o painel fechado nao escolhe nada`() {
    val result = reduceTrackPanel(TrackPanelState(), TrackPanelEvent.Select)
    assertNull(result.choose)
  }

  // Fechamento

  @Test
  fun `VOLTAR fecha e esquece as opcoes`() {
    val result = reduceTrackPanel(open(), TrackPanelEvent.Close)
    assertTrue(result.close)
    assertFalse(result.state.open)
    assertTrue(result.state.audio.isEmpty())
    assertTrue(result.state.text.isEmpty())
  }

  // Rotulo de idioma

  @Test
  fun `tag de tres letras vira nome de idioma`() {
    assertEquals("Portugues", languageLabel("por"))
    assertEquals("English", languageLabel("eng"))
  }

  @Test
  fun `tag de duas letras, que e a que o Media3 devolve, tambem`() {
    assertEquals("Portugues", languageLabel("pt"))
    assertEquals("English", languageLabel("en"))
  }

  @Test
  fun `regiao no fim nao atrapalha`() {
    assertEquals("Portugues", languageLabel("pt-BR"))
  }

  @Test
  fun `idioma fora da tabela cai no codigo em maiuscula`() {
    assertEquals("SWE", languageLabel("swe"))
  }

  @Test
  fun `faixa sem idioma nao ganha rotulo`() {
    assertNull(languageLabel(null))
    assertNull(languageLabel(""))
    assertNull(languageLabel("und"))
  }
}
