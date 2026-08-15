package com.widetv.app.ui

import com.widetv.app.net.AppSettings
import com.widetv.app.net.LibraryStatus
import com.widetv.app.net.SCAN_MODE_FULL
import com.widetv.app.net.SCAN_MODE_INCREMENTAL
import com.widetv.app.net.TASK_RUNNING
import java.util.Locale

/**
 * Tela de configuracoes: o cursor, o valor que a seta escolhe e o texto que
 * cada linha mostra. Porte de `src/web/settings.ts`, com a mesma divisao — aqui
 * so ha decisao pura, e quem fala com a rede e a Activity.
 *
 * O modelo mental e o do controle remoto: cima e baixo escolhem a LINHA,
 * esquerda e direita mudam o VALOR dela, OK dispara o que e acao. Uma tecla so
 * nunca faz duas coisas diferentes dependendo da linha.
 *
 * A verdade dos valores mora no SERVIDOR: o reducer recebe o `AppSettings`
 * atual a cada evento em vez de guardar copia. Guardar copia faria a tela
 * mentir quando o PATCH falhasse — e um PATCH pode falhar.
 *
 * Este arquivo nao conhece JSON de proposito, mesmo sendo o PATCH um corpo
 * JSON: o comando sai daqui como `SettingsValue`, e a traducao para
 * `SettingsPatch` acontece na Activity. E a mesma ideia do painel de trilhas,
 * que devolve um `id` opaco em vez de um `Tracks.Group`.
 */

enum class SettingsField {
  AUDIO_LANG,
  SUBTITLE_LANG,
  SUBTITLES_AUTO,
  RESCAN_TIME,
  AUTO_REMUX,
  AUTO_THUMBS,
  SMART_GROUPING,
  SCAN_INCREMENTAL,
  SCAN_FULL,
  REFRESH_METADATA,
  REFRESH_METADATA_RESET,
  GENERATE_THUMBS,
  TMDB_STATUS,
}

enum class SettingsKind {
  /** Lista fechada de valores; a seta anda por ela. */
  CHOICE,

  TOGGLE,

  /** `HH:MM` de meia em meia hora, com o desligado dentro do ciclo. */
  TIME,

  /** Dispara trabalho no servidor. So o OK gasta rede. */
  ACTION,

  /** So informa. O cursor nunca para aqui. */
  INFO,
}

/**
 * Em qual das duas listas da tela a linha e desenhada.
 *
 * SO renderizacao: o cursor continua sendo UM so, percorrendo as duas na ordem
 * de `ROWS`. Dois cursores dariam duas colunas disputando a seta para baixo, e a
 * regra "cima e baixo escolhem a linha" pararia de valer no meio da tela.
 */
enum class SettingsGroup { PLAYBACK, LIBRARY }

data class SettingsRow(
  val field: SettingsField,
  val kind: SettingsKind,
  val group: SettingsGroup,
  /**
   * As setas MUDAM alguma coisa nesta linha.
   *
   * Toda linha de valor muda. Das acoes, so a geracao de quadros: nela ← →
   * escolhem entre completar o que falta e refazer tudo. As varreduras e as
   * rebuscas de capa nao tem valor nenhum para percorrer, e desenhar a seta
   * esquerda nelas seria prometer um gesto que nao existe. Quem sabe se a seta
   * faz algo e o reducer — a mesma regra do `set--stepper` do cliente web.
   */
  val stepper: Boolean = true,
)

/**
 * Ordem das linhas. Acoes de manutencao no fim: sao as caras.
 *
 * Os grupos sao CONTIGUOS de proposito — reproducao primeiro, biblioteca
 * depois. E o que deixa o cursor unico atravessar as duas listas desenhadas sem
 * saltar de uma para a outra e voltar.
 *
 * O estado do TMDB fica encostado nas duas linhas de capa porque e ali que ele
 * explica alguma coisa — rebuscar capa sem chave do provedor traz menos do que
 * quem apertou esperava, e a linha diz isso antes de o dedo chegar la.
 */
private val ROWS: List<SettingsRow> = listOf(
  SettingsRow(SettingsField.AUDIO_LANG, SettingsKind.CHOICE, SettingsGroup.PLAYBACK),
  SettingsRow(SettingsField.SUBTITLE_LANG, SettingsKind.CHOICE, SettingsGroup.PLAYBACK),
  SettingsRow(SettingsField.SUBTITLES_AUTO, SettingsKind.TOGGLE, SettingsGroup.PLAYBACK),
  SettingsRow(SettingsField.SMART_GROUPING, SettingsKind.TOGGLE, SettingsGroup.LIBRARY),
  SettingsRow(SettingsField.AUTO_REMUX, SettingsKind.TOGGLE, SettingsGroup.LIBRARY),
  SettingsRow(SettingsField.AUTO_THUMBS, SettingsKind.TOGGLE, SettingsGroup.LIBRARY),
  SettingsRow(SettingsField.RESCAN_TIME, SettingsKind.TIME, SettingsGroup.LIBRARY),
  SettingsRow(
    SettingsField.SCAN_INCREMENTAL,
    SettingsKind.ACTION,
    SettingsGroup.LIBRARY,
    stepper = false,
  ),
  SettingsRow(SettingsField.SCAN_FULL, SettingsKind.ACTION, SettingsGroup.LIBRARY, stepper = false),
  SettingsRow(SettingsField.TMDB_STATUS, SettingsKind.INFO, SettingsGroup.LIBRARY, stepper = false),
  SettingsRow(
    SettingsField.REFRESH_METADATA,
    SettingsKind.ACTION,
    SettingsGroup.LIBRARY,
    stepper = false,
  ),
  SettingsRow(
    SettingsField.REFRESH_METADATA_RESET,
    SettingsKind.ACTION,
    SettingsGroup.LIBRARY,
    stepper = false,
  ),
  // Ultima porque e a mais cara de todas: um ffmpeg por episodio, com a fila
  // andando de um em um para nao competir com o video que a TV esta streamando.
  SettingsRow(SettingsField.GENERATE_THUMBS, SettingsKind.ACTION, SettingsGroup.LIBRARY),
)

fun settingsRows(): List<SettingsRow> = ROWS

/** As linhas de uma lista da tela, na ordem em que o cursor as visita. */
fun settingsRows(group: SettingsGroup): List<SettingsRow> = ROWS.filter { it.group == group }

/**
 * Posicao, no cursor unico, da primeira linha do grupo.
 *
 * E o que traduz o cursor global em posicao dentro de um dos dois
 * `RecyclerView`: `cursor - settingsGroupStart(g)`. Funciona porque os grupos
 * sao contiguos em `ROWS` — e ha teste para isso.
 */
fun settingsGroupStart(group: SettingsGroup): Int = ROWS.indexOfFirst { it.group == group }

data class SettingsUiState(
  /** Indice em `settingsRows()`. Nunca aponta para uma linha `INFO`. */
  val cursor: Int = 0,
  /**
   * Linha esperando a rede. So as acoes marcam: elas sao caras, e disparar duas
   * varreduras porque o OK repetiu custa minutos de servidor. Quem limpa e a
   * Activity, quando o POST responde — nao quando o scan acaba.
   */
  val busy: SettingsField? = null,
  val message: String? = null,
  /**
   * Modo da geracao de quadros, escolhido com as setas na propria linha da acao.
   *
   * Mora no estado da TELA e nao em `AppSettings` porque nao e preferencia
   * gravada: e a diferenca entre completar o que falta (barato, e o que a fila
   * ja faz sozinha) e refazer tudo, que e o que conserta quadro preto depois de
   * o arquivo ser trocado.
   */
  val thumbsReset: Boolean = false,
)

sealed interface SettingsEvent {
  data object Up : SettingsEvent

  data object Down : SettingsEvent

  data object Left : SettingsEvent

  data object Right : SettingsEvent

  data object Select : SettingsEvent
}

/** Valor novo de uma linha editavel, sem saber que do outro lado ha JSON. */
sealed interface SettingsValue {
  /** Idioma canonico ou `HH:MM`; null e "sem preferencia" / "desligado". */
  data class Text(val value: String?) : SettingsValue

  data class Flag(val value: Boolean) : SettingsValue
}

sealed interface SettingsCommand {
  data class Patch(val field: SettingsField, val value: SettingsValue) : SettingsCommand

  /** @param mode `SCAN_MODE_INCREMENTAL` ou `SCAN_MODE_FULL`. */
  data class Scan(val mode: String) : SettingsCommand

  data class RefreshMetadata(val reset: Boolean) : SettingsCommand

  /** @param reset refaz o quadro de quem ja tem, em vez de so completar. */
  data class GenerateThumbs(val reset: Boolean) : SettingsCommand
}

data class SettingsResult(
  val state: SettingsUiState,
  val command: SettingsCommand? = null,
)

fun reduceSettings(
  state: SettingsUiState,
  event: SettingsEvent,
  settings: AppSettings,
): SettingsResult {
  if (event == SettingsEvent.Up) return SettingsResult(move(state, -1))
  if (event == SettingsEvent.Down) return SettingsResult(move(state, 1))

  val row = ROWS.getOrNull(state.cursor) ?: return SettingsResult(state)
  // Enquanto a rede nao respondeu, a tela nao aceita outro comando.
  if (state.busy != null) return SettingsResult(state)

  // OK numa linha de valor avanca, como a seta direita: numa TV, apertar OK na
  // linha destacada e o gesto mais natural que existe.
  val delta = if (event == SettingsEvent.Left) -1 else 1

  return when (row.kind) {
    SettingsKind.CHOICE -> {
      val current = canonicalLang(
        if (row.field == SettingsField.AUDIO_LANG) settings.audioLang else settings.subtitleLang,
      )
      val next = stepLanguage(current, delta)
      if (next == current) SettingsResult(state)
      else fired(state, SettingsCommand.Patch(row.field, SettingsValue.Text(next)))
    }

    SettingsKind.TIME -> {
      val next = stepRescanTime(settings.rescanTime, delta)
      if (next == settings.rescanTime) SettingsResult(state)
      else fired(state, SettingsCommand.Patch(row.field, SettingsValue.Text(next)))
    }

    SettingsKind.TOGGLE -> {
      val current = toggleOf(row.field, settings)
      // A seta escolhe o LADO (direita liga, esquerda desliga) e nao repete o
      // PATCH quando o valor ja esta la; o OK alterna. Seta que alternasse
      // faria apertar duas vezes para a direita voltar ao ponto de partida.
      val next = if (event == SettingsEvent.Select) !current else event == SettingsEvent.Right
      if (next == current) SettingsResult(state)
      else fired(state, SettingsCommand.Patch(row.field, SettingsValue.Flag(next)))
    }

    SettingsKind.ACTION -> {
      // Acao com modo: a seta escolhe o LADO (direita refaz tudo, esquerda so
      // completa) sem gastar rede nenhuma; quem dispara continua sendo o OK.
      // Duas linhas separadas, como as capas fazem, custariam mais uma parada do
      // cursor numa lista que ja e a mais longa da tela.
      if (row.field == SettingsField.GENERATE_THUMBS && event != SettingsEvent.Select) {
        val reset = event == SettingsEvent.Right
        val next = if (reset == state.thumbsReset) state else state.copy(thumbsReset = reset)
        return SettingsResult(next)
      }

      val command = if (event == SettingsEvent.Select) commandOf(row.field, state) else null
      if (command == null) SettingsResult(state)
      else SettingsResult(state.copy(busy = row.field, message = null), command)
    }

    // Inalcancavel pelo cursor; o ramo existe para o `when` ser exaustivo.
    SettingsKind.INFO -> SettingsResult(state)
  }
}

private fun move(state: SettingsUiState, delta: Int): SettingsUiState {
  var at = state.cursor + delta
  // Linha de informacao nunca recebe o cursor — mesma regra dos cabecalhos do
  // painel de trilhas, e pela mesma razao: parar num rotulo que nao faz nada
  // custa uma tecla a mais para nada.
  while (at in ROWS.indices && ROWS[at].kind == SettingsKind.INFO) at += delta
  // Bateu na borda: fica onde estava. Dar a volta faria a seta para baixo
  // saltar do fim das acoes para o topo dos idiomas sem aviso nenhum.
  if (at !in ROWS.indices) return state
  // A mensagem sai quando o dedo anda: ela falava da linha anterior.
  return state.copy(cursor = at, message = null)
}

/** Comando emitido: a mensagem antiga sai da tela agora, o resultado chega depois. */
private fun fired(state: SettingsUiState, command: SettingsCommand): SettingsResult =
  SettingsResult(state.copy(message = null), command)

private fun commandOf(field: SettingsField, state: SettingsUiState): SettingsCommand? =
  when (field) {
    SettingsField.SCAN_INCREMENTAL -> SettingsCommand.Scan(SCAN_MODE_INCREMENTAL)
    SettingsField.SCAN_FULL -> SettingsCommand.Scan(SCAN_MODE_FULL)
    SettingsField.REFRESH_METADATA -> SettingsCommand.RefreshMetadata(reset = false)
    SettingsField.REFRESH_METADATA_RESET -> SettingsCommand.RefreshMetadata(reset = true)
    SettingsField.GENERATE_THUMBS -> SettingsCommand.GenerateThumbs(state.thumbsReset)
    else -> null
  }

private fun toggleOf(field: SettingsField, settings: AppSettings): Boolean = when (field) {
  SettingsField.SUBTITLES_AUTO -> settings.subtitlesAuto
  SettingsField.AUTO_REMUX -> settings.autoRemux
  SettingsField.AUTO_THUMBS -> settings.autoThumbs
  SettingsField.SMART_GROUPING -> settings.smartGrouping
  else -> false
}

/**
 * Valor aplicado na tela ANTES de o servidor responder.
 *
 * A linha muda na hora porque um round-trip inteiro entre a seta e o valor faz
 * o controle remoto parecer quebrado. Quem chama guarda o `AppSettings`
 * anterior e o repoe quando o PATCH falha: sem isso a tela ficaria mentindo.
 */
fun applySettingsValue(
  settings: AppSettings,
  field: SettingsField,
  value: SettingsValue,
): AppSettings {
  val text = (value as? SettingsValue.Text)?.value
  val flag = (value as? SettingsValue.Flag)?.value ?: false
  return when (field) {
    SettingsField.AUDIO_LANG -> settings.copy(audioLang = text)
    SettingsField.SUBTITLE_LANG -> settings.copy(subtitleLang = text)
    SettingsField.RESCAN_TIME -> settings.copy(rescanTime = text)
    SettingsField.SUBTITLES_AUTO -> settings.copy(subtitlesAuto = flag)
    SettingsField.AUTO_REMUX -> settings.copy(autoRemux = flag)
    SettingsField.AUTO_THUMBS -> settings.copy(autoThumbs = flag)
    SettingsField.SMART_GROUPING -> settings.copy(smartGrouping = flag)
    // As demais nao sao editaveis; nao ha o que aplicar.
    else -> settings
  }
}

/* --- idiomas -------------------------------------------------------------- */

/**
 * Codigos oferecidos, em ISO 639-2/B como o contrato guarda. Lista curta de
 * proposito: e a dublagem que um acervo caseiro traz de verdade, e as 180
 * linhas do ISO virariam uma eternidade de setas no controle remoto. Espelha
 * `OFFERED_LANGUAGES` de `src/web/settings.ts`; o nome legivel de cada um vem
 * de `languageLabel`, para nao existirem duas tabelas de idioma no app.
 */
private val OFFERED_LANGUAGES = listOf("por", "eng", "spa", "fre", "ger", "ita", "jpn", "kor")

/**
 * A lista que a seta percorre. null e a primeira posicao e nunca falta: no
 * audio ele e "Padrao do arquivo", na legenda e "Desativadas". Sem ele a linha
 * de legenda nao teria como voltar ao estado de fabrica.
 */
private val LANGUAGE_CYCLE: List<String?> = listOf<String?>(null) + OFFERED_LANGUAGES

/**
 * Vizinho circular na lista de idiomas.
 *
 * Idioma que o servidor tem mas a lista nao oferece (veio do `.env`) cai na
 * primeira opcao em vez de travar a seta.
 */
private fun stepLanguage(current: String?, delta: Int): String? {
  val at = LANGUAGE_CYCLE.indexOf(current)
  if (at < 0) return LANGUAGE_CYCLE.first()
  val size = LANGUAGE_CYCLE.size
  return LANGUAGE_CYCLE[((at + delta) % size + size) % size]
}

/**
 * Codigo canonico em ISO 639-2/B, que e o que o contrato guarda.
 *
 * O mesmo idioma vem marcado 'pt' num MKV e 'por' no outro, e o Media3 devolve
 * sempre a tag de duas letras: sem normalizar, a preferencia escolhida no
 * painel de trilhas so valeria para metade do acervo — e chegaria ao servidor
 * num codigo que o cliente web nao reconheceria. A regiao e descartada: quem
 * escolheu Portugues (BR) aceita (PT) antes de ficar sem legenda.
 *
 * Espelha `normalizeLang` de `src/web/tracks.ts`.
 *
 * @return null para vazio e para "und", que e o rotulo que o Media3 poe na
 *   faixa sem idioma marcado.
 */
fun canonicalLang(code: String?): String? {
  val base = code?.trim()?.lowercase(Locale.ROOT)?.replace('_', '-')?.substringBefore('-')
  if (base.isNullOrEmpty() || base == "und" || base == "mul") return null
  return LANGUAGE_CANON[base] ?: base
}

/** ISO 639-1 e as variantes 639-2/T apontando para a forma bibliografica. */
private val LANGUAGE_CANON: Map<String, String> = mapOf(
  "pt" to "por", "pob" to "por",
  "en" to "eng",
  "es" to "spa",
  "fr" to "fre", "fra" to "fre",
  "de" to "ger", "deu" to "ger",
  "it" to "ita",
  "ja" to "jpn",
  "ko" to "kor",
  "zh" to "chi", "zho" to "chi",
  "ru" to "rus",
)

/* --- horario do rescan ---------------------------------------------------- */

private const val SLOT_MINUTES = 30

private const val SLOTS = 24 * 60 / SLOT_MINUTES

/**
 * Proximo horario da varredura diaria ao apertar a seta; passo de 30 min.
 *
 * O desligado e uma POSICAO do ciclo, entre 23:30 e 00:00: quem esta na ponta
 * chega nele com a mesma seta que usou para chegar ate ali, sem precisar de
 * outra tecla so para desligar.
 *
 * @param delta +1 avanca meia hora, -1 volta.
 * @return `HH:MM` local, ou null quando a varredura diaria fica desligada.
 */
fun stepRescanTime(current: String?, delta: Int): String? {
  val minutes = parseTime(current)
  // Desligado (ou horario ilegivel, gravado por outra pessoa) e a ponta: a
  // proxima casa depende so do lado para onde a seta apontou.
  if (minutes == null) return formatTime(if (delta >= 0) 0 else (SLOTS - 1) * SLOT_MINUTES)

  // Horario fora da grade de meia em meia hora (veio do `.env`): a seta encosta
  // no vizinho em vez de continuar de um ponto que a lista nao tem.
  if (minutes % SLOT_MINUTES != 0) {
    val rounded = if (delta >= 0) minutes / SLOT_MINUTES + 1 else minutes / SLOT_MINUTES
    return formatTime(rounded % SLOTS * SLOT_MINUTES)
  }

  val next = minutes / SLOT_MINUTES + delta
  return if (next < 0 || next >= SLOTS) null else formatTime(next * SLOT_MINUTES)
}

/** @return minutos desde a meia-noite, ou null quando nao ha horario legivel. */
private fun parseTime(value: String?): Int? {
  val match = TIME_FORMAT.matchEntire(value?.trim().orEmpty()) ?: return null
  val hour = match.groupValues[1].toInt()
  val minute = match.groupValues[2].toInt()
  if (hour > 23 || minute > 59) return null
  return hour * 60 + minute
}

private fun formatTime(minutes: Int): String =
  String.format(Locale.ROOT, "%02d:%02d", minutes / 60 % 24, minutes % 60)

private val TIME_FORMAT = Regex("""^(\d{1,2}):(\d{2})$""")

/* --- texto da tela -------------------------------------------------------- */

/**
 * Rotulo e valor saem daqui, e nao de `strings.xml`.
 *
 * E o caminho que `Osd.kt` e `Catalog.kt` ja abriram: o texto que TEM regra
 * mora junto com a regra, e o teste JVM prova o texto inteiro em vez de provar
 * um id de recurso. `strings.xml` continua dono do que e fixo na tela — titulo,
 * dica de teclas e os avisos que a Activity escreve depois da rede responder.
 */
fun settingsRowLabel(field: SettingsField): String = when (field) {
  SettingsField.AUDIO_LANG -> "Idioma do áudio"
  SettingsField.SUBTITLE_LANG -> "Idioma da legenda"
  SettingsField.SUBTITLES_AUTO -> "Ligar legenda sozinha"
  SettingsField.SMART_GROUPING -> "Agrupar temporadas da mesma série"
  SettingsField.AUTO_REMUX -> "Converter arquivos em segundo plano"
  SettingsField.AUTO_THUMBS -> "Tirar miniaturas em segundo plano"
  SettingsField.RESCAN_TIME -> "Varredura diária"
  SettingsField.SCAN_INCREMENTAL -> "Procurar arquivos novos"
  SettingsField.SCAN_FULL -> "Reanalisar a biblioteca inteira"
  SettingsField.TMDB_STATUS -> "Provedor de capas"
  SettingsField.REFRESH_METADATA -> "Buscar capas e sinopses que faltam"
  SettingsField.REFRESH_METADATA_RESET -> "Refazer todas as capas e sinopses"
  SettingsField.GENERATE_THUMBS -> "Gerar miniaturas"
}

/**
 * Dica sob o rotulo. Diz o que a linha FAZ, nao o que ela e — quem chega ate
 * aqui ja leu o nome.
 */
fun settingsRowHint(field: SettingsField): String = when (field) {
  SettingsField.AUDIO_LANG -> "A dublagem escolhida sozinha quando o arquivo tem mais de uma."
  SettingsField.SUBTITLE_LANG -> "A legenda escolhida sozinha. Desativadas é o estado de fábrica."
  SettingsField.SUBTITLES_AUTO -> "Liga a legenda mesmo quando o áudio já está no idioma preferido."
  SettingsField.SMART_GROUPING -> "Junta pastas de release da mesma série num canal só."
  SettingsField.AUTO_REMUX -> "Converte o que a TV não toca, sem ninguém pedir."
  SettingsField.AUTO_THUMBS -> "Tira um quadro de cada episódio novo no fim da varredura."
  SettingsField.RESCAN_TIME -> "Hora local em que o servidor procura arquivos novos sozinho."
  SettingsField.SCAN_INCREMENTAL -> "Procura só o que mudou desde a última varredura."
  SettingsField.SCAN_FULL -> "Reanalisa tudo, ignorando o cache. Demora."
  SettingsField.TMDB_STATUS -> "Sem chave, as capas vêm de provedores com menos acervo."
  SettingsField.REFRESH_METADATA -> "Busca só o que ainda não tem capa nem sinopse."
  SettingsField.REFRESH_METADATA_RESET -> "Apaga o que está gravado e busca de novo. Conserta capa errada."
  SettingsField.GENERATE_THUMBS -> "← → escolhem entre completar o que falta e refazer tudo."
}

/**
 * Valor mostrado a direita da linha.
 *
 * @param thumbsReset o modo escolhido na linha de gerar miniaturas. E o unico
 *   valor da tela que NAO vem do servidor — ele mora no estado da tela —, e por
 *   isso entra como parametro solto em vez de sair do `AppSettings`.
 */
fun settingsRowValue(
  field: SettingsField,
  settings: AppSettings,
  thumbsReset: Boolean = false,
): String = when (field) {
  SettingsField.AUDIO_LANG -> languageValue(settings.audioLang, "Padrão do arquivo")
  SettingsField.SUBTITLE_LANG -> languageValue(settings.subtitleLang, "Desativadas")
  SettingsField.SUBTITLES_AUTO,
  SettingsField.AUTO_REMUX,
  SettingsField.AUTO_THUMBS,
  SettingsField.SMART_GROUPING,
  -> if (toggleOf(field, settings)) "Ligado" else "Desligado"

  SettingsField.RESCAN_TIME -> settings.rescanTime ?: "Desligada"
  SettingsField.TMDB_STATUS ->
    if (settings.tmdbConfigured) "TMDB configurado" else "Sem chave do TMDB"

  // O valor desta acao e o MODO, e nao "Iniciar": e o que a seta muda, e sem ele
  // escrito na tela ninguem sabe qual das duas coisas o OK vai fazer.
  SettingsField.GENERATE_THUMBS -> if (thumbsReset) "Refazer tudo" else "Só o que falta"

  SettingsField.SCAN_INCREMENTAL,
  SettingsField.SCAN_FULL,
  SettingsField.REFRESH_METADATA,
  SettingsField.REFRESH_METADATA_RESET,
  -> "Iniciar"
}

/** Idioma fora da lista ainda aparece com nome, so nao e alcancavel pela seta. */
private fun languageValue(lang: String?, none: String): String =
  languageLabel(canonicalLang(lang)) ?: none

/* --- estado da biblioteca ------------------------------------------------- */

/**
 * true enquanto ha alguma tarefa cujo progresso esta na tela.
 *
 * O remux fica de fora de proposito: ele roda por conta propria, pode durar
 * horas e nao tem nada desenhado aqui — perguntar de 2 em 2 segundos por causa
 * dele manteria o loop vivo a tarde inteira sem mudar um pixel.
 */
fun libraryBusy(status: LibraryStatus): Boolean =
  status.scan.state == TASK_RUNNING ||
    status.metadata.state == TASK_RUNNING ||
    // A fila de quadros entra: ela desenha progresso no mesmo cartao da
    // varredura, e num acervo grande e a mais demorada das tres — parar de
    // perguntar deixaria a barra congelada no numero em que ela estava.
    status.thumbs.state == TASK_RUNNING

/**
 * Progresso da varredura: "1240 de 14320 — The Simpsons".
 *
 * @return null quando nao ha varredura rodando.
 */
fun scanProgressText(status: LibraryStatus): String? {
  if (status.scan.state != TASK_RUNNING) return null

  // Rodada recem-disparada: dizer que esta parada seria mentira, e uma barra
  // vazia sem legenda parece tela travada.
  val progress = status.scan.progress ?: return "Preparando a varredura…"

  val head = "${progress.done} de ${progress.total}"
  return if (progress.show.isBlank()) head else "$head — ${progress.show}"
}

/**
 * Porcentagem para a barra determinada.
 *
 * @return 0..100, ou null quando nao ha o que medir — a barra some em vez de
 *   fingir 0%.
 */
fun scanProgressPercent(status: LibraryStatus): Int? {
  val progress = status.scan.progress ?: return null
  if (status.scan.state != TASK_RUNNING || progress.total <= 0) return null
  return (progress.done * 100 / progress.total).coerceIn(0, 100)
}

/** Percentual escrito no canto do cartao de varredura: "42%". */
fun scanPercentText(status: LibraryStatus): String? = percentLabel(scanProgressPercent(status))

private fun percentLabel(percent: Int?): String? = percent?.let { "$it%" }

/**
 * Progresso da fila de quadros: "312 de 1840 — The Simpsons".
 *
 * Mesma forma da varredura porque o `ScanProgressRef` e o mesmo — e a mesma
 * pergunta ("quanto falta e o que esta sendo feito agora"), so que com um
 * ffmpeg no lugar do probe.
 *
 * @return null quando a fila nao esta rodando.
 */
fun thumbsProgressText(status: LibraryStatus): String? {
  if (status.thumbs.state != TASK_RUNNING) return null

  // Fila recem-disparada: ela ainda esta contando quantos episodios estao sem
  // quadro, e uma barra vazia sem legenda parece tela travada.
  val progress = status.thumbs.progress ?: return "Preparando as miniaturas…"

  val head = "${progress.done} de ${progress.total}"
  return if (progress.show.isBlank()) head else "$head — ${progress.show}"
}

/** @return 0..100, ou null quando nao ha o que medir — a barra some. */
fun thumbsProgressPercent(status: LibraryStatus): Int? {
  val progress = status.thumbs.progress ?: return null
  if (status.thumbs.state != TASK_RUNNING || progress.total <= 0) return null
  return (progress.done * 100 / progress.total).coerceIn(0, 100)
}

/**
 * O cartao de progresso da tela, ja decidido.
 *
 * Ha UM cartao no layout e podem existir duas tarefas medindo ao mesmo tempo (a
 * varredura dispara a fila de quadros no proprio fim). A varredura tem a frente
 * porque ela e a que muda o acervo: o quadro que falta e cosmetico, o episodio
 * que ainda nao foi indexado nao esta na tela de jeito nenhum.
 */
data class TaskCard(
  val text: String,
  /** 0..100 para a barra determinada; null quando nao ha total conhecido. */
  val percent: Int? = null,
) {
  /** "42%" no canto do cartao; null quando a barra tambem sumiu. */
  val percentText: String? get() = percentLabel(percent)
}

/** @return null quando nao ha tarefa nenhuma com progresso na tela. */
fun taskCard(status: LibraryStatus): TaskCard? {
  scanProgressText(status)?.let { return TaskCard(it, scanProgressPercent(status)) }
  thumbsProgressText(status)?.let { return TaskCard(it, thumbsProgressPercent(status)) }
  return null
}

/**
 * Resumo da ultima varredura.
 *
 * @return null quando nenhuma terminou desde que o servidor subiu.
 */
fun scanSummaryText(status: LibraryStatus): String? {
  val last = status.scan.last ?: return null
  // Rodada que morreu no meio: quantas series ela achou ate ali nao interessa
  // perto do motivo de ela ter parado.
  last.error?.let { return "A última varredura falhou: $it" }

  val parts = mutableListOf(
    "${count(last.shows, "série", "séries")}, " +
      count(last.episodes, "episódio", "episódios"),
    "${last.probed} analisados, ${last.cached} do cache",
  )
  if (last.removedShows > 0 || last.removedEpisodes > 0) {
    parts += "${count(last.removedShows, "série", "séries")} e " +
      "${count(last.removedEpisodes, "episódio", "episódios")} fora do acervo"
  }
  if (last.failed > 0) parts += count(last.failed, "arquivo falhou", "arquivos falharam")
  parts += "em ${formatSpan(last.durationMs)}"

  return "Última varredura: " + parts.joinToString(DOT)
}

/**
 * Mesma ideia para a busca de capa e sinopse, com o estado atual na frente:
 * enquanto ela roda, o resumo da rodada anterior seria a informacao errada.
 *
 * @return null quando nunca houve busca e nao ha nenhuma rodando.
 */
fun metadataText(status: LibraryStatus): String? {
  if (status.metadata.state == TASK_RUNNING) return "Buscando capas e sinopses…"

  val last = status.metadata.last ?: return null
  val parts = mutableListOf(
    "${last.found} de ${last.considered} identificadas",
    count(last.posters, "capa baixada", "capas baixadas"),
  )
  if (last.notFound > 0) parts += "${last.notFound} sem resultado"
  if (last.failed > 0) parts += count(last.failed, "falha", "falhas")

  return "Última busca de capas: " + parts.joinToString(DOT)
}

private fun count(value: Int, one: String, many: String): String =
  "$value ${if (value == 1) one else many}"

/** Duracao de uma rodada em linguagem de quem espera, nunca "0.0h". */
private fun formatSpan(durationMs: Long): String {
  val seconds = if (durationMs > 0) (durationMs + 500) / 1000 else 0
  if (seconds < 60) return "$seconds s"

  val minutes = seconds / 60
  if (minutes < 60) {
    val rest = seconds % 60
    return if (rest == 0L) "$minutes min" else "$minutes min $rest s"
  }

  val hours = minutes / 60
  val rest = minutes % 60
  return if (rest == 0L) "$hours h" else "$hours h $rest min"
}
