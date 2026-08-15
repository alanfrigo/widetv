package com.widetv.app.ui

import java.util.Locale

/**
 * Texto e numeros do catalogo: card do acervo, cabecalho da serie, linha de
 * episodio, iniciais do placeholder e o calculo de reducao da capa.
 *
 * Tudo puro. A parte do catalogo que tem regra e justamente a que aparece
 * escrita na tela, e aqui ela e testavel sem Android.
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

/**
 * Reducao de decodificacao da capa.
 *
 * O servidor entrega poster em resolucao de provedor (~680px de largura) e o
 * card tem ~200dp. Decodificar inteiro e jogar fora 3/4 dos pixels custa memoria
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
