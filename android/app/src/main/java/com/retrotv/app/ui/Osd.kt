package com.retrotv.app.ui

import com.retrotv.app.net.ChannelSummary
import com.retrotv.app.net.EpisodeRef
import java.util.Locale
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Formatacao do display de fosforo verde. Porte de `src/web/osd.ts`.
 *
 * So texto: quem desenha na tela e a Activity. Separado assim porque o formato e
 * a unica parte com regra (numeracao ausente, titulo longo, volume fora da faixa)
 * e da para testar sem Android.
 */

/** Largura util do OSD em caracteres. */
private const val MAX_LABEL = 32
private const val VOLUME_STEPS = 10

fun formatChannelNumber(channel: Int): String = channel.toString().padStart(2, '0')

/**
 * Rotulo do episodio. Nome de arquivo de acervo caseiro raramente traz numeracao
 * confiavel, entao o titulo e a saida de emergencia.
 */
fun formatEpisodeLabel(episode: EpisodeRef): String {
  val season = episode.season
  val number = episode.episode

  if (season != null && number != null) {
    return "S${season.toString().padStart(2, '0')}E${number.toString().padStart(2, '0')}"
  }
  if (number != null) {
    return "EP ${number.toString().padStart(2, '0')}"
  }
  return episode.title.uppercase(Locale.ROOT).take(MAX_LABEL)
}

fun formatTuneLine(channel: ChannelSummary, episode: EpisodeRef?): String {
  val head = "${formatChannelNumber(channel.number)}  ${channel.name.uppercase(Locale.ROOT)}"
  return if (episode == null) head else "$head  ${formatEpisodeLabel(episode)}"
}

/**
 * Selo de resolucao para o catalogo. Só anuncia o que muda a expectativa de
 * quem escolhe: abaixo de 1080 linhas o numero nao diz nada util, e uma coluna
 * com "480p" em toda linha viraria ruido.
 *
 * @return null quando nao ha o que anunciar.
 */
fun formatResolutionBadge(height: Int?): String? = when {
  height == null -> null
  height >= 2160 -> "4K"
  height >= 1080 -> "1080p"
  else -> null
}

/** Linha do menu de canais: "07  NOME" a esquerda, "52 EP >" a direita. */
fun formatMenuChannelRow(channel: ChannelSummary): Pair<String, String> =
  Pair(
    "${formatChannelNumber(channel.number)}  ${channel.name.uppercase(Locale.ROOT)}",
    "${channel.episodeCount} EP >",
  )

/** Linha do menu de episodios: mesmo rotulo do OSD, e o selo de resolucao. */
fun formatMenuEpisodeRow(episode: EpisodeRef): Pair<String, String> =
  Pair(formatEpisodeLabel(episode), formatResolutionBadge(episode.height) ?: "")

fun formatVolumeBar(level: Float, muted: Boolean): String {
  val clamped = min(1f, max(0f, level))
  val filled = (clamped * VOLUME_STEPS).roundToInt()
  val bar = "#".repeat(filled) + "-".repeat(VOLUME_STEPS - filled)
  return "${if (muted) "MUDO" else "VOL"} [$bar]"
}
