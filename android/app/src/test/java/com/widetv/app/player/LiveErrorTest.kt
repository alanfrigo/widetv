package com.widetv.app.player

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Regressao do loop de retune: com a playlist ao vivo [atual, next], uma falha
 * de preparacao do `next` (ex.: stream respondendo 202 "preparando", cujo JSON
 * morre no extractor) e fatal para o ExoPlayer inteiro. Derrubar o canal por
 * isso repetia tune -> toca um pedaco -> erro -> retune a cada fronteira de
 * episodio; a decisao certa e tirar so o next da fila.
 */
class LiveErrorTest {

  @Test
  fun `atual tocando e next na fila - a culpa e do next, derruba so ele`() {
    assertEquals(
      LiveErrorAction.DROP_NEXT,
      decideLiveError(currentItemStarted = true, currentIndex = 0, mediaItemCount = 2),
    )
  }

  @Test
  fun `atual nunca abriu - foi ele que falhou, resintoniza`() {
    // E o caso do proprio episodio 202ando na sintonia: nao ha o que preservar.
    assertEquals(
      LiveErrorAction.RETUNE,
      decideLiveError(currentItemStarted = false, currentIndex = 0, mediaItemCount = 2),
    )
  }

  @Test
  fun `fila sem next - o erro so pode ser do proprio item no ar`() {
    assertEquals(
      LiveErrorAction.RETUNE,
      decideLiveError(currentItemStarted = true, currentIndex = 0, mediaItemCount = 1),
    )
  }

  @Test
  fun `tocando o ultimo item da fila - nao ha next para culpar nem remover`() {
    // Sem esta guarda, o "remove o que vem depois do atual" removeria o proprio
    // item que esta tocando.
    assertEquals(
      LiveErrorAction.RETUNE,
      decideLiveError(currentItemStarted = true, currentIndex = 1, mediaItemCount = 2),
    )
  }
}
