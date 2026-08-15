package com.widetv.app.ui

import com.widetv.app.net.ChannelSummary
import com.widetv.app.net.EpisodeRef
import java.util.Locale

/**
 * Texto do OSD do player — a pilula que aparece no canto quando o episodio vira
 * ou quando alguem zapeia.
 *
 * So texto: quem desenha na tela e a Activity. Separado assim porque o formato e
 * a unica parte com regra (numeracao ausente, titulo longo) e da para testar sem
 * Android.
 */

/** Largura util da pilula em caracteres, antes de a linha comecar a estourar. */
private const val MAX_LABEL = 42

/** Separador padrao do app. Um so, em todas as linhas de metadado. */
const val DOT = " · "

fun formatChannelNumber(channel: Int): String = channel.toString().padStart(2, '0')

/**
 * Numeracao do episodio, quando existe.
 *
 * @return null quando o nome do arquivo nao trouxe numero nenhum — acervo
 *   caseiro raramente traz numeracao confiavel, e inventar uma seria pior.
 */
fun formatEpisodeCode(episode: EpisodeRef): String? {
  val season = episode.season
  val number = episode.episode

  if (season != null && number != null) {
    return "S${season.toString().padStart(2, '0')}E${number.toString().padStart(2, '0')}"
  }
  if (number != null) return "EP ${number.toString().padStart(2, '0')}"
  return null
}

/** Rotulo curto do episodio. Sem numeracao, o titulo e a saida de emergencia. */
fun formatEpisodeLabel(episode: EpisodeRef): String =
  formatEpisodeCode(episode) ?: episode.title.take(MAX_LABEL)

/**
 * Linha do episodio nos cards e no player: "S01E08 · O roubo do seculo".
 *
 * Codigo E titulo, ao contrario do `formatEpisodeLabel`, porque aqui ha largura
 * para os dois — e o codigo sozinho nao diz que episodio e aquele.
 */
fun formatEpisodeSub(episode: EpisodeRef): String {
  val code = formatEpisodeCode(episode) ?: return episode.title
  return if (episode.title.isBlank()) code else code + DOT + episode.title
}

/** Linha da pilula: "07 · ThunderCats · S02E14". */
fun formatNowLine(channel: ChannelSummary, episode: EpisodeRef?): String {
  val head = formatChannelNumber(channel.number) + DOT + channel.name
  return if (episode == null) head else head + DOT + formatEpisodeLabel(episode)
}

/**
 * Selo de resolucao para o catalogo. So anuncia o que muda a expectativa de quem
 * escolhe: abaixo de 1080 linhas o numero nao diz nada util, e uma coluna com
 * "480p" em toda linha viraria ruido.
 *
 * @return null quando nao ha o que anunciar.
 */
fun formatResolutionBadge(height: Int?): String? = when {
  height == null -> null
  height >= 2160 -> "4K"
  height >= 1080 -> "1080p"
  else -> null
}

/* --- overlay do player ---------------------------------------------------- */

/** Selo do canal na faixa de cima: "Canal 07". */
fun formatChannelBadge(channelNumber: Int): String =
  "Canal " + formatChannelNumber(channelNumber)

/**
 * Relogio do scrub: "12:34", e "1:02:03" so quando passa da hora.
 *
 * Sem zero a esquerda no primeiro campo de proposito: e assim que todo player
 * escreve, e "01:02" custa um caractere para nao dizer nada.
 */
fun formatClock(positionMs: Long): String {
  val total = (if (positionMs > 0) positionMs else 0L) / 1000
  val seconds = total % 60
  val minutes = total / 60 % 60
  val hours = total / 3600
  return if (hours > 0) {
    String.format(Locale.ROOT, "%d:%02d:%02d", hours, minutes, seconds)
  } else {
    String.format(Locale.ROOT, "%d:%02d", minutes, seconds)
  }
}

/** Canto esquerdo do scrub: "12:34 no episodio". */
fun formatScrubLeft(positionMs: Long): String = formatClock(positionMs) + " no episódio"

/**
 * Recado do meio da linha de tempos.
 *
 * Ao vivo ele existe para explicar por que a barra nao obedece: a posicao
 * pertence a grade, e quem apertar a seta merece saber disso antes de achar que
 * o aparelho travou.
 */
fun formatScrubNote(live: Boolean, remainingMs: Long): String = when {
  live -> "ao vivo · a grade não para"
  remainingMs > 0 -> formatRemaining(remainingMs)
  else -> ""
}

/** Terceira linha do bloco "A seguir": "em 9 min". */
fun formatUpNextTime(endsAtMs: Long, nowMs: Long): String {
  val remaining = endsAtMs - nowMs
  if (remaining <= 0) return "agora"
  val minutes = (remaining + 59_999) / 60_000
  return if (minutes == 1L) "em 1 min" else "em $minutes min"
}

/**
 * Dica de teclado do rodape. Ao vivo nao ha pausa nem salto: anunciar teclas que
 * o player recusa seria ensinar o gesto errado.
 */
fun playerHint(live: Boolean): String =
  if (live) "↑ ↓ trocar de canal · OK áudio e legendas · VOLTAR sair"
  else "OK pausar · ← → 10 s · MENU áudio e legendas · VOLTAR sair"
