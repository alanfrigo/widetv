package com.widetv.app.net

import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Contrato da montagem de URL para paths que chegam PRONTOS do servidor
 * (`posterUrl`, `backdropUrl`, `thumbUrl`), consumidos por `ApiClient.bytes`.
 *
 * As duas regressoes que este teste congela eram 404 silencioso em TODOS os
 * cards (o 404 vira null, o null vira placeholder, sem log):
 * - o cache-buster `?v=` do poster/backdrop encodado como `%3F` virava parte do
 *   path e a rota do Fastify nao casava;
 * - o `thumbUrl` de episodio ja vem percent-encoded (`%2F`, `%20`) e o
 *   `addPathSegments` re-encodava o `%` (`%252F`), fazendo o servidor procurar
 *   um episodio que nao existe.
 */
class ResolveServerPathTest {

  private val base = "http://100.72.112.101:8766/".toHttpUrl()

  @Test
  fun `query de cache-buster do poster continua query, nunca vira parte do path`() {
    val url = resolveServerPath(base, "/api/channels/7/poster?v=1723456789000")
    assertEquals("/api/channels/7/poster", url.encodedPath)
    assertEquals("v=1723456789000", url.encodedQuery)
  }

  @Test
  fun `thumbUrl ja percent-encodado nao e re-encodado - o porcento nao e escapado de novo`() {
    val url = resolveServerPath(
      base,
      "/api/stream/The%20Simpsons%2FSeason%2037%2FS37E01.mkv/thumb",
    )
    assertEquals("/api/stream/The%20Simpsons%2FSeason%2037%2FS37E01.mkv/thumb", url.encodedPath)
    assertNull(url.encodedQuery)
  }

  @Test
  fun `backdrop com cache-buster junta os dois casos - encoding preservado e query separada`() {
    val url = resolveServerPath(base, "/api/channels/12/backdrop?v=99")
    assertEquals("/api/channels/12/backdrop", url.encodedPath)
    assertEquals("v=99", url.encodedQuery)
    assertEquals("http://100.72.112.101:8766/api/channels/12/backdrop?v=99", url.toString())
  }

  @Test
  fun `path simples sem query nem encoding segue funcionando - caso do Routes-backdrop`() {
    val url = resolveServerPath(base, Routes.backdrop(7))
    assertEquals("/api/channels/7/backdrop", url.encodedPath)
    assertNull(url.encodedQuery)
  }

  @Test
  fun `barra inicial e opcional, como o contrato de bytes promete`() {
    assertEquals(
      resolveServerPath(base, "/api/channels/7/poster?v=1"),
      resolveServerPath(base, "api/channels/7/poster?v=1"),
    )
  }
}
