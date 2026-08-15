package com.widetv.app.ui

import java.util.Locale

/**
 * Painel de audio e legenda, aberto com OK durante a reproducao.
 *
 * Reducer puro: o cursor, o que cada seta faz e qual linha esta marcada moram
 * aqui. O ExoPlayer nao entra — as opcoes chegam como `TrackOption` opacas e o
 * `id` volta para a Activity, que o traduz de novo em `Tracks.Group`.
 *
 * O cursor e do reducer, e nao do sistema de foco do Android, porque o painel
 * mistura cabecalhos com linhas escolhiveis: com foco nativo, VOLTAR e as setas
 * teriam que disputar com o RecyclerView quem anda na lista.
 */

enum class TrackKind { AUDIO, TEXT }

/** `id` das legendas desligadas. Nunca colide: o id real vem do indice do grupo. */
const val TRACK_OFF = "off"

/**
 * Uma escolha possivel. `id` e opaco para o reducer — quem o cria e quem o le e
 * a Activity.
 */
data class TrackOption(
  val id: String,
  val label: String,
  val selected: Boolean,
)

data class TrackPanelState(
  val open: Boolean = false,
  val audio: List<TrackOption> = emptyList(),
  /** Ja inclui "Desativadas" na primeira posicao; o reducer a insere ao abrir. */
  val text: List<TrackOption> = emptyList(),
  /** Indice em `rows(state)`. Sempre aponta para uma linha escolhivel. */
  val cursor: Int = 0,
)

/** Linha desenhada no painel. Cabecalho nunca recebe o cursor. */
sealed interface TrackRow {
  data class Header(val kind: TrackKind) : TrackRow

  data class Option(val kind: TrackKind, val option: TrackOption) : TrackRow
}

sealed interface TrackPanelEvent {
  /**
   * @param audio grupos de audio de `player.currentTracks`, ja rotulados.
   * @param text grupos de legenda, SEM a linha de desligar.
   * @param offLabel rotulo de "Desativadas", que vem de `strings.xml`. Entra por
   *   parametro para o reducer continuar sem depender de recursos.
   */
  data class Open(
    val audio: List<TrackOption>,
    val text: List<TrackOption>,
    val offLabel: String,
  ) : TrackPanelEvent

  /** +1 desce, -1 sobe. Cabecalhos sao pulados. */
  data class Move(val delta: Int) : TrackPanelEvent

  data object Select : TrackPanelEvent

  data object Close : TrackPanelEvent
}

/** O que a Activity tem que mandar para o player. */
data class TrackChoice(
  val kind: TrackKind,
  /** `TRACK_OFF` significa desligar as legendas. */
  val id: String,
)

data class TrackPanelResult(
  val state: TrackPanelState,
  val choose: TrackChoice? = null,
  /** true quando o painel tem que sair da frente. */
  val close: Boolean = false,
)

/**
 * Linhas na ordem em que aparecem. Secao sem nenhuma opcao nao ganha cabecalho:
 * um titulo "AUDIO" sozinho so ocuparia espaco dizendo que nao ha o que fazer.
 */
fun rows(state: TrackPanelState): List<TrackRow> {
  val out = mutableListOf<TrackRow>()
  if (state.audio.isNotEmpty()) {
    out += TrackRow.Header(TrackKind.AUDIO)
    state.audio.forEach { out += TrackRow.Option(TrackKind.AUDIO, it) }
  }
  if (state.text.isNotEmpty()) {
    out += TrackRow.Header(TrackKind.TEXT)
    state.text.forEach { out += TrackRow.Option(TrackKind.TEXT, it) }
  }
  return out
}

fun reduceTrackPanel(state: TrackPanelState, event: TrackPanelEvent): TrackPanelResult =
  when (event) {
    is TrackPanelEvent.Open -> open(event)
    is TrackPanelEvent.Move -> move(state, event.delta)
    TrackPanelEvent.Select -> select(state)
    TrackPanelEvent.Close -> TrackPanelResult(TrackPanelState(), close = true)
  }

private fun open(event: TrackPanelEvent.Open): TrackPanelResult {
  // "Desativadas" so entra quando ha legenda para desativar. Sem nenhuma faixa
  // de texto, a secao inteira desaparece.
  val text = if (event.text.isEmpty()) {
    emptyList()
  } else {
    listOf(TrackOption(TRACK_OFF, event.offLabel, event.text.none { it.selected })) + event.text
  }

  val opened = TrackPanelState(open = true, audio = event.audio, text = text)
  // Abre no que esta tocando: procurar a propria selecao com as setas seria
  // trabalho que o painel ja podia ter feito.
  val rows = rows(opened)
  val at = rows.indexOfFirst { it is TrackRow.Option && it.option.selected }
  val first = rows.indexOfFirst { it is TrackRow.Option }
  return TrackPanelResult(opened.copy(cursor = if (at >= 0) at else maxOf(0, first)))
}

private fun move(state: TrackPanelState, delta: Int): TrackPanelResult {
  if (!state.open || delta == 0) return TrackPanelResult(state)
  val rows = rows(state)

  var at = state.cursor + delta
  while (at in rows.indices && rows[at] !is TrackRow.Option) at += delta
  // Bateu na borda: fica onde estava. Dar a volta faria a seta para baixo
  // saltar do fim das legendas para o topo do audio sem aviso nenhum.
  if (at !in rows.indices) return TrackPanelResult(state)
  return TrackPanelResult(state.copy(cursor = at))
}

private fun select(state: TrackPanelState): TrackPanelResult {
  if (!state.open) return TrackPanelResult(state)
  val row = rows(state).getOrNull(state.cursor) as? TrackRow.Option
    ?: return TrackPanelResult(state)

  // A marca muda na hora, dentro da secao escolhida: esperar o player confirmar
  // deixaria o tique atrasado em relacao ao que ja esta soando.
  val marked = when (row.kind) {
    TrackKind.AUDIO -> state.copy(audio = mark(state.audio, row.option.id))
    TrackKind.TEXT -> state.copy(text = mark(state.text, row.option.id))
  }
  return TrackPanelResult(marked, choose = TrackChoice(row.kind, row.option.id))
}

private fun mark(options: List<TrackOption>, id: String): List<TrackOption> =
  options.map { it.copy(selected = it.id == id) }

/**
 * Nome do idioma de uma trilha, para quando o container nao trouxe `title`.
 *
 * A tabela existe porque `Locale` nao resolve as tags de tres letras que o
 * Matroska usa ("por", "eng"), e porque um "POR" cru na tela nao ajuda ninguem
 * a escolher a dublagem.
 *
 * @return null quando o codigo nao diz nada — inclusive "und", que e o rotulo
 *   que o Media3 poe quando a faixa nao esta marcada.
 */
fun languageLabel(code: String?): String? {
  val normalized = code?.trim()?.lowercase(Locale.ROOT)?.substringBefore('-')
  if (normalized.isNullOrEmpty() || normalized == "und" || normalized == "mul") return null
  return LANGUAGES[normalized] ?: normalized.uppercase(Locale.ROOT)
}

/**
 * Idiomas que aparecem num acervo caseiro. Cobre as duas tags (ISO 639-1 e
 * 639-2) porque o Media3 normaliza para a de duas letras, mas o servidor le a de
 * tres direto do container.
 */
private val LANGUAGES: Map<String, String> = mapOf(
  "pt" to "Portugues", "por" to "Portugues", "pob" to "Portugues (BR)",
  "en" to "English", "eng" to "English",
  "es" to "Espanol", "spa" to "Espanol",
  "ja" to "Japones", "jpn" to "Japones",
  "fr" to "Frances", "fre" to "Frances", "fra" to "Frances",
  "de" to "Alemao", "ger" to "Alemao", "deu" to "Alemao",
  "it" to "Italiano", "ita" to "Italiano",
  "ko" to "Coreano", "kor" to "Coreano",
  "zh" to "Chines", "chi" to "Chines", "zho" to "Chines",
  "ru" to "Russo", "rus" to "Russo",
)
