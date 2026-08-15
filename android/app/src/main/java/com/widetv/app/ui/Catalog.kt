package com.widetv.app.ui

import com.widetv.app.net.ChannelSummary
import com.widetv.app.net.NowPlaying
import com.widetv.app.net.ResumeEntry
import java.text.Normalizer
import java.util.Locale

/**
 * Texto e numeros do catalogo: hero, as tres faixas, cabecalho da serie,
 * iniciais do placeholder e o calculo de reducao da imagem.
 *
 * Tudo puro. A parte do catalogo que tem regra e justamente a que aparece
 * escrita na tela — e o que decide QUAIS cards existem —, e aqui ela e testavel
 * sem Android. Os adapters recebem `WideCard`/`TallCard` prontos e so pintam.
 */

/** Card do acervo: "2025 · 22 EP". Sem ano, so a contagem. */
fun formatCardMeta(year: Int?, episodeCount: Int): String {
  val episodes = "$episodeCount EP"
  return if (year == null) episodes else "$year$DOT$episodes"
}

/** Cabecalho da tela de serie: "2025 · 22 episodios". */
fun formatSeriesMeta(year: Int?, episodeCount: Int): String {
  val episodes = if (episodeCount == 1) "1 episodio" else "$episodeCount episodios"
  return if (year == null) episodes else "$year$DOT$episodes"
}

/**
 * Duracao em linguagem de quem escolhe o que assistir, e nao em relogio:
 * "42 min", "1 h 12 min".
 *
 * @return string vazia quando o probe nao mediu a duracao.
 */
fun formatDuration(durationMs: Long): String {
  if (durationMs <= 0) return ""
  val totalMinutes = durationMs / 60_000
  if (totalMinutes < 60) return "${totalMinutes.coerceAtLeast(1)} min"
  val hours = totalMinutes / 60
  val minutes = totalMinutes % 60
  return if (minutes == 0L) "$hours h" else "$hours h $minutes min"
}

/**
 * Iniciais para o card sem capa. Duas letras no maximo: tres ja viram sopa de
 * letrinhas num retangulo de 200dp.
 *
 * @return string vazia quando o nome nao tem letra nem digito nenhum.
 */
fun initialsOf(name: String): String {
  val words = name.split(' ', '-', ':', '.', '_')
    .mapNotNull { word -> word.firstOrNull { it.isLetterOrDigit() } }
  if (words.isEmpty()) return ""
  val picked = if (words.size == 1) words.take(1) else words.take(2)
  return picked.joinToString("") { it.uppercase(Locale.ROOT) }
}

/* --- reducao de imagem ---------------------------------------------------- */

/**
 * Reducao de decodificacao da capa 2:3.
 *
 * O servidor entrega poster em resolucao de provedor (~680px de largura) e o
 * card tem ~140dp. Decodificar inteiro e jogar fora 3/4 dos pixels custa memoria
 * de sobra numa TV, entao o `BitmapFactory` recebe a potencia de dois que ainda
 * cobre o card.
 *
 * @return sempre >= 1, mesmo com entradas absurdas.
 */
fun sampleSizeFor(sourceWidth: Int, targetWidth: Int): Int {
  if (sourceWidth <= 0 || targetWidth <= 0) return 1
  var sample = 1
  // Para no ultimo passo que ainda cobre o alvo: dobrar mais uma vez deixaria a
  // capa borrada no foco, que e exatamente quando ela cresce 6%.
  while (sourceWidth / (sample * 2) >= targetWidth) sample *= 2
  return sample
}

/**
 * Mesma reducao para um alvo de duas dimensoes — o backdrop 16:9 do hero, dos
 * cards largos e o quadro da linha de episodio, que nao tem a proporcao da capa.
 *
 * Vence a dimensao MAIS EXIGENTE: reduzir pela largura quando o corte e pela
 * altura deixaria o hero borrado num painel de 465dp de altura.
 *
 * @param targetHeight 0 quando so a largura importa (capa 2:3 do acervo).
 */
fun sampleSizeFor(
  sourceWidth: Int,
  sourceHeight: Int,
  targetWidth: Int,
  targetHeight: Int,
): Int {
  val byWidth = sampleSizeFor(sourceWidth, targetWidth)
  if (targetHeight <= 0 || sourceHeight <= 0) return byWidth
  return minOf(byWidth, sampleSizeFor(sourceHeight, targetHeight))
}

/* --- tempo dos cards ------------------------------------------------------ */

/**
 * Fracao ja assistida, de 0 a 100.
 *
 * @return 0 quando a duracao e desconhecida — barra vazia e honesta, barra
 *   cheia por divisao estranha nao.
 */
fun percentOf(positionMs: Long, durationMs: Long): Int {
  if (durationMs <= 0) return 0
  return (positionMs * 100 / durationMs).coerceIn(0L, 100L).toInt()
}

/**
 * Escala das `ProgressBar` do layout: os trilhos finos do card, do episodio e do
 * scrub vao ate 1000, e nao ate 100, para andarem liso num trilho de 230dp — a
 * cada 1% um trilho de 100 passos daria um salto de mais de dois pixels.
 */
const val BAR_MAX = 1000

/** A mesma fracao na escala de `BAR_MAX`. */
fun barProgress(positionMs: Long, durationMs: Long): Int {
  if (durationMs <= 0) return 0
  return (positionMs * BAR_MAX / durationMs).coerceIn(0L, BAR_MAX.toLong()).toInt()
}

/**
 * Quanto falta, na linguagem da faixa "No ar agora": "faltam 4 min".
 *
 * Arredonda para CIMA porque quem le quer saber se da tempo de entrar: dizer
 * "faltam 0 min" com 50 segundos de episodio seria mandar a pessoa embora.
 */
fun formatRemaining(remainingMs: Long): String {
  if (remainingMs <= 0) return "acabando"
  val minutes = (remainingMs + 59_999) / 60_000
  return if (minutes == 1L) "falta 1 min" else "faltam $minutes min"
}

/**
 * Onde a grade do canal esta AGORA, projetando a amostra do servidor adiante.
 *
 * A faixa e desenhada uma vez e fica na tela; sem projetar, o card mostraria a
 * posicao do instante do request pelo resto da sessao.
 */
fun liveOffsetMs(playing: NowPlaying, nowMs: Long): Long =
  (playing.offsetMs + (nowMs - playing.serverTimeMs)).coerceAtLeast(0L)

/* --- faixas do catalogo --------------------------------------------------- */

/**
 * Card 16:9. Serve as duas faixas de cima: os campos que uma nao usa ficam
 * nulos, e o adapter esconde a view correspondente.
 *
 * Um modelo so, e nao dois, porque a diferenca entre "No ar agora" e "Continuar
 * assistindo" e de CONTEUDO (selo de canal contra botao de play), nao de forma:
 * dois data class identicos exigiriam dois adapters identicos.
 */
data class WideCard(
  val channelNumber: Int,
  val name: String,
  /** "S01E08 · O roubo do seculo". */
  val sub: String,
  /** Terceira linha de texto, so no ao vivo: "faltam 4 min". */
  val time: String? = null,
  /** Selo do canal no topo-esquerda, so no ao vivo: "07". */
  val chan: String? = null,
  /** Selo AO VIVO no topo-direita. */
  val live: Boolean = false,
  /** Botao circular de play no centro, so em "Continuar assistindo". */
  val play: Boolean = false,
  /** Selo de tempo restante no canto de baixo, so em "Continuar": "12 min". */
  val left: String? = null,
  /** Barra inferior, na escala de `BAR_MAX`. */
  val progress: Int = 0,
  /**
   * Rota relativa da arte 16:9, ou null para o padrao listrado.
   *
   * A preferencia e o QUADRO do episodio, e nao a arte da serie: as duas faixas
   * falam de um episodio especifico, e o desenho mostra literalmente "frame do
   * episodio". A arte do canal e a segunda escolha, para o card nao ficar
   * listrado enquanto a fila de quadros nao chegou naquele arquivo.
   */
  val artUrl: String? = null,
)

/** Card 2:3 da faixa "Todo o acervo". */
data class TallCard(
  val channelNumber: Int,
  val name: String,
  /** "1989 · 142 EP". */
  val meta: String,
  /** Selo do canal: "07". */
  val chan: String,
  /** Selo de resolucao; null quando nao ha o que anunciar. */
  val badge: String? = null,
  val posterUrl: String? = null,
)

/**
 * Faixa "No ar agora", a partir de `GET /api/now`.
 *
 * @param nowMs relogio local, para projetar a posicao de cada canal.
 */
fun liveRail(playing: List<NowPlaying>, nowMs: Long): List<WideCard> = playing.map { item ->
  WideCard(
    channelNumber = item.channel.number,
    name = item.channel.name,
    sub = formatEpisodeSub(item.episode),
    time = formatRemaining(item.endsAtMs - nowMs),
    chan = formatChannelNumber(item.channel.number),
    live = true,
    progress = barProgress(liveOffsetMs(item, nowMs), item.episode.durationMs),
    artUrl = item.episode.thumbUrl ?: item.channel.backdropUrl,
  )
}

/**
 * Faixa "Continuar assistindo", a partir de `GET /api/history/resume`.
 *
 * Sem selo de canal e sem AO VIVO: aqui nada esta no ar, e repetir o numero do
 * canal roubaria o lugar do que interessa, que e quanto falta.
 */
fun resumeRail(entries: List<ResumeEntry>): List<WideCard> = entries.map { entry ->
  val duration = if (entry.durationMs > 0) entry.durationMs else entry.episode.durationMs
  WideCard(
    channelNumber = entry.channelNumber,
    name = entry.channelName,
    sub = formatEpisodeSub(entry.episode),
    play = true,
    left = formatDuration(duration - entry.positionMs),
    progress = barProgress(entry.positionMs, duration),
    artUrl = entry.episode.thumbUrl ?: entry.backdropUrl,
  )
}

/**
 * Faixa "Todo o acervo", ja filtrada pela busca da topbar.
 *
 * O filtro e local de proposito: o acervo inteiro ja esta na mao, e um request
 * por tecla digitada num controle remoto seria rede gasta para reordenar uma
 * lista que nao mudou.
 *
 * @param query texto do campo de busca; vazio devolve o acervo inteiro.
 */
fun shelfRail(channels: List<ChannelSummary>, query: String = ""): List<TallCard> {
  val wanted = searchKey(query)
  return channels
    .filter { wanted.isEmpty() || searchKey(it.name).contains(wanted) }
    .map { channel ->
      TallCard(
        channelNumber = channel.number,
        name = channel.name,
        meta = formatCardMeta(channel.year, channel.episodeCount),
        chan = formatChannelNumber(channel.number),
        posterUrl = channel.posterUrl,
      )
    }
}

/**
 * Chave de comparacao da busca: sem acento, sem caixa.
 *
 * Digitar "sitio" tem que achar "O Sitio do Picapau" e "Sítio"; num controle
 * remoto ninguem vai atras do til.
 */
fun searchKey(text: String): String =
  DIACRITICS.replace(Normalizer.normalize(text.trim(), Normalizer.Form.NFD), "")
    .lowercase(Locale.ROOT)

private val DIACRITICS = Regex("\\p{Mn}+")

/**
 * Rotulo do botao primario da tela de serie.
 *
 * "Continuar S01E08" quando ha de onde retomar, "Do inicio" quando nao ha: o
 * botao mais gordo da tela diz o que vai acontecer antes de alguem apertar.
 */
fun seriesResumeLabel(entry: ResumeEntry?): String =
  if (entry == null) "Do início" else "Continuar " + formatEpisodeLabel(entry.episode)

/* --- hero ----------------------------------------------------------------- */

/** O bloco de texto do topo do catalogo, ja escrito. */
data class HeroModel(
  val channelNumber: Int,
  /** Pilula: "Canal 07 · no ar agora". */
  val chip: String,
  val title: String,
  /** "1989 · 142 episodios". */
  val meta: String,
  /** Frase gerada, ou a sinopse quando a grade nao respondeu. */
  val text: String,
  /**
   * Arte 16:9 do CANAL, e nao o quadro do episodio no ar — ao contrario dos
   * cards das faixas. O hero anuncia a serie num painel de 465dp de altura, e
   * uma miniatura de 480x270 esticada ate la sairia borrada; alem disso a arte
   * do canal e estavel, e trocar o fundo da tela inteira a cada episodio da
   * grade seria piscar sozinho.
   */
  val artUrl: String? = null,
)

/**
 * Hero do canal escolhido: o ultimo assistido, ou o primeiro do acervo.
 *
 * @param playing estado do canal agora; null quando `GET /api/now` nao
 *   respondeu — o hero continua desenhado, so sem a frase da grade.
 */
fun heroFor(channel: ChannelSummary, playing: NowPlaying?, nowMs: Long): HeroModel = HeroModel(
  channelNumber = channel.number,
  chip = "Canal ${formatChannelNumber(channel.number)}$DOT" +
    if (playing == null) "no acervo" else "no ar agora",
  title = channel.name,
  meta = formatSeriesMeta(channel.year, channel.episodeCount),
  text = formatHeroText(channel, playing, nowMs),
  artUrl = channel.backdropUrl,
)

/**
 * A frase do hero.
 *
 * Ela e GERADA, e nao a sinopse, porque o hero anuncia o que esta acontecendo
 * agora naquele canal — a sinopse ja tem lugar na tela de serie. Sem a grade na
 * mao, a sinopse volta a ser a melhor coisa a dizer.
 */
fun formatHeroText(channel: ChannelSummary, playing: NowPlaying?, nowMs: Long): String {
  if (playing == null) return channel.overview.orEmpty()

  val elapsed = liveOffsetMs(playing, nowMs) / 60_000
  val head = when {
    elapsed <= 0L -> "Está começando ${formatEpisodeLabel(playing.episode)} agora."
    elapsed == 1L -> "Está tocando ${formatEpisodeLabel(playing.episode)} há 1 minuto."
    else -> "Está tocando ${formatEpisodeLabel(playing.episode)} há $elapsed minutos."
  }
  val remaining = playing.endsAtMs - nowMs
  if (remaining <= 0) return head
  return "$head A seguir, ${formatEpisodeLabel(playing.next)}, ${formatRemaining(remaining)}."
}
