package com.widetv.app.ui

import com.widetv.app.net.EpisodeRef

/**
 * Temporadas da tela de serie: as abas, o que cada uma filtra, o resumo a
 * direita e a linha de episodio ja escrita.
 *
 * Tudo puro, no mesmo espirito de `Catalog.kt`: agrupar por temporada e somar
 * duracao sao as duas unicas decisoes desta tela, e as duas cabem num teste JVM.
 * Os adapters recebem `SeasonTab` e `EpisodeItem` prontos.
 */

/** Uma aba. `season == null` e a aba dos episodios fora de qualquer temporada. */
data class SeasonTab(
  val season: Int?,
  /** "Temporada 3" ou "Sem temporada · 12". */
  val label: String,
  val count: Int,
)

/**
 * As abas, na ordem em que aparecem.
 *
 * @param seasons `ChannelSummary.seasons`, que chega ANTES da lista de
 *   episodios: e o que deixa a barra de abas nascer desenhada em vez de piscar
 *   depois. Vazio num servidor mais antigo — dai as temporadas saem dos
 *   proprios episodios.
 * @return vazio quando a serie nao usa temporada nenhuma. Uma aba so, que
 *   filtra tudo, e um controle que nao faz nada: a barra some inteira.
 */
fun seasonTabs(seasons: List<Int>, episodes: List<EpisodeRef>): List<SeasonTab> {
  val numbered = (seasons + episodes.mapNotNull { it.season }).distinct().sorted()
  if (numbered.isEmpty()) return emptyList()

  val tabs = numbered.mapTo(mutableListOf()) { season ->
    SeasonTab(season, "Temporada $season", episodes.count { it.season == season })
  }

  // A aba "Sem temporada" e DEDUZIDA: o servidor nao a manda em `seasons`, e ela
  // so existe quando ha episodio solto de verdade. Vai no fim porque e o resto.
  val loose = episodes.count { it.season == null }
  if (loose > 0) tabs += SeasonTab(null, "Sem temporada$DOT$loose", loose)
  return tabs
}

/**
 * Indices, na lista original, dos episodios de uma temporada.
 *
 * Indices e nao episodios: quem toca recebe a posicao na fila INTEIRA do canal,
 * porque a maratona continua para dentro da temporada seguinte. Filtrar a lista
 * e passar a posicao filtrada faria "do inicio da temporada 3" tocar o episodio
 * 3 da serie.
 *
 * @param season null com abas na tela significa a aba "Sem temporada"; sem abas
 *   nenhuma significa o canal inteiro.
 */
fun seasonIndices(episodes: List<EpisodeRef>, season: Int?, hasTabs: Boolean = true): List<Int> {
  if (season == null && !hasTabs) return episodes.indices.toList()
  return episodes.indices.filter { episodes[it].season == season }
}

/**
 * Resumo a direita da barra de abas: "26 episodios · 9h 12min".
 *
 * @param indices o que a aba ativa mostra; a conta e da temporada, nao do canal.
 */
fun seasonAside(episodes: List<EpisodeRef>, indices: List<Int>): String {
  val count = indices.size
  val head = if (count == 1) "1 episódio" else "$count episódios"
  val total = indices.sumOf { episodes.getOrNull(it)?.durationMs ?: 0L }
  val span = formatSeasonSpan(total)
  return if (span.isEmpty()) head else head + DOT + span
}

/**
 * Duracao somada de uma temporada: "9h 12min", "45min", "3h".
 *
 * Formato compacto, diferente do `formatDuration` das linhas: aqui e um numero
 * de canto de tela, e "9 h 12 min" com espacos ocuparia a largura de um titulo.
 *
 * @return string vazia quando o probe nao mediu nada.
 */
fun formatSeasonSpan(totalMs: Long): String {
  if (totalMs <= 0) return ""
  val minutes = totalMs / 60_000
  if (minutes < 60) return "${minutes.coerceAtLeast(1)}min"
  val hours = minutes / 60
  val rest = minutes % 60
  return if (rest == 0L) "${hours}h" else "${hours}h ${rest}min"
}

/**
 * Meta do cabecalho da serie: "1989 · 3 temporadas · 142 episodios".
 *
 * A contagem de temporadas so entra quando ha mais de uma: "1 temporada" nao
 * informa nada que "142 episodios" ao lado ja nao diga.
 */
fun formatSeasonsMeta(year: Int?, seasonCount: Int, episodeCount: Int): String {
  val parts = mutableListOf<String>()
  if (year != null) parts += year.toString()
  if (seasonCount > 1) parts += "$seasonCount temporadas"
  parts += if (episodeCount == 1) "1 episodio" else "$episodeCount episodios"
  return parts.joinToString(DOT)
}

/* --- linha de episodio ---------------------------------------------------- */

/** Uma linha da lista, ja escrita. O adapter so pinta. */
data class EpisodeItem(
  /** Posicao na lista INTEIRA do canal. E o que a reproducao recebe. */
  val index: Int,
  /** Coluna da esquerda: "09". */
  val number: String,
  val title: String,
  /** "24 min"; vazio quando o probe nao mediu. */
  val duration: String,
  /** Selo de resolucao; null quando nao ha o que anunciar. */
  val badge: String? = null,
  /** "3 áudios"; null quando so ha uma faixa e nao ha nada a escolher. */
  val tracks: String? = null,
  /** "assistido", "faltam 12 min", ou vazio. */
  val state: String = "",
  /** Barrinha sobre a miniatura, na escala de `BAR_MAX`. */
  val progress: Int = 0,
  /**
   * Rota do quadro 16:9 do episodio, ou null para o padrao listrado.
   *
   * null e o caso NORMAL por um bom tempo: a fila do servidor tira um quadro por
   * vez, e uma serie inteira leva minutos ate ficar coberta. A linha nasce
   * listrada e ganha a imagem quando ela existir.
   */
  val thumbUrl: String? = null,
)

/**
 * Acima disto o episodio conta como visto.
 *
 * Nao e 100% porque ninguem assiste os creditos: parar a 30 segundos do fim e
 * ter terminado, e oferecer "faltam 0 min" ali seria mandar a pessoa de volta
 * para a tela final.
 */
private const val WATCHED_PERCENT = 95

/**
 * As linhas de uma aba.
 *
 * @param progress posicao guardada por id de episodio, de
 *   `GET /api/history/resume`. O que nao esta no mapa nunca foi assistido.
 */
fun episodeItems(
  episodes: List<EpisodeRef>,
  indices: List<Int>,
  progress: Map<String, Long> = emptyMap(),
): List<EpisodeItem> = indices.mapNotNull { index ->
  val episode = episodes.getOrNull(index) ?: return@mapNotNull null
  val position = progress[episode.id] ?: 0L
  val percent = percentOf(position, episode.durationMs)

  EpisodeItem(
    index = index,
    // Sem numeracao no arquivo, a posicao na fila e a unica ordem que existe.
    number = (episode.episode ?: (index + 1)).toString().padStart(2, '0'),
    title = episode.title,
    duration = formatDuration(episode.durationMs),
    badge = formatResolutionBadge(episode.height),
    tracks = formatAudioCount(episode.audioTracks.size),
    state = when {
      percent >= WATCHED_PERCENT -> "assistido"
      position > 0 -> formatRemaining(episode.durationMs - position)
      else -> ""
    },
    progress = barProgress(position, episode.durationMs),
    thumbUrl = episode.thumbUrl,
  )
}

/**
 * Selo "N audios".
 *
 * @return null com zero ou uma faixa: anunciar "1 áudio" seria ocupar espaco
 *   para dizer que nao ha escolha nenhuma a fazer.
 */
fun formatAudioCount(count: Int): String? = if (count <= 1) null else "$count áudios"
