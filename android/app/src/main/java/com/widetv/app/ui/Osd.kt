package com.widetv.app.ui

import com.widetv.app.net.ChannelSummary
import com.widetv.app.net.EpisodeRef

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
