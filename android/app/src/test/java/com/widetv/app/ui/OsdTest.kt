package com.widetv.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import com.widetv.app.net.ChannelSummary
import com.widetv.app.net.EpisodeRef

/** Pilula do player e o selo de resolucao. Porte de `tests/web/osd.test.ts`. */
class OsdTest {

  private fun ep(
    title: String = "Titulo",
    season: Int? = 2,
    episode: Int? = 14,
    height: Int? = null,
  ) = EpisodeRef(
    id = "x",
    title = title,
    season = season,
    episode = episode,
    durationMs = 1000,
    height = height,
  )

  private fun ch(number: Int = 7, name: String = "ThunderCats") =
    ChannelSummary(number = number, name = name, episodeCount = 130)

  // Numero do canal

  @Test
  fun `preenche com zero ate dois digitos como TV antiga`() {
    assertEquals("07", formatChannelNumber(7))
  }

  @Test
  fun `nao mutila canal de tres digitos`() {
    assertEquals("250", formatChannelNumber(250))
  }

  // Numeracao do episodio

  @Test
  fun `temporada e episodio viram SxxEyy`() {
    assertEquals("S02E14", formatEpisodeCode(ep()))
  }

  @Test
  fun `so episodio vira EP xx`() {
    assertEquals("EP 14", formatEpisodeCode(ep(season = null)))
  }

  @Test
  fun `temporada acima de 99 nao e truncada`() {
    assertEquals("S100E01", formatEpisodeCode(ep(season = 100, episode = 1)))
  }

  @Test
  fun `sem numeracao nenhuma nao ha codigo a mostrar`() {
    assertNull(formatEpisodeCode(ep(season = null, episode = null)))
  }

  @Test
  fun `sem numeracao o rotulo cai no titulo do arquivo`() {
    val label = formatEpisodeLabel(ep(title = "Especial de Natal", season = null, episode = null))
    assertEquals("Especial de Natal", label)
  }

  @Test
  fun `titulo longo e truncado para caber na pilula`() {
    val label = formatEpisodeLabel(ep(title = "a".repeat(120), season = null, episode = null))
    assertTrue(label.length <= 42)
  }

  // Linha da pilula

  @Test
  fun `junta canal, serie e episodio com o separador do app`() {
    assertEquals("07 · ThunderCats · S02E14", formatNowLine(ch(), ep()))
  }

  @Test
  fun `sem episodio a pilula mostra so canal e serie`() {
    assertEquals("07 · ThunderCats", formatNowLine(ch(), null))
  }

  // Selo de resolucao

  @Test
  fun `2160 linhas ou mais vira 4K`() {
    assertEquals("4K", formatResolutionBadge(2160))
    assertEquals("4K", formatResolutionBadge(3000))
  }

  @Test
  fun `entre 1080 e 2159 linhas vira 1080p`() {
    assertEquals("1080p", formatResolutionBadge(1080))
    assertEquals("1080p", formatResolutionBadge(1440))
  }

  @Test
  fun `resolucao baixa nao ganha selo`() {
    assertNull(formatResolutionBadge(480))
    assertNull(formatResolutionBadge(1079))
  }

  @Test
  fun `altura desconhecida nao ganha selo`() {
    assertNull(formatResolutionBadge(null))
  }

  // Linha do card e do overlay

  @Test
  fun `o subtitulo do card junta codigo e titulo`() {
    assertEquals("S02E14 · Titulo", formatEpisodeSub(ep()))
  }

  @Test
  fun `sem numeracao sobra o titulo inteiro`() {
    val episode = ep(title = "Especial de Natal", season = null, episode = null)
    assertEquals("Especial de Natal", formatEpisodeSub(episode))
  }

  // Overlay do player

  @Test
  fun `o selo do canal e escrito por extenso`() {
    assertEquals("Canal 07", formatChannelBadge(7))
  }

  @Test
  fun `o relogio do scrub so ganha hora quando passa dela`() {
    assertEquals("0:00", formatClock(0))
    assertEquals("12:34", formatClock(754_000))
    assertEquals("1:02:03", formatClock(3_723_000))
    // Posicao negativa aparece no ExoPlayer antes do primeiro quadro.
    assertEquals("0:00", formatClock(-5))
  }

  @Test
  fun `o canto esquerdo do scrub diz onde esta no episodio`() {
    assertEquals("12:34 no episódio", formatScrubLeft(754_000))
  }

  @Test
  fun `ao vivo o recado explica por que a barra nao obedece`() {
    assertEquals("ao vivo · a grade não para", formatScrubNote(live = true, remainingMs = 60_000))
    // Chamada exata do guarda de DPAD lateral ao vivo: a seta consumida mostra
    // este recado com resto zero, e ele nao pode virar string vazia.
    assertEquals("ao vivo · a grade não para", formatScrubNote(live = true, remainingMs = 0))
  }

  @Test
  fun `sob demanda o recado vira o quanto falta`() {
    assertEquals("faltam 4 min", formatScrubNote(live = false, remainingMs = 4 * 60_000L))
    assertEquals("", formatScrubNote(live = false, remainingMs = 0))
  }

  @Test
  fun `a hora do proximo arredonda para cima e nunca fica negativa`() {
    assertEquals("em 9 min", formatUpNextTime(endsAtMs = 540_000, nowMs = 0))
    assertEquals("em 1 min", formatUpNextTime(endsAtMs = 30_000, nowMs = 0))
    assertEquals("agora", formatUpNextTime(endsAtMs = 0, nowMs = 10_000))
  }

  @Test
  fun `a dica de teclado nao anuncia tecla que o modo recusa`() {
    // Ao vivo nao ha pausa nem salto; ensinar o gesto errado e pior que calar.
    val live = playerHint(live = true)
    assertTrue(live.contains("trocar de canal"))
    assertFalse(live.contains("pausar"))

    val vod = playerHint(live = false)
    assertTrue(vod.contains("pausar"))
    assertFalse(vod.contains("trocar de canal"))
  }
}
