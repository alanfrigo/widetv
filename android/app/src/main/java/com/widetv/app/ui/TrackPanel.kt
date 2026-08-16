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
 *
 * `detail` e `tag` entram DEPOIS de `selected`, e com default, para os testes e
 * as chamadas que so precisam do rotulo continuarem valendo: sao adorno da
 * linha, nao decisao.
 */
data class TrackOption(
  val id: String,
  val label: String,
  val selected: Boolean = false,
  /** Segunda linha da linha de trilha: "eac3 · 5.1 · faixa 1". */
  val detail: String? = null,
  /** Etiqueta a direita quando a faixa NAO e a escolhida, ex. "padrão". */
  val tag: String? = null,
)

data class TrackPanelState(
  val open: Boolean = false,
  val audio: List<TrackOption> = emptyList(),
  /** Ja inclui "Desativadas" na primeira posicao; o reducer a insere ao abrir. */
  val text: List<TrackOption> = emptyList(),
  /** Indice em `rows(state)`. Aponta para uma opcao ou para a linha de lembrar; nunca cabecalho. */
  val cursor: Int = 0,
  /** Interruptor de "Lembrar este idioma": gravar a escolha no servidor ou nao. */
  val remember: Boolean = true,
)

/** Linha desenhada no painel. Cabecalho nunca recebe o cursor. */
sealed interface TrackRow {
  data class Header(val kind: TrackKind) : TrackRow

  data class Option(val kind: TrackKind, val option: TrackOption) : TrackRow

  /**
   * "Lembrar este idioma", sempre a ULTIMA linha. Entra no cursor porque o
   * controle do Google TV nao tem MENU: sem uma linha alcancavel pela seta, o
   * interruptor ficaria inalcancavel na maioria das salas.
   */
  data class Remember(val on: Boolean) : TrackRow
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
    /** Estado atual do interruptor de lembrar, que sobrevive ao painel fechado. */
    val remember: Boolean = true,
  ) : TrackPanelEvent

  /** +1 desce, -1 sobe. Cabecalhos sao pulados. */
  data class Move(val delta: Int) : TrackPanelEvent

  /**
   * Aba do segmented control. Leva o cursor para a PRIMEIRA linha da secao — o
   * painel continua sendo uma lista so, com as duas secoes sempre visiveis, e a
   * aba e um atalho para o comeco de uma delas.
   */
  data class Tab(val kind: TrackKind) : TrackPanelEvent

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
  /** true quando o OK caiu na linha de lembrar: a Activity sincroniza o dela. */
  val toggleRemember: Boolean = false,
)

/**
 * Linhas na ordem em que aparecem. Secao sem nenhuma opcao nao ganha cabecalho:
 * um titulo "AUDIO" sozinho so ocuparia espaco dizendo que nao ha o que fazer.
 * "Lembrar este idioma" fecha a lista — e so existe quando ha o que lembrar.
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
  if (out.isNotEmpty()) out += TrackRow.Remember(state.remember)
  return out
}

/**
 * Qual aba do segmented control esta marcada: a secao onde o cursor esta.
 *
 * Derivada, e nao guardada no estado, porque so ha uma verdade — descer da
 * ultima linha de audio para a primeira legenda TEM que acender a outra aba, e
 * um campo separado abriria a chance de ele discordar do cursor.
 *
 * Na linha de lembrar vale a secao de onde o cursor veio — a opcao mais proxima
 * ACIMA — porque apagar as duas abas faria o segmented control piscar so de o
 * cursor chegar ao rodape.
 *
 * @return AUDIO como padrao quando o painel esta fechado ou vazio: e a secao que
 *   sempre existe primeiro.
 */
fun activeTab(state: TrackPanelState): TrackKind {
  val rows = rows(state)
  for (at in minOf(state.cursor, rows.lastIndex) downTo 0) {
    val row = rows[at]
    if (row is TrackRow.Option) return row.kind
  }
  return TrackKind.AUDIO
}

fun reduceTrackPanel(state: TrackPanelState, event: TrackPanelEvent): TrackPanelResult =
  when (event) {
    is TrackPanelEvent.Open -> open(event)
    is TrackPanelEvent.Move -> move(state, event.delta)
    is TrackPanelEvent.Tab -> tab(state, event.kind)
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

  val opened = TrackPanelState(
    open = true,
    audio = event.audio,
    text = text,
    remember = event.remember,
  )
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

  // So o cabecalho e pulado: opcoes e a linha de lembrar recebem o cursor.
  var at = state.cursor + delta
  while (at in rows.indices && rows[at] is TrackRow.Header) at += delta
  // Bateu na borda: fica onde estava. Dar a volta faria a seta para baixo
  // saltar do fim das legendas para o topo do audio sem aviso nenhum.
  if (at !in rows.indices) return TrackPanelResult(state)
  return TrackPanelResult(state.copy(cursor = at))
}

/**
 * Aba escolhida: o cursor pula para a primeira linha daquela secao.
 *
 * Secao que nao existe (episodio sem legenda) nao move nada — a aba fica sem
 * efeito em vez de jogar o cursor num lugar que nao ha.
 */
private fun tab(state: TrackPanelState, kind: TrackKind): TrackPanelResult {
  if (!state.open) return TrackPanelResult(state)
  val at = rows(state).indexOfFirst { it is TrackRow.Option && it.kind == kind }
  if (at < 0) return TrackPanelResult(state)
  return TrackPanelResult(state.copy(cursor = at))
}

private fun select(state: TrackPanelState): TrackPanelResult {
  if (!state.open) return TrackPanelResult(state)
  return when (val row = rows(state).getOrNull(state.cursor)) {
    is TrackRow.Option -> {
      // A marca muda na hora, dentro da secao escolhida: esperar o player
      // confirmar deixaria o tique atrasado em relacao ao que ja esta soando.
      val marked = when (row.kind) {
        TrackKind.AUDIO -> state.copy(audio = mark(state.audio, row.option.id))
        TrackKind.TEXT -> state.copy(text = mark(state.text, row.option.id))
      }
      TrackPanelResult(marked, choose = TrackChoice(row.kind, row.option.id))
    }

    // OK na linha de lembrar alterna o interruptor SEM fechar: mudar de ideia
    // sobre gravar nao encerra a visita ao painel.
    is TrackRow.Remember ->
      TrackPanelResult(state.copy(remember = !state.remember), toggleRemember = true)

    else -> TrackPanelResult(state)
  }
}

private fun mark(options: List<TrackOption>, id: String): List<TrackOption> =
  options.map { it.copy(selected = it.id == id) }

/**
 * Nota do rodape do painel.
 *
 * Ela muda com o interruptor porque a frase e a unica coisa que explica a
 * diferenca: gravar no servidor vale para a casa toda, e nao gravar vale so ate
 * o proximo episodio. Escrever uma frase so, com a outra metade implicita,
 * deixaria metade das sessoes com o texto errado na tela.
 */
fun panelNote(remember: Boolean): String = if (remember) {
  "A escolha vale para a casa toda: fica gravada no servidor. " +
    "↑ ↓ escolhem · OK confirma · ← → trocam de aba · OK alterna o lembrar."
} else {
  "A escolha vale só nesta sessão. " +
    "↑ ↓ escolhem · OK confirma · ← → trocam de aba · OK alterna o lembrar."
}

/* --- detalhe da linha ----------------------------------------------------- */

/**
 * Segunda linha da linha de trilha: "eac3 · 5.1 · faixa 1".
 *
 * Existe porque duas faixas do mesmo idioma sao comuns num acervo caseiro
 * (dublagem estereo e dublagem 5.1), e sem o detalhe as duas linhas ficariam
 * escritas exatamente igual.
 *
 * @param mimeType `Format.sampleMimeType`, ex. "audio/eac3".
 * @param channelCount `Format.channelCount`; `Format.NO_VALUE` (-1) some.
 * @param index posicao da faixa entre as do mesmo tipo, 0-based.
 */
fun formatTrackDetail(mimeType: String?, channelCount: Int, index: Int): String {
  val parts = mutableListOf<String>()
  formatCodec(mimeType)?.let { parts += it }
  formatChannelLayout(channelCount)?.let { parts += it }
  parts += "faixa ${index + 1}"
  return parts.joinToString(DOT)
}

/** "audio/eac3" vira "eac3". @return null quando nao ha o que mostrar. */
fun formatCodec(mimeType: String?): String? {
  val codec = mimeType?.substringAfterLast('/')?.trim()?.lowercase(Locale.ROOT)
  return if (codec.isNullOrEmpty()) null else codec
}

/**
 * Arranjo dos canais em palavra de gente: "5.1" e "estereo" dizem mais do que
 * "6 canais" para quem escolhe dublagem.
 */
fun formatChannelLayout(count: Int): String? = when {
  count <= 0 -> null
  count == 1 -> "mono"
  count == 2 -> "estéreo"
  count == 6 -> "5.1"
  count == 8 -> "7.1"
  else -> "$count canais"
}

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
