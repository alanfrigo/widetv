package com.widetv.app.ui

import com.widetv.app.net.AudioTrackRef
import com.widetv.app.net.EpisodeRef
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Abas de temporada, o resumo da direita e a linha de episodio.
 *
 * Agrupar por temporada e a unica decisao da tela de serie, e e o tipo de coisa
 * que so aparece errada com acervo de verdade: pasta sem temporada no meio,
 * servidor antigo que nao manda `seasons`, episodio sem numeracao.
 */
class SeasonsTest {

  private fun ep(
    id: String,
    season: Int? = 1,
    episode: Int? = 1,
    title: String = "Episodio",
    durationMs: Long = 24 * 60_000L,
    height: Int? = null,
    audios: Int = 1,
    thumbUrl: String? = null,
  ) = EpisodeRef(
    id = id,
    title = title,
    season = season,
    episode = episode,
    durationMs = durationMs,
    height = height,
    audioTracks = List(audios) { AudioTrackRef(index = it) },
    thumbUrl = thumbUrl,
  )

  /** Duas temporadas de dois episodios cada, mais um solto. */
  private val library = listOf(
    ep("s1e1", season = 1, episode = 1),
    ep("s1e2", season = 1, episode = 2),
    ep("s2e1", season = 2, episode = 1),
    ep("s2e2", season = 2, episode = 2),
    ep("solto", season = null, episode = null, title = "Especial de Natal"),
  )

  // Abas

  @Test
  fun `as abas saem das temporadas do canal, em ordem`() {
    val tabs = seasonTabs(listOf(2, 1), library.take(4))
    assertEquals(listOf("Temporada 1", "Temporada 2"), tabs.map { it.label })
    assertEquals(listOf(1, 2), tabs.map { it.season })
    assertEquals(listOf(2, 2), tabs.map { it.count })
  }

  @Test
  fun `episodio solto vira a aba Sem temporada, no fim`() {
    val tabs = seasonTabs(listOf(1, 2), library)
    assertEquals("Sem temporada · 1", tabs.last().label)
    assertNull(tabs.last().season)
    assertEquals(1, tabs.last().count)
  }

  @Test
  fun `servidor sem o campo seasons deduz as abas dos episodios`() {
    // Um servidor mais antigo manda `seasons` vazio. A barra tem que nascer
    // igual: a informacao esta na propria lista.
    val tabs = seasonTabs(emptyList(), library)
    assertEquals(listOf("Temporada 1", "Temporada 2", "Sem temporada · 1"), tabs.map { it.label })
  }

  @Test
  fun `temporada anunciada antes de os episodios chegarem ja aparece`() {
    val tabs = seasonTabs(listOf(1, 2, 3), emptyList())
    assertEquals(3, tabs.size)
    assertEquals(listOf(0, 0, 0), tabs.map { it.count })
  }

  @Test
  fun `serie sem temporada nenhuma nao ganha barra de abas`() {
    // Uma aba so, que filtra tudo, e um controle que nao faz nada.
    val flat = listOf(ep("a", season = null), ep("b", season = null))
    assertTrue(seasonTabs(emptyList(), flat).isEmpty())
  }

  // Filtro

  @Test
  fun `a aba filtra pelos indices da lista inteira do canal`() {
    // Indices, e nao episodios: a maratona continua para dentro da temporada
    // seguinte, e a posicao filtrada tocaria o episodio errado.
    assertEquals(listOf(2, 3), seasonIndices(library, 2))
    assertEquals(listOf(4), seasonIndices(library, null))
  }

  @Test
  fun `sem abas na tela o filtro devolve o canal inteiro`() {
    assertEquals(library.indices.toList(), seasonIndices(library, null, hasTabs = false))
  }

  // Resumo da direita

  @Test
  fun `o resumo conta episodios e soma a duracao`() {
    // 2 x 24 min = 48 min.
    assertEquals("2 episódios · 48min", seasonAside(library, seasonIndices(library, 1)))
  }

  @Test
  fun `temporada longa sai em horas e minutos`() {
    val long = List(26) { ep("e$it", episode = it + 1) }
    // 26 x 24 min = 624 min = 10h 24min.
    assertEquals("26 episódios · 10h 24min", seasonAside(long, long.indices.toList()))
  }

  @Test
  fun `um episodio nao vira episodios`() {
    assertEquals("1 episódio · 24min", seasonAside(library, listOf(0)))
  }

  @Test
  fun `sem duracao medida o resumo so conta`() {
    val unprobed = listOf(ep("a", durationMs = 0), ep("b", durationMs = 0))
    assertEquals("2 episódios", seasonAside(unprobed, unprobed.indices.toList()))
  }

  @Test
  fun `hora redonda nao mostra zero minuto`() {
    assertEquals("3h", formatSeasonSpan(3 * 60 * 60_000L))
    assertEquals("45min", formatSeasonSpan(45 * 60_000L))
    assertEquals("", formatSeasonSpan(0))
  }

  // Meta do cabecalho

  @Test
  fun `o cabecalho anuncia temporadas so quando ha mais de uma`() {
    assertEquals("1989 · 3 temporadas · 142 episodios", formatSeasonsMeta(1989, 3, 142))
    assertEquals("1989 · 142 episodios", formatSeasonsMeta(1989, 1, 142))
    assertEquals("142 episodios", formatSeasonsMeta(null, 0, 142))
  }

  // Linha de episodio

  @Test
  fun `a linha carrega o indice da lista inteira, e nao o da aba`() {
    val items = episodeItems(library, seasonIndices(library, 2))
    assertEquals(listOf(2, 3), items.map { it.index })
  }

  @Test
  fun `o numero vem do arquivo e, sem ele, da posicao na fila`() {
    val items = episodeItems(library, listOf(0, 4))
    assertEquals("01", items[0].number)
    // O especial nao tem numeracao: sobra a posicao, que e a unica ordem real.
    assertEquals("05", items[1].number)
  }

  @Test
  fun `os selos so aparecem quando dizem alguma coisa`() {
    val rich = listOf(ep("a", height = 1080, audios = 3), ep("b", height = 480, audios = 1))
    val items = episodeItems(rich, rich.indices.toList())
    assertEquals("1080p", items[0].badge)
    assertEquals("3 áudios", items[0].tracks)
    // 480p nao muda a expectativa de ninguem, e "1 áudio" nao e escolha.
    assertNull(items[1].badge)
    assertNull(items[1].tracks)
  }

  @Test
  fun `episodio no meio mostra quanto falta e a barra na fracao certa`() {
    val items = episodeItems(library, listOf(0), mapOf("s1e1" to 12 * 60_000L))
    assertEquals("faltam 12 min", items[0].state)
    assertEquals(BAR_MAX / 2, items[0].progress)
  }

  @Test
  fun `parar perto do fim conta como assistido`() {
    // Ninguem assiste os creditos: 23 de 24 minutos e ter terminado.
    val items = episodeItems(library, listOf(0), mapOf("s1e1" to 23 * 60_000L + 30_000L))
    assertEquals("assistido", items[0].state)
  }

  @Test
  fun `episodio nunca aberto nao ganha estado nem barra`() {
    val items = episodeItems(library, listOf(1), mapOf("s1e1" to 12 * 60_000L))
    assertEquals("", items[0].state)
    assertEquals(0, items[0].progress)
  }

  @Test
  fun `indice fora da lista nao gera linha fantasma`() {
    assertTrue(episodeItems(library, listOf(99)).isEmpty())
  }

  @Test
  fun `a linha leva o quadro do episodio quando ele ja existe`() {
    val quadros = listOf(ep("s1e1", thumbUrl = "/api/stream/s1e1/thumb"))
    assertEquals("/api/stream/s1e1/thumb", episodeItems(quadros, listOf(0)).single().thumbUrl)
  }

  @Test
  fun `episodio ainda sem quadro fica listrado, e isso nao e erro`() {
    // A fila do servidor anda de um em um; a lista inteira nasce sem quadro e
    // vai ganhando as miniaturas conforme elas existem.
    assertNull(episodeItems(library, listOf(0)).single().thumbUrl)
  }
}
