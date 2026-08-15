package com.widetv.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Texto e numeros do acervo e da tela de serie. */
class CatalogTest {

  // Card do acervo

  @Test
  fun `card junta ano e contagem`() {
    assertEquals("2025 · 22 EP", formatCardMeta(2025, 22))
  }

  @Test
  fun `sem ano o card mostra so a contagem`() {
    assertEquals("22 EP", formatCardMeta(null, 22))
  }

  // Cabecalho da serie

  @Test
  fun `serie escreve episodios por extenso`() {
    assertEquals("2025 · 22 episodios", formatSeriesMeta(2025, 22))
  }

  @Test
  fun `um episodio nao vira episodios`() {
    assertEquals("1 episodio", formatSeriesMeta(null, 1))
  }

  // Duracao

  @Test
  fun `menos de uma hora sai em minutos`() {
    assertEquals("42 min", formatDuration(42 * 60_000L))
  }

  @Test
  fun `mais de uma hora ganha as duas unidades`() {
    assertEquals("1 h 12 min", formatDuration(72 * 60_000L))
  }

  @Test
  fun `hora redonda nao mostra zero minuto`() {
    assertEquals("2 h", formatDuration(120 * 60_000L))
  }

  @Test
  fun `episodio de segundos nao vira zero minuto`() {
    assertEquals("1 min", formatDuration(30_000L))
  }

  @Test
  fun `duracao desconhecida nao inventa numero`() {
    assertEquals("", formatDuration(0))
    assertEquals("", formatDuration(-1))
  }

  // Iniciais do placeholder

  @Test
  fun `duas palavras viram duas letras`() {
    assertEquals("BB", initialsOf("Breaking Bad"))
  }

  @Test
  fun `uma palavra so vira uma letra`() {
    assertEquals("T", initialsOf("ThunderCats"))
  }

  @Test
  fun `mais de duas palavras param na segunda`() {
    assertEquals("OS", initialsOf("O Sitio do Picapau Amarelo"))
  }

  @Test
  fun `hifen e dois-pontos separam como espaco`() {
    assertEquals("CB", initialsOf("Cowboy-Bebop"))
    assertEquals("SW", initialsOf("Star Wars: A Nova Esperanca"))
  }

  @Test
  fun `numero no comeco do nome conta como inicial`() {
    assertEquals("2", initialsOf("24"))
  }

  @Test
  fun `nome sem letra nem digito nao gera inicial`() {
    assertEquals("", initialsOf("!!!"))
    assertEquals("", initialsOf(""))
  }

  // Reducao da capa

  @Test
  fun `capa quase do tamanho do card nao e reduzida`() {
    assertEquals(1, sampleSizeFor(400, 400))
    assertEquals(1, sampleSizeFor(600, 400))
  }

  @Test
  fun `capa do dobro do card e reduzida pela metade`() {
    assertEquals(2, sampleSizeFor(800, 400))
  }

  @Test
  fun `a reducao para no ultimo passo que ainda cobre o card`() {
    // 1600/4 = 400, exatamente o alvo; 1600/8 = 200 ficaria borrado no foco.
    assertEquals(4, sampleSizeFor(1600, 400))
    assertEquals(2, sampleSizeFor(1500, 400))
  }

  @Test
  fun `medida ausente nao divide por zero`() {
    assertEquals(1, sampleSizeFor(0, 400))
    assertEquals(1, sampleSizeFor(800, 0))
    assertEquals(1, sampleSizeFor(-1, -1))
  }

  @Test
  fun `a reducao e sempre potencia de dois`() {
    for (source in 100..4000 step 37) {
      val sample = sampleSizeFor(source, 200)
      assertTrue("$source -> $sample", sample > 0 && (sample and (sample - 1)) == 0)
    }
  }
}
