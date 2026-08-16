package com.widetv.app.net

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Contrato do probe de `/api/stream/:id`, porte do `probeStream` do web.
 *
 * O 202 e o ponto da regressao: OkHttp o trata como 2xx "de sucesso", entao sem
 * esta classificacao o corpo JSON `{"preparing":true}` seguiria para o extractor
 * do ExoPlayer e viraria erro fatal - o loop de retune que travou a TV.
 */
class StreamProbeTest {

  @Test
  fun `200 e stream pronto`() {
    assertEquals(StreamProbe.READY, classifyProbe(200))
  }

  @Test
  fun `206 tambem e pronto - resposta parcial de um probe com Range`() {
    assertEquals(StreamProbe.READY, classifyProbe(206))
  }

  @Test
  fun `202 e preparando, nunca sucesso - apesar de ser 2xx para o OkHttp`() {
    assertEquals(StreamProbe.PREPARING, classifyProbe(202))
  }

  @Test
  fun `404 e 500 sao erro`() {
    assertEquals(StreamProbe.ERROR, classifyProbe(404))
    assertEquals(StreamProbe.ERROR, classifyProbe(500))
  }

  @Test
  fun `401 e erro - sessao vencida nao e arquivo pronto`() {
    assertEquals(StreamProbe.ERROR, classifyProbe(401))
  }
}
