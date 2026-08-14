package com.retrotv.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import com.retrotv.app.net.ChannelSummary
import com.retrotv.app.net.DisplayMode
import com.retrotv.app.net.EpisodeRef

/**
 * Menu do modo panoramico: o reducer, os formatadores das duas colunas e a
 * traducao do `displayMode` que chega do servidor.
 */
class MenuTest {

  private val closed = MenuState()
  private val channels = MenuState(open = true, level = MenuLevel.Channels)
  private val episodes = MenuState(open = true, level = MenuLevel.Episodes(7))

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

  // Reducer

  @Test
  fun `abrir parte sempre da lista de canais`() {
    val result = reduceMenu(closed, MenuEvent.Open)
    assertTrue(result.state.open)
    assertEquals(MenuLevel.Channels, result.state.level)
    assertFalse(result.close)
  }

  @Test
  fun `abrir de novo com o menu aberto nao mexe em nada`() {
    val result = reduceMenu(episodes, MenuEvent.Open)
    assertEquals(episodes, result.state)
    assertNull(result.loadEpisodes)
  }

  @Test
  fun `voltar dos episodios sobe para os canais em vez de fechar`() {
    val result = reduceMenu(episodes, MenuEvent.Back)
    assertEquals(MenuLevel.Channels, result.state.level)
    assertTrue(result.state.open)
    assertFalse(result.close)
  }

  @Test
  fun `voltar na lista de canais fecha o menu`() {
    val result = reduceMenu(channels, MenuEvent.Back)
    assertTrue(result.close)
    assertFalse(result.state.open)
  }

  @Test
  fun `OK num canal sintoniza ao vivo e sai da frente`() {
    val result = reduceMenu(channels, MenuEvent.ActivateChannel(12))
    assertEquals(12, result.tuneTo)
    assertTrue(result.close)
    assertFalse(result.state.open)
    assertNull(result.playFrom)
  }

  @Test
  fun `entrar num canal pede o catalogo dele e guarda o numero`() {
    val result = reduceMenu(channels, MenuEvent.DrillChannel(7))
    assertEquals(MenuLevel.Episodes(7), result.state.level)
    assertEquals(7, result.loadEpisodes)
    assertTrue(result.state.open)
    assertFalse(result.close)
  }

  @Test
  fun `OK num episodio reproduz sob demanda e sai da frente`() {
    val result = reduceMenu(episodes, MenuEvent.ActivateEpisode(3))
    assertEquals(3, result.playFrom)
    assertTrue(result.close)
    assertNull(result.tuneTo)
  }

  @Test
  fun `episodio so vale dentro do catalogo`() {
    val result = reduceMenu(channels, MenuEvent.ActivateEpisode(3))
    assertEquals(channels, result.state)
    assertNull(result.playFrom)
    assertFalse(result.close)
  }

  @Test
  fun `canal so vale na lista de canais`() {
    val activate = reduceMenu(episodes, MenuEvent.ActivateChannel(12))
    assertEquals(episodes, activate.state)
    assertNull(activate.tuneTo)
    assertFalse(activate.close)

    val drill = reduceMenu(episodes, MenuEvent.DrillChannel(12))
    assertEquals(episodes, drill.state)
    assertNull(drill.loadEpisodes)
  }

  @Test
  fun `fechar por canal e por episodio deixa o menu no mesmo lugar`() {
    val byChannel = reduceMenu(channels, MenuEvent.ActivateChannel(12)).state
    val byEpisode = reduceMenu(episodes, MenuEvent.ActivateEpisode(0)).state
    assertEquals(byChannel, byEpisode)
    // E o proximo `Open` recomeca dos canais, nao do catalogo de onde saiu.
    assertEquals(MenuLevel.Channels, reduceMenu(byEpisode, MenuEvent.Open).state.level)
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

  // Linhas do menu

  @Test
  fun `linha de canal traz numero e nome de um lado e a contagem do outro`() {
    val channel = ChannelSummary(number = 7, name = "ThunderCats", episodeCount = 52)
    assertEquals(Pair("07  THUNDERCATS", "52 EP >"), formatMenuChannelRow(channel))
  }

  @Test
  fun `linha de episodio usa o rotulo do OSD e o selo`() {
    assertEquals(Pair("S02E14", "4K"), formatMenuEpisodeRow(ep(height = 2160)))
  }

  @Test
  fun `episodio sem selo deixa a coluna da direita vazia`() {
    assertEquals(Pair("S02E14", ""), formatMenuEpisodeRow(ep(height = 480)))
  }

  @Test
  fun `episodio sem numeracao cai no titulo, igual ao OSD`() {
    val row = formatMenuEpisodeRow(ep(title = "Especial de Natal", season = null, episode = null))
    assertEquals(Pair("ESPECIAL DE NATAL", ""), row)
  }

  // Modo de apresentacao

  @Test
  fun `widescreen e o unico valor que sai do CRT`() {
    assertEquals(DisplayMode.WIDESCREEN, DisplayMode.from("widescreen"))
    assertEquals(DisplayMode.CRT, DisplayMode.from("crt"))
  }

  @Test
  fun `modo desconhecido cai no CRT em vez de quebrar`() {
    assertEquals(DisplayMode.CRT, DisplayMode.from("holografico"))
    assertEquals(DisplayMode.CRT, DisplayMode.from(""))
    assertEquals(DisplayMode.CRT, DisplayMode.from("WIDESCREEN"))
  }

  @Test
  fun `servidor que nao respondeu vale CRT`() {
    assertEquals(DisplayMode.CRT, DisplayMode.from(null))
  }
}
