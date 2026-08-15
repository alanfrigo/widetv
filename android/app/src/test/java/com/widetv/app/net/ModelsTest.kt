package com.widetv.app.net

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Tolerancia do espelho de `src/shared/api-types.ts`.
 *
 * O app e a mesma APK apontando para servidores de versoes diferentes: a TV da
 * sala pode estar falando com um servidor que ainda nao subiu, e o campo novo
 * simplesmente nao vem. A regra e uma so — nenhuma ausencia, e nenhum campo que
 * o servidor inventou depois, pode derrubar a desserializacao inteira.
 *
 * O `Json` daqui e o MESMO de `ApiClient`; ele e privado la, e repetir a
 * configuracao num teste que a exercita e o que impede alguem de tirar o
 * `ignoreUnknownKeys` sem nada avisar.
 */
class ModelsTest {

  private val json = Json { ignoreUnknownKeys = true }

  @Test
  fun `episodio de servidor antigo continua legivel, so sem quadro`() {
    val body = """{"id":"a/b.mkv","title":"Piloto","durationMs":1400000}"""
    val episode = json.decodeFromString<EpisodeRef>(body)
    assertEquals("a/b.mkv", episode.id)
    // null e "ainda nao gerei", e a tela cai no listrado sem reclamar.
    assertNull(episode.thumbUrl)
    assertTrue(episode.audioTracks.isEmpty())
  }

  @Test
  fun `campo que o servidor inventou depois nao derruba o episodio`() {
    val body = """{"id":"a","title":"t","durationMs":1,"chapterMarks":[3,9]}"""
    assertEquals("a", json.decodeFromString<EpisodeRef>(body).id)
  }

  @Test
  fun `o quadro chega como rota relativa, como o carregador de imagem espera`() {
    val body = """{"id":"a","title":"t","durationMs":1,"thumbUrl":"/api/stream/a/thumb"}"""
    assertEquals("/api/stream/a/thumb", json.decodeFromString<EpisodeRef>(body).thumbUrl)
  }

  @Test
  fun `configuracao sem o interruptor de miniaturas assume o padrao do servidor`() {
    val settings = json.decodeFromString<AppSettings>("""{"audioLang":"por"}""")
    assertTrue(settings.autoThumbs)
    assertFalse(settings.autoRemux)
  }

  @Test
  fun `o interruptor de miniaturas viaja nos dois sentidos`() {
    assertFalse(json.decodeFromString<AppSettings>("""{"autoThumbs":false}""").autoThumbs)
  }

  @Test
  fun `status sem a fila de quadros ainda entrega o progresso da varredura`() {
    // E o caso do servidor anterior ao subsistema de quadros: exigir a chave
    // `thumbs` derrubaria ate o que ele sabe responder.
    val body = """{"scan":{"state":"running","progress":{"done":3,"total":9,"show":"X"}}}"""
    val status = json.decodeFromString<LibraryStatus>(body)
    assertEquals(TASK_RUNNING, status.scan.state)
    assertEquals(3, status.scan.progress?.done)
    assertEquals(TASK_IDLE, status.thumbs.state)
    assertNull(status.thumbs.progress)
  }

  @Test
  fun `a fila de quadros chega com progresso e resumo da ultima rodada`() {
    val body = """
      {"scan":{"state":"idle"},
       "thumbs":{"state":"running",
                 "progress":{"done":312,"total":1840,"show":"The Simpsons"},
                 "last":{"considered":40,"generated":38,"skipped":1,"failed":1,
                         "durationMs":90000,"finishedAt":17}}}
    """.trimIndent()
    val status = json.decodeFromString<LibraryStatus>(body)
    assertEquals(TASK_RUNNING, status.thumbs.state)
    assertEquals(1840, status.thumbs.progress?.total)
    assertEquals(38, status.thumbs.last?.generated)
  }

  @Test
  fun `estado de tarefa desconhecido nao derruba o status`() {
    // `state` e String crua, e nao enum, justamente por isto: um estado novo no
    // servidor tiraria da tela ate o progresso que ela ja sabia mostrar.
    val status = json.decodeFromString<LibraryStatus>("""{"thumbs":{"state":"paused"}}""")
    assertEquals("paused", status.thumbs.state)
  }

  @Test
  fun `o patch do interruptor de miniaturas leva so a propria chave`() {
    // Chave fora do objeto significa "nao mexe": mandar o `AppSettings` inteiro
    // sobrescreveria a escolha que outra tela acabou de fazer.
    assertEquals("""{"autoThumbs":true}""", SettingsPatch.autoThumbs(true).toString())
  }
}
