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
  fun `abrir monta cabecalho, audios, legendas com desligar e a linha de lembrar`() {
    val rows = rows(open())
    assertEquals(
      listOf(
        TrackRow.Header(TrackKind.AUDIO),
        TrackRow.Option(TrackKind.AUDIO, option("0", "Portugues", selected = true)),
        TrackRow.Option(TrackKind.AUDIO, option("1", "English")),
        TrackRow.Header(TrackKind.TEXT),
        TrackRow.Option(TrackKind.TEXT, option(TRACK_OFF, off, selected = true)),
        TrackRow.Option(TrackKind.TEXT, option("0", "Portugues")),
        TrackRow.Remember(on = true),
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

  // Linha de lembrar

  @Test
  fun `cursor alcanca a linha de lembrar como ultima`() {
    var state = open()
    // 1 -> 2 -> 4 -> 5 -> 6: opcoes, Desativadas, legenda e enfim o lembrar.
    repeat(4) { state = reduceTrackPanel(state, TrackPanelEvent.Move(1)).state }
    val rows = rows(state)
    assertEquals(rows.lastIndex, state.cursor)
    assertTrue(rows[state.cursor] is TrackRow.Remember)
    // A aba acesa segue a secao de onde o cursor veio, nao apaga no rodape.
    assertEquals(TrackKind.TEXT, activeTab(state))
  }

  @Test
  fun `Move alem da linha de lembrar fica parado`() {
    var state = open()
    repeat(4) { state = reduceTrackPanel(state, TrackPanelEvent.Move(1)).state }
    assertEquals(rows(state).lastIndex, state.cursor)
    assertEquals(state.cursor, reduceTrackPanel(state, TrackPanelEvent.Move(1)).state.cursor)
  }

  @Test
  fun `OK na linha de lembrar alterna sem fechar`() {
    var state = open()
    repeat(4) { state = reduceTrackPanel(state, TrackPanelEvent.Move(1)).state }

    val result = reduceTrackPanel(state, TrackPanelEvent.Select)
    assertTrue(result.toggleRemember)
    assertFalse(result.state.remember)
    assertNull(result.choose)
    assertFalse(result.close)
    assertTrue(result.state.open)
    assertEquals(TrackRow.Remember(on = false), rows(result.state).last())

    // OK de novo religa: e um interruptor, nao um botao de um tiro so.
    val again = reduceTrackPanel(result.state, TrackPanelEvent.Select)
    assertTrue(again.toggleRemember)
    assertTrue(again.state.remember)
  }

  @Test
  fun `abrir carrega o interruptor que veio da Activity`() {
    val state = reduceTrackPanel(
      TrackPanelState(),
      TrackPanelEvent.Open(listOf(option("0", "Portugues")), emptyList(), off, remember = false),
    ).state
    assertFalse(state.remember)
    assertEquals(TrackRow.Remember(on = false), rows(state).last())
  }

  // Abas do segmented control

  @Test
  fun `a aba de legendas leva o cursor para a primeira linha da secao`() {
    val state = open()
    // 4 e a linha "Desativadas", a primeira da secao de legendas (3 e o cabecalho).
    val after = reduceTrackPanel(state, TrackPanelEvent.Tab(TrackKind.TEXT)).state
    assertEquals(4, after.cursor)
    assertEquals(TrackKind.TEXT, activeTab(after))
  }

  @Test
  fun `a aba de audio traz o cursor de volta para a primeira faixa`() {
    var state = reduceTrackPanel(open(), TrackPanelEvent.Tab(TrackKind.TEXT)).state
    state = reduceTrackPanel(state, TrackPanelEvent.Tab(TrackKind.AUDIO)).state
    assertEquals(1, state.cursor)
    assertEquals(TrackKind.AUDIO, activeTab(state))
  }

  @Test
  fun `a aba nao escolhe nada, so anda`() {
    val before = open()
    val result = reduceTrackPanel(before, TrackPanelEvent.Tab(TrackKind.TEXT))
    assertNull(result.choose)
    assertEquals(before.audio, result.state.audio)
    assertEquals(before.text, result.state.text)
  }

  @Test
  fun `secao que nao existe nao move o cursor`() {
    // Episodio sem legenda: a aba fica sem efeito em vez de jogar o cursor num
    // lugar que nao ha.
    val state = open(text = emptyList())
    assertEquals(state.cursor, reduceTrackPanel(state, TrackPanelEvent.Tab(TrackKind.TEXT)).state.cursor)
  }

  @Test
  fun `painel fechado ignora as abas`() {
    val closed = TrackPanelState()
    assertEquals(closed, reduceTrackPanel(closed, TrackPanelEvent.Tab(TrackKind.TEXT)).state)
  }

  @Test
  fun `a aba marcada segue o cursor, mesmo quando ele anda com a seta`() {
    // Descer da ultima faixa de audio para a primeira legenda TEM que acender a
    // outra aba: um campo separado para isso poderia discordar do cursor.
    var state = open()
    repeat(2) { state = reduceTrackPanel(state, TrackPanelEvent.Move(1)).state }
    assertEquals(4, state.cursor)
    assertEquals(TrackKind.TEXT, activeTab(state))
  }

  @Test
  fun `painel vazio nao inventa aba`() {
    assertEquals(TrackKind.AUDIO, activeTab(TrackPanelState()))
  }

  // Detalhe e nota do rodape

  @Test
  fun `o detalhe junta codec, arranjo e a posicao da faixa`() {
    assertEquals("eac3 · 5.1 · faixa 1", formatTrackDetail("audio/eac3", 6, 0))
    assertEquals("aac · estéreo · faixa 2", formatTrackDetail("audio/aac", 2, 1))
  }

  @Test
  fun `o que o container nao disse nao aparece no detalhe`() {
    assertEquals("faixa 1", formatTrackDetail(null, 0, 0))
    assertEquals("subrip · faixa 3", formatTrackDetail("application/subrip", -1, 2))
  }

  @Test
  fun `arranjo incomum sai em numero de canais`() {
    assertEquals("mono", formatChannelLayout(1))
    assertEquals("7.1", formatChannelLayout(8))
    assertEquals("3 canais", formatChannelLayout(3))
    assertNull(formatChannelLayout(0))
  }

  @Test
  fun `a nota do rodape muda com o interruptor`() {
    assertTrue(panelNote(remember = true).startsWith("A escolha vale para a casa toda"))
    assertTrue(panelNote(remember = false).startsWith("A escolha vale só nesta sessão"))
  }

  @Test
  fun `a nota ensina o OK, nao o MENU que o controle Google TV nao tem`() {
    assertTrue(panelNote(remember = true).contains("OK alterna"))
    assertTrue(panelNote(remember = false).contains("OK alterna"))
    assertFalse(panelNote(remember = true).contains("MENU"))
    assertFalse(panelNote(remember = false).contains("MENU"))
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
