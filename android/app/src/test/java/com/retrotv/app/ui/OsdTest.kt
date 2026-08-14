package com.retrotv.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import com.retrotv.app.net.ChannelSummary
import com.retrotv.app.net.EpisodeRef

/** Porte de `tests/web/osd.test.ts`. */
class OsdTest {

  private fun ep(
    title: String = "Titulo",
    season: Int? = 2,
    episode: Int? = 14,
  ) = EpisodeRef(id = "x", title = title, season = season, episode = episode, durationMs = 1000)

  private fun ch(number: Int = 7, name: String = "ThunderCats") =
    ChannelSummary(number = number, name = name, episodeCount = 130)

  @Test
  fun `preenche com zero ate dois digitos como TV antiga`() {
    assertEquals("07", formatChannelNumber(7))
  }

  @Test
  fun `nao mutila canal de tres digitos`() {
    assertEquals("250", formatChannelNumber(250))
  }

  @Test
  fun `temporada e episodio viram SxxEyy`() {
    assertEquals("S02E14", formatEpisodeLabel(ep()))
  }

  @Test
  fun `so episodio vira EP xx`() {
    assertEquals("EP 14", formatEpisodeLabel(ep(season = null)))
  }

  @Test
  fun `sem numeracao cai no titulo do arquivo`() {
    val label = formatEpisodeLabel(ep(title = "Especial de Natal", season = null, episode = null))
    assertEquals("ESPECIAL DE NATAL", label)
  }

  @Test
  fun `titulo longo e truncado para caber no OSD`() {
    val label = formatEpisodeLabel(ep(title = "a".repeat(80), season = null, episode = null))
    assertTrue(label.length <= 32)
  }

  @Test
  fun `temporada acima de 99 nao e truncada`() {
    assertEquals("S100E01", formatEpisodeLabel(ep(season = 100, episode = 1)))
  }

  @Test
  fun `junta canal serie e episodio em maiuscula`() {
    assertEquals("07  THUNDERCATS  S02E14", formatTuneLine(ch(), ep()))
  }

  @Test
  fun `sem episodio ainda mostra so canal e serie`() {
    assertEquals("07  THUNDERCATS", formatTuneLine(ch(), null))
  }

  @Test
  fun `volume cheio enche a barra`() {
    assertEquals("VOL [##########]", formatVolumeBar(1f, false))
  }

  @Test
  fun `volume zero esvazia a barra`() {
    assertEquals("VOL [----------]", formatVolumeBar(0f, false))
  }

  @Test
  fun `meio volume enche metade`() {
    assertEquals("VOL [#####-----]", formatVolumeBar(0.5f, false))
  }

  @Test
  fun `mudo tem rotulo proprio e mantem o nivel visivel`() {
    assertEquals("MUDO [#####-----]", formatVolumeBar(0.5f, true))
  }

  @Test
  fun `valor fora da faixa e limitado em vez de quebrar a barra`() {
    assertEquals("VOL [##########]", formatVolumeBar(2f, false))
    assertEquals("VOL [----------]", formatVolumeBar(-1f, false))
  }
}
