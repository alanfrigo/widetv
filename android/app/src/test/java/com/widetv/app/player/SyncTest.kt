package com.widetv.app.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Porte de `tests/web/sync.test.ts`. Os mesmos casos, os mesmos numeros: se um
 * dia os dois clientes discordarem, a divergencia aparece aqui e nao na TV.
 */
class SyncTest {

  private fun sample(
    serverTimeMs: Long = 1_000_000,
    offsetMs: Long = 60_000,
    durationMs: Long = 1_320_000,
    sentAtMs: Long = 500_000,
    receivedAtMs: Long = 500_200,
  ) = NowSample(serverTimeMs, offsetMs, durationMs, sentAtMs, receivedAtMs)

  // estimateSkewMs

  @Test
  fun `assume que o servidor carimbou no meio do round-trip`() {
    // Enviado em 500000, recebido em 500200: o carimbo do servidor vale para 500100.
    // Servidor disse 1000000, entao o relogio dele esta 499900ms adiante do local.
    assertEquals(499_900, estimateSkewMs(sample()))
  }

  @Test
  fun `round-trip zero deixa o skew ser a diferenca crua`() {
    assertEquals(500_000, estimateSkewMs(sample(sentAtMs = 500_000, receivedAtMs = 500_000)))
  }

  @Test
  fun `skew negativo quando o relogio local esta adiantado`() {
    val s = sample(serverTimeMs = 1_000_000, sentAtMs = 1_100_000, receivedAtMs = 1_100_000)
    assertEquals(-100_000, estimateSkewMs(s))
  }

  // expectedOffsetMs

  @Test
  fun `no instante da resposta o esperado e o offset que veio do servidor`() {
    val s = sample()
    assertEquals(60_100, expectedOffsetMs(s, s.receivedAtMs))
  }

  @Test
  fun `avanca 1 para 1 com o relogio local`() {
    val s = sample()
    assertEquals(70_100, expectedOffsetMs(s, s.receivedAtMs + 10_000))
  }

  @Test
  fun `nao satura na duracao do episodio pois passar do fim e o sinal de trocar`() {
    val s = sample(offsetMs = 1_319_000, durationMs = 1_320_000)
    assertTrue(expectedOffsetMs(s, s.receivedAtMs + 5_000) > s.durationMs)
  }

  // decideCorrection

  @Test
  fun `drift dentro da banda morta nao faz nada`() {
    val d = decideCorrection(DRIFT_DEADBAND_MS - 1, 1f)
    assertEquals(CorrectionAction.NONE, d.action)
    assertEquals(1f, d.playbackRate, 0f)
  }

  @Test
  fun `atrasado alem da banda morta acelera o playback`() {
    // drift negativo = video atras do esperado = precisa correr
    val d = decideCorrection(-800, 1f)
    assertEquals(CorrectionAction.RATE, d.action)
    assertEquals(1f + RATE_CORRECTION, d.playbackRate, 1e-6f)
  }

  @Test
  fun `adiantado alem da banda morta desacelera o playback`() {
    val d = decideCorrection(800, 1f)
    assertEquals(CorrectionAction.RATE, d.action)
    assertEquals(1f - RATE_CORRECTION, d.playbackRate, 1e-6f)
  }

  @Test
  fun `drift grande demais para corrigir por velocidade vira seek`() {
    val d = decideCorrection(DRIFT_SEEK_MS + 1, 1f)
    assertEquals(CorrectionAction.SEEK, d.action)
    assertEquals(1f, d.playbackRate, 0f)
  }

  @Test
  fun `seek tambem para drift grande negativo`() {
    assertEquals(CorrectionAction.SEEK, decideCorrection(-(DRIFT_SEEK_MS + 1), 1f).action)
  }

  @Test
  fun `mantem a correcao ate zerar de verdade para nao oscilar na borda`() {
    val d = decideCorrection(-(DRIFT_DEADBAND_MS - 50), 1f + RATE_CORRECTION)
    assertEquals(CorrectionAction.RATE, d.action)
    assertEquals(1f + RATE_CORRECTION, d.playbackRate, 1e-6f)
  }

  @Test
  fun `solta a correcao quando entra na histerese`() {
    val d = decideCorrection(DRIFT_HYSTERESIS_MS - 1, 1f + RATE_CORRECTION)
    assertEquals(CorrectionAction.NONE, d.action)
    assertEquals(1f, d.playbackRate, 0f)
  }

  @Test
  fun `inverte o sentido da correcao sem passar por 1`() {
    val d = decideCorrection(-800, 1f - RATE_CORRECTION)
    assertEquals(1f + RATE_CORRECTION, d.playbackRate, 1e-6f)
  }

  @Test
  fun `reporta o drift recebido para telemetria`() {
    assertEquals(-1234, decideCorrection(-1234, 1f).driftMs)
  }
}
