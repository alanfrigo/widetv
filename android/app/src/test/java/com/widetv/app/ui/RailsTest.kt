package com.widetv.app.ui

import com.widetv.app.net.ChannelSummary
import com.widetv.app.net.EpisodeRef
import com.widetv.app.net.NowPlaying
import com.widetv.app.net.ResumeEntry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Montagem das tres faixas do catalogo e do hero.
 *
 * O que cada card mostra e decisao: a faixa ao vivo tem selo de canal e nao tem
 * botao de play, a de retomada e o contrario, e a do acervo obedece a busca.
 * Tudo isso cabe aqui, longe de qualquer ViewHolder.
 */
class RailsTest {

  private val serverTimeMs = 1_700_000_000_000L
  private val nowMs = serverTimeMs + 60_000L

  private fun ep(
    id: String = "a",
    title: String = "O roubo do século",
    season: Int? = 1,
    episode: Int? = 8,
    durationMs: Long = 24 * 60_000L,
    thumbUrl: String? = null,
  ) = EpisodeRef(
    id = id,
    title = title,
    season = season,
    episode = episode,
    durationMs = durationMs,
    thumbUrl = thumbUrl,
  )

  private fun ch(
    number: Int = 7,
    name: String = "ThunderCats",
    year: Int? = 1985,
    episodeCount: Int = 130,
    backdropUrl: String? = "/api/channels/7/backdrop",
    posterUrl: String? = "/api/channels/7/poster",
  ) = ChannelSummary(
    number = number,
    name = name,
    episodeCount = episodeCount,
    posterUrl = posterUrl,
    year = year,
    backdropUrl = backdropUrl,
  )

  private fun playing(
    channel: ChannelSummary = ch(),
    offsetMs: Long = 5 * 60_000L,
    endsInMs: Long = 4 * 60_000L,
    episode: EpisodeRef = ep(),
  ) = NowPlaying(
    channel = channel,
    episode = episode,
    offsetMs = offsetMs,
    serverTimeMs = serverTimeMs,
    endsAtMs = nowMs + endsInMs,
    next = ep(id = "b", title = "A fuga", episode = 9),
  )

  // Faixa "No ar agora"

  @Test
  fun `o card ao vivo traz canal, episodio e quanto falta`() {
    val card = liveRail(listOf(playing()), nowMs).single()
    assertEquals(7, card.channelNumber)
    assertEquals("ThunderCats", card.name)
    assertEquals("S01E08 · O roubo do século", card.sub)
    assertEquals("07", card.chan)
    assertEquals("faltam 4 min", card.time)
    assertTrue(card.live)
    assertEquals("/api/channels/7/backdrop", card.artUrl)
  }

  @Test
  fun `o card ao vivo nao tem botao de play nem selo de tempo restante`() {
    // A grade nao para: um botao de play prometeria um gesto que nao existe.
    val card = liveRail(listOf(playing()), nowMs).single()
    assertFalse(card.play)
    assertNull(card.left)
  }

  @Test
  fun `a barra projeta a posicao ate agora, e nao a do request`() {
    // 5 min quando o servidor calculou, mais 1 min de estrada = 6 de 24 min.
    val card = liveRail(listOf(playing()), nowMs).single()
    assertEquals(BAR_MAX / 4, card.progress)
  }

  @Test
  fun `episodio acabando nao promete minutos que nao existem`() {
    val card = liveRail(listOf(playing(endsInMs = 0)), nowMs).single()
    assertEquals("acabando", card.time)
  }

  @Test
  fun `canal sem arte cai no padrao listrado`() {
    val card = liveRail(listOf(playing(channel = ch(backdropUrl = null))), nowMs).single()
    assertNull(card.artUrl)
  }

  @Test
  fun `o card ao vivo prefere o quadro do episodio a arte da serie`() {
    // O desenho mostra "frame do episodio" nesta faixa: ela fala do que esta
    // passando agora, e a arte da serie e a mesma em todos os episodios.
    val card = liveRail(
      listOf(playing(episode = ep(thumbUrl = "/api/stream/x/thumb"))),
      nowMs,
    ).single()
    assertEquals("/api/stream/x/thumb", card.artUrl)
  }

  @Test
  fun `episodio ainda sem quadro cai na arte da serie, e nao no listrado`() {
    // A fila do servidor leva minutos ate cobrir o acervo; 404 no quadro nao e
    // erro, e o card tem uma segunda melhor imagem para mostrar enquanto isso.
    val card = liveRail(listOf(playing(episode = ep(thumbUrl = null))), nowMs).single()
    assertEquals("/api/channels/7/backdrop", card.artUrl)
  }

  @Test
  fun `sem quadro e sem arte da serie, o card fica listrado`() {
    val card = liveRail(
      listOf(playing(channel = ch(backdropUrl = null), episode = ep(thumbUrl = null))),
      nowMs,
    ).single()
    assertNull(card.artUrl)
  }

  @Test
  fun `a faixa segue a ordem do catalogo`() {
    val cards = liveRail(
      listOf(playing(channel = ch(number = 3)), playing(channel = ch(number = 1))),
      nowMs,
    )
    assertEquals(listOf(3, 1), cards.map { it.channelNumber })
  }

  // Faixa "Continuar assistindo"

  private fun entry(
    positionMs: Long = 12 * 60_000L,
    durationMs: Long = 24 * 60_000L,
    backdropUrl: String? = "/api/channels/7/backdrop",
    episode: EpisodeRef = ep(),
  ) = ResumeEntry(
    channelNumber = 7,
    channelName = "ThunderCats",
    posterUrl = "/api/channels/7/poster",
    backdropUrl = backdropUrl,
    episode = episode,
    positionMs = positionMs,
    durationMs = durationMs,
    updatedAt = nowMs,
  )

  @Test
  fun `o card de retomada tem play e tempo restante, e nao tem selo de canal`() {
    val card = resumeRail(listOf(entry())).single()
    assertTrue(card.play)
    assertEquals("12 min", card.left)
    assertNull(card.chan)
    assertFalse(card.live)
    // A terceira linha de texto e do ao vivo; aqui ela nao existe.
    assertNull(card.time)
  }

  @Test
  fun `a barra de retomada e a fracao ja assistida`() {
    assertEquals(BAR_MAX / 2, resumeRail(listOf(entry())).single().progress)
  }

  @Test
  fun `sem duracao na entrada vale a do episodio`() {
    // O servidor pode nao ter medido a entrada; o `EpisodeRef` ja traz a medida.
    val card = resumeRail(listOf(entry(durationMs = 0))).single()
    assertEquals(BAR_MAX / 2, card.progress)
  }

  @Test
  fun `sem historico nenhum a faixa fica vazia e some da tela`() {
    assertTrue(resumeRail(emptyList()).isEmpty())
  }

  @Test
  fun `o card de retomada tambem prefere o quadro do episodio`() {
    val card = resumeRail(
      listOf(entry(episode = ep(thumbUrl = "/api/stream/x/thumb"))),
    ).single()
    assertEquals("/api/stream/x/thumb", card.artUrl)
  }

  @Test
  fun `retomada sem quadro cai na arte da serie`() {
    assertEquals("/api/channels/7/backdrop", resumeRail(listOf(entry())).single().artUrl)
  }

  @Test
  fun `retomada sem quadro e sem arte fica listrada`() {
    val card = resumeRail(listOf(entry(backdropUrl = null))).single()
    assertNull(card.artUrl)
  }

  // Faixa "Todo o acervo"

  private val shelf = listOf(
    ch(number = 1, name = "O Sítio do Picapau Amarelo", year = 1977, episodeCount = 142),
    ch(number = 7, name = "ThunderCats", year = 1985, episodeCount = 130),
    ch(number = 12, name = "Cowboy Bebop", year = 1998, episodeCount = 26),
  )

  @Test
  fun `sem busca o acervo aparece inteiro, na ordem que chegou`() {
    val cards = shelfRail(shelf)
    assertEquals(listOf(1, 7, 12), cards.map { it.channelNumber })
    assertEquals("01", cards[0].chan)
    assertEquals("1977 · 142 EP", cards[0].meta)
    assertEquals("/api/channels/7/poster", cards[1].posterUrl)
  }

  @Test
  fun `a busca ignora acento e caixa`() {
    // Num controle remoto ninguem vai atras do til.
    assertEquals(listOf(1), shelfRail(shelf, "sitio").map { it.channelNumber })
    assertEquals(listOf(1), shelfRail(shelf, "SÍTIO").map { it.channelNumber })
  }

  @Test
  fun `a busca casa no meio do nome`() {
    assertEquals(listOf(12), shelfRail(shelf, "bebop").map { it.channelNumber })
  }

  @Test
  fun `busca sem resultado devolve faixa vazia`() {
    assertTrue(shelfRail(shelf, "zzz").isEmpty())
  }

  @Test
  fun `espaco em branco nao filtra nada`() {
    assertEquals(3, shelfRail(shelf, "   ").size)
  }

  // Hero

  @Test
  fun `o hero anuncia o canal e o que esta tocando nele`() {
    val hero = heroFor(ch(), playing(), nowMs)
    assertEquals(7, hero.channelNumber)
    assertEquals("Canal 07 · no ar agora", hero.chip)
    assertEquals("ThunderCats", hero.title)
    assertEquals("1985 · 130 episodios", hero.meta)
    assertEquals("/api/channels/7/backdrop", hero.artUrl)
  }

  @Test
  fun `a frase do hero conta ha quanto tempo e o que vem depois`() {
    assertEquals(
      "Está tocando S01E08 há 6 minutos. A seguir, S01E09, faltam 4 min.",
      formatHeroText(ch(), playing(), nowMs),
    )
  }

  @Test
  fun `um minuto no ar nao vira minutos`() {
    val text = formatHeroText(ch(), playing(offsetMs = 0), serverTimeMs + 60_000L)
    assertTrue(text.startsWith("Está tocando S01E08 há 1 minuto."))
  }

  @Test
  fun `episodio recem-comecado esta comecando`() {
    val text = formatHeroText(ch(), playing(offsetMs = 0), serverTimeMs)
    assertTrue(text.startsWith("Está começando S01E08 agora."))
  }

  @Test
  fun `sem a grade na mao o hero cai na sinopse`() {
    val channel = ch().copy(overview = "Gatos do espaço.")
    val hero = heroFor(channel, null, nowMs)
    assertEquals("Gatos do espaço.", hero.text)
    // E a pilula para de anunciar um ao vivo que ninguem confirmou.
    assertEquals("Canal 07 · no acervo", hero.chip)
  }

  @Test
  fun `sem grade e sem sinopse o hero fica sem frase, e nao com uma inventada`() {
    assertEquals("", heroFor(ch(), null, nowMs).text)
  }

  @Test
  fun `o hero fica na arte do canal mesmo com quadro do episodio na mao`() {
    // Ao contrario dos cards: o painel tem 465dp de altura, e um quadro de
    // 480x270 esticado ate la sairia borrado — alem de trocar o fundo da tela
    // inteira a cada episodio da grade.
    val hero = heroFor(ch(), playing(episode = ep(thumbUrl = "/api/stream/x/thumb")), nowMs)
    assertEquals("/api/channels/7/backdrop", hero.artUrl)
  }

  // Botao primario da serie

  @Test
  fun `o botao da serie diz de onde vai continuar`() {
    assertEquals("Continuar S01E08", seriesResumeLabel(entry()))
    assertEquals("Do início", seriesResumeLabel(null))
  }

  // Escala das barras

  @Test
  fun `a barra usa a escala do layout e nunca estoura`() {
    assertEquals(0, barProgress(0, 100))
    assertEquals(BAR_MAX, barProgress(100, 100))
    assertEquals(BAR_MAX, barProgress(500, 100))
    assertEquals(0, barProgress(50, 0))
    assertEquals(0, barProgress(-10, 100))
  }
}
