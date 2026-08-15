package com.widetv.app.ui

import com.widetv.app.net.AppSettings
import com.widetv.app.net.LibraryStatus
import com.widetv.app.net.MetadataSummary
import com.widetv.app.net.MetadataTask
import com.widetv.app.net.SCAN_MODE_FULL
import com.widetv.app.net.SCAN_MODE_INCREMENTAL
import com.widetv.app.net.RemuxTask
import com.widetv.app.net.ScanProgressRef
import com.widetv.app.net.ScanSummary
import com.widetv.app.net.ScanTask
import com.widetv.app.net.TASK_IDLE
import com.widetv.app.net.TASK_RUNNING
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Tela de configuracoes: cursor, o que cada seta muda e o texto do estado da
 * biblioteca. Espelha `tests/settings.test.ts` do cliente web — as duas telas
 * obedecem a mesma regra e divergir seria a casa se comportar diferente
 * dependendo do aparelho.
 */
class SettingsTest {

  private val rows = settingsRows()
  private val settings = AppSettings()

  private fun cursorAt(field: SettingsField) =
    SettingsUiState(cursor = rows.indexOfFirst { it.field == field })

  private fun idle() = LibraryStatus()

  // Cursor

  @Test
  fun `o cursor comeca na primeira linha, que e escolhivel`() {
    assertNotEquals(SettingsKind.INFO, rows[SettingsUiState().cursor].kind)
  }

  @Test
  fun `descer pula a linha de informacao`() {
    val info = rows.indexOfFirst { it.kind == SettingsKind.INFO }
    val before = SettingsUiState(cursor = info - 1)
    val after = reduceSettings(before, SettingsEvent.Down, settings).state
    assertEquals(info + 1, after.cursor)
  }

  @Test
  fun `subir tambem pula a linha de informacao`() {
    val info = rows.indexOfFirst { it.kind == SettingsKind.INFO }
    val before = SettingsUiState(cursor = info + 1)
    val after = reduceSettings(before, SettingsEvent.Up, settings).state
    assertEquals(info - 1, after.cursor)
  }

  @Test
  fun `no topo a seta para cima nao faz nada`() {
    val state = SettingsUiState()
    assertEquals(state, reduceSettings(state, SettingsEvent.Up, settings).state)
  }

  @Test
  fun `no fim a seta para baixo nao da a volta`() {
    val state = SettingsUiState(cursor = rows.lastIndex)
    assertEquals(state, reduceSettings(state, SettingsEvent.Down, settings).state)
  }

  @Test
  fun `andar apaga a mensagem, que falava da linha anterior`() {
    val state = SettingsUiState(message = "Iniciado.")
    assertNull(reduceSettings(state, SettingsEvent.Down, settings).state.message)
  }

  @Test
  fun `andar nao dispara comando nenhum`() {
    assertNull(reduceSettings(SettingsUiState(), SettingsEvent.Down, settings).command)
  }

  // Idiomas

  @Test
  fun `a seta direita anda na lista de idiomas a partir do vazio`() {
    val result = reduceSettings(cursorAt(SettingsField.AUDIO_LANG), SettingsEvent.Right, settings)
    assertEquals(
      SettingsCommand.Patch(SettingsField.AUDIO_LANG, SettingsValue.Text("por")),
      result.command,
    )
  }

  @Test
  fun `a seta esquerda no vazio da a volta para o ultimo idioma`() {
    val result = reduceSettings(cursorAt(SettingsField.AUDIO_LANG), SettingsEvent.Left, settings)
    assertEquals(
      SettingsCommand.Patch(SettingsField.AUDIO_LANG, SettingsValue.Text("kor")),
      result.command,
    )
  }

  @Test
  fun `a seta direita no ultimo idioma volta para o vazio`() {
    val result = reduceSettings(
      cursorAt(SettingsField.SUBTITLE_LANG),
      SettingsEvent.Right,
      settings.copy(subtitleLang = "kor"),
    )
    // null na legenda e "desativadas": e o estado de fabrica, e a seta tem que
    // alcancar ele sem tecla nenhuma a mais.
    assertEquals(
      SettingsCommand.Patch(SettingsField.SUBTITLE_LANG, SettingsValue.Text(null)),
      result.command,
    )
  }

  @Test
  fun `idioma marcado com a tag de duas letras e reconhecido na lista`() {
    val result = reduceSettings(
      cursorAt(SettingsField.AUDIO_LANG),
      SettingsEvent.Right,
      settings.copy(audioLang = "pt"),
    )
    assertEquals(
      SettingsCommand.Patch(SettingsField.AUDIO_LANG, SettingsValue.Text("eng")),
      result.command,
    )
  }

  @Test
  fun `idioma fora da lista nao trava a seta`() {
    val result = reduceSettings(
      cursorAt(SettingsField.AUDIO_LANG),
      SettingsEvent.Right,
      settings.copy(audioLang = "swe"),
    )
    assertEquals(
      SettingsCommand.Patch(SettingsField.AUDIO_LANG, SettingsValue.Text(null)),
      result.command,
    )
  }

  @Test
  fun `OK numa linha de idioma avanca, como a seta direita`() {
    val result = reduceSettings(cursorAt(SettingsField.AUDIO_LANG), SettingsEvent.Select, settings)
    assertEquals(
      SettingsCommand.Patch(SettingsField.AUDIO_LANG, SettingsValue.Text("por")),
      result.command,
    )
  }

  @Test
  fun `codigo canonico ignora regiao e maiuscula`() {
    assertEquals("por", canonicalLang("pt-BR"))
    assertEquals("por", canonicalLang("POR"))
    assertEquals("ger", canonicalLang("de"))
    assertNull(canonicalLang("und"))
    assertNull(canonicalLang(null))
  }

  // Horario da varredura diaria

  @Test
  fun `o horario anda de meia em meia hora`() {
    assertEquals("03:30", stepRescanTime("03:00", 1))
    assertEquals("03:00", stepRescanTime("03:30", -1))
    assertEquals("04:00", stepRescanTime("03:30", 1))
  }

  @Test
  fun `o desligado fica entre 23h30 e meia-noite`() {
    assertNull(stepRescanTime("23:30", 1))
    assertEquals("00:00", stepRescanTime(null, 1))
    assertNull(stepRescanTime("00:00", -1))
    assertEquals("23:30", stepRescanTime(null, -1))
  }

  @Test
  fun `o ciclo fecha em quarenta e nove passos`() {
    var value: String? = null
    repeat(49) { value = stepRescanTime(value, 1) }
    assertNull(value)
  }

  @Test
  fun `horario fora da grade encosta no vizinho`() {
    assertEquals("07:30", stepRescanTime("07:15", 1))
    assertEquals("07:00", stepRescanTime("07:15", -1))
  }

  @Test
  fun `horario ilegivel cai no desligado, que e a ponta do ciclo`() {
    assertEquals("00:00", stepRescanTime("banana", 1))
    assertEquals("00:00", stepRescanTime("25:00", 1))
  }

  @Test
  fun `a seta na linha de horario emite o patch do horario`() {
    val result = reduceSettings(
      cursorAt(SettingsField.RESCAN_TIME),
      SettingsEvent.Right,
      settings.copy(rescanTime = "03:00"),
    )
    assertEquals(
      SettingsCommand.Patch(SettingsField.RESCAN_TIME, SettingsValue.Text("03:30")),
      result.command,
    )
  }

  // Chaves

  @Test
  fun `OK num toggle alterna e emite o patch`() {
    val result = reduceSettings(
      cursorAt(SettingsField.AUTO_REMUX),
      SettingsEvent.Select,
      settings.copy(autoRemux = false),
    )
    assertEquals(
      SettingsCommand.Patch(SettingsField.AUTO_REMUX, SettingsValue.Flag(true)),
      result.command,
    )
  }

  @Test
  fun `a seta escolhe o lado em vez de alternar`() {
    val on = settings.copy(smartGrouping = true)
    val row = cursorAt(SettingsField.SMART_GROUPING)

    // Direita com o valor ja ligado nao gasta um PATCH para nada.
    assertNull(reduceSettings(row, SettingsEvent.Right, on).command)
    assertEquals(
      SettingsCommand.Patch(SettingsField.SMART_GROUPING, SettingsValue.Flag(false)),
      reduceSettings(row, SettingsEvent.Left, on).command,
    )
  }

  // Acoes

  @Test
  fun `OK numa acao emite o comando e marca a linha como ocupada`() {
    val result =
      reduceSettings(cursorAt(SettingsField.SCAN_INCREMENTAL), SettingsEvent.Select, settings)
    assertEquals(SettingsCommand.Scan(SCAN_MODE_INCREMENTAL), result.command)
    assertEquals(SettingsField.SCAN_INCREMENTAL, result.state.busy)
  }

  @Test
  fun `a varredura completa e a que ignora o cache`() {
    val result = reduceSettings(cursorAt(SettingsField.SCAN_FULL), SettingsEvent.Select, settings)
    assertEquals(SettingsCommand.Scan(SCAN_MODE_FULL), result.command)
  }

  @Test
  fun `as duas linhas de capa se distinguem pelo reset`() {
    assertEquals(
      SettingsCommand.RefreshMetadata(reset = false),
      reduceSettings(cursorAt(SettingsField.REFRESH_METADATA), SettingsEvent.Select, settings)
        .command,
    )
    assertEquals(
      SettingsCommand.RefreshMetadata(reset = true),
      reduceSettings(cursorAt(SettingsField.REFRESH_METADATA_RESET), SettingsEvent.Select, settings)
        .command,
    )
  }

  @Test
  fun `a seta numa acao nao gasta rede`() {
    val row = cursorAt(SettingsField.SCAN_FULL)
    assertNull(reduceSettings(row, SettingsEvent.Right, settings).command)
    assertNull(reduceSettings(row, SettingsEvent.Left, settings).command)
  }

  @Test
  fun `linha ocupada nao aceita outro comando`() {
    val busy = cursorAt(SettingsField.SCAN_FULL).copy(busy = SettingsField.SCAN_FULL)
    assertNull(reduceSettings(busy, SettingsEvent.Select, settings).command)
  }

  @Test
  fun `ocupado ainda deixa andar, para ver o resto da tela`() {
    val busy = SettingsUiState(busy = SettingsField.SCAN_FULL)
    assertEquals(1, reduceSettings(busy, SettingsEvent.Down, settings).state.cursor)
  }

  // Valor aplicado antes da resposta

  @Test
  fun `o valor otimista muda so o campo da linha`() {
    val next = applySettingsValue(
      settings.copy(audioLang = "por"),
      SettingsField.SUBTITLE_LANG,
      SettingsValue.Text(null),
    )
    assertEquals("por", next.audioLang)
    assertNull(next.subtitleLang)
  }

  // Texto das linhas

  @Test
  fun `toda linha tem rotulo e valor`() {
    for (row in rows) {
      assertTrue(settingsRowLabel(row.field).isNotBlank())
      assertTrue(settingsRowValue(row.field, settings).isNotBlank())
    }
  }

  @Test
  fun `a linha de idioma nunca fica vazia`() {
    assertEquals("Padrão do arquivo", settingsRowValue(SettingsField.AUDIO_LANG, settings))
    assertEquals("Desativadas", settingsRowValue(SettingsField.SUBTITLE_LANG, settings))
    assertEquals(
      "Portugues",
      settingsRowValue(SettingsField.AUDIO_LANG, settings.copy(audioLang = "por")),
    )
  }

  @Test
  fun `a varredura diaria desligada diz que esta desligada`() {
    assertEquals("Desligada", settingsRowValue(SettingsField.RESCAN_TIME, settings))
    assertEquals(
      "03:30",
      settingsRowValue(SettingsField.RESCAN_TIME, settings.copy(rescanTime = "03:30")),
    )
  }

  @Test
  fun `o estado do TMDB e so leitura e aparece nas duas formas`() {
    assertEquals("Sem chave do TMDB", settingsRowValue(SettingsField.TMDB_STATUS, settings))
    assertEquals(
      "TMDB configurado",
      settingsRowValue(SettingsField.TMDB_STATUS, settings.copy(tmdbConfigured = true)),
    )
  }

  // Estado da biblioteca

  @Test
  fun `parada, a varredura nao tem progresso a mostrar`() {
    assertNull(scanProgressText(idle()))
    assertNull(scanProgressPercent(idle()))
  }

  @Test
  fun `rodando, o progresso traz a contagem e a serie`() {
    val status = LibraryStatus(
      scan = ScanTask(
        state = TASK_RUNNING,
        progress = ScanProgressRef(done = 1240, total = 14320, show = "The Simpsons"),
        startedAt = 1L,
      ),
    )
    assertEquals("1240 de 14320 — The Simpsons", scanProgressText(status))
    assertEquals(8, scanProgressPercent(status))
  }

  @Test
  fun `rodada recem-disparada avisa que esta preparando`() {
    val status = LibraryStatus(scan = ScanTask(state = TASK_RUNNING, startedAt = 1L))
    assertEquals("Preparando a varredura…", scanProgressText(status))
    // Sem total nao ha fracao: a barra some em vez de fingir 0%.
    assertNull(scanProgressPercent(status))
  }

  @Test
  fun `sem nenhuma rodada terminada nao ha resumo`() {
    assertNull(scanSummaryText(idle()))
    assertNull(metadataText(idle()))
  }

  @Test
  fun `o resumo conta series, episodios e o tempo gasto`() {
    val status = LibraryStatus(
      scan = ScanTask(
        last = ScanSummary(
          shows = 12,
          episodes = 340,
          probed = 40,
          cached = 300,
          durationMs = 192_000,
        ),
      ),
    )
    assertEquals(
      "Última varredura: 12 séries, 340 episódios · 40 analisados, 300 do cache · em 3 min 12 s",
      scanSummaryText(status),
    )
  }

  @Test
  fun `o que sumiu e o que falhou so aparecem quando existem`() {
    val summary = ScanSummary(shows = 1, episodes = 1, removedShows = 2, failed = 3)
    val text = scanSummaryText(LibraryStatus(scan = ScanTask(last = summary)))
    assertTrue(text!!.contains("2 séries e 0 episódios fora do acervo"))
    assertTrue(text.contains("3 arquivos falharam"))
    assertTrue(text.contains("1 série, 1 episódio"))
  }

  @Test
  fun `rodada que morreu no meio mostra o motivo, e mais nada`() {
    val status = LibraryStatus(
      scan = ScanTask(
        state = TASK_IDLE,
        last = ScanSummary(shows = 9, episodes = 9, error = "EACCES /media"),
      ),
    )
    assertEquals("A última varredura falhou: EACCES /media", scanSummaryText(status))
  }

  @Test
  fun `a busca de capas rodando ganha a frente do resumo antigo`() {
    val status = LibraryStatus(
      metadata = MetadataTask(state = TASK_RUNNING, last = MetadataSummary(considered = 9)),
    )
    assertEquals("Buscando capas e sinopses…", metadataText(status))
  }

  @Test
  fun `o resumo das capas conta o que foi identificado`() {
    val status = LibraryStatus(
      metadata = MetadataTask(
        last = MetadataSummary(considered = 20, found = 18, posters = 17, notFound = 2),
      ),
    )
    assertEquals(
      "Última busca de capas: 18 de 20 identificadas · 17 capas baixadas · 2 sem resultado",
      metadataText(status),
    )
  }

  // Polling

  @Test
  fun `so scan e capas mantem a tela perguntando`() {
    assertTrue(libraryBusy(LibraryStatus(scan = ScanTask(state = TASK_RUNNING))))
    assertTrue(libraryBusy(LibraryStatus(metadata = MetadataTask(state = TASK_RUNNING))))
    assertFalse(libraryBusy(idle()))
    // O remux roda sozinho por horas e nao tem nada desenhado na tela: manter o
    // loop vivo por causa dele seria bater na API a tarde inteira de graca.
    assertFalse(libraryBusy(LibraryStatus(remux = RemuxTask(state = TASK_RUNNING))))
  }
}
