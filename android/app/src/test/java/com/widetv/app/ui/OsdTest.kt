package com.widetv.app.ui

import org.junit.Assert.assertEquals
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
}
