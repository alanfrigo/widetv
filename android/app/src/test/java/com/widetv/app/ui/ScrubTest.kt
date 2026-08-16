package com.widetv.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Mesmo desenho do `TunerTest`: o toque solto age na hora, a tecla presa so
 * move um alvo, e o seek de verdade sai UMA vez, pelo tick, depois da espera.
 */
class ScrubTest {

  /** Um episodio de uma hora. */
  private val hourMs = 3_600_000L

  private fun step(
    state: ScrubState,
    delta: Int,
    repeatCount: Int,
    atMs: Long = 0,
    durationMs: Long = hourMs,
  ) = reduceScrub(state, ScrubEvent.Step(delta, repeatCount, atMs), durationMs)

  private fun tick(state: ScrubState, atMs: Long, durationMs: Long = hourMs) =
    reduceScrub(state, ScrubEvent.Tick(atMs), durationMs)

  // toque solto

  @Test
  fun `primeiro toque salta 10s na hora`() {
    val r = step(initialScrub(60_000), 1, repeatCount = 0)
    assertEquals(70_000L, r.seekTo)
    assertEquals(70_000L, r.state.basePositionMs)
    assertNull(r.state.targetMs)
  }

  @Test
  fun `toque solto para tras volta 10s`() {
    assertEquals(50_000L, step(initialScrub(60_000), -1, repeatCount = 0).seekTo)
  }

  // aceleracao

  @Test
  fun `segurar acelera em degraus`() {
    assertEquals(10_000L, scrubStepMs(0))
    assertEquals(10_000L, scrubStepMs(5))
    assertEquals(30_000L, scrubStepMs(6))
    assertEquals(30_000L, scrubStepMs(15))
    assertEquals(60_000L, scrubStepMs(16))
  }

  @Test
  fun `tecla presa move o alvo sem emitir seek`() {
    val r = step(initialScrub(60_000), 1, repeatCount = 8)
    assertNull(r.seekTo)
    assertEquals(90_000L, r.preview)
    assertEquals(90_000L, r.state.targetMs)
  }

  @Test
  fun `passos presos acumulam a partir do alvo anterior`() {
    val a = step(initialScrub(60_000), 1, repeatCount = 8, atMs = 0)
    val b = step(a.state, 1, repeatCount = 9, atMs = 50)
    assertEquals(120_000L, b.preview)
    assertNull(b.seekTo)
  }

  // commit por ociosidade

  @Test
  fun `tick depois da espera emite um unico seek no alvo`() {
    val a = step(initialScrub(60_000), 1, repeatCount = 8, atMs = 0)
    val commit = tick(a.state, SCRUB_COMMIT_DELAY_MS)
    assertEquals(90_000L, commit.seekTo)
    assertEquals(90_000L, commit.state.basePositionMs)
    assertNull(commit.state.targetMs)

    // O tick seguinte nao repete o seek: o estado voltou ao repouso.
    val depois = tick(commit.state, SCRUB_COMMIT_DELAY_MS + 100)
    assertNull(depois.seekTo)
  }

  @Test
  fun `tick antes do prazo nao emite e mantem o preview`() {
    val a = step(initialScrub(60_000), 1, repeatCount = 8, atMs = 0)
    val cedo = tick(a.state, SCRUB_COMMIT_DELAY_MS - 1)
    assertNull(cedo.seekTo)
    assertEquals(90_000L, cedo.preview)
    assertEquals(90_000L, cedo.state.targetMs)
  }

  @Test
  fun `passo novo reinicia a contagem do commit`() {
    val a = step(initialScrub(60_000), 1, repeatCount = 8, atMs = 0)
    val b = step(a.state, 1, repeatCount = 9, atMs = 200)
    val aindaNao = tick(b.state, 200 + SCRUB_COMMIT_DELAY_MS - 1)
    assertNull(aindaNao.seekTo)
    val agora = tick(b.state, 200 + SCRUB_COMMIT_DELAY_MS)
    assertEquals(120_000L, agora.seekTo)
  }

  // clamp nas bordas

  @Test
  fun `nao passa do fim do episodio`() {
    val r = step(initialScrub(hourMs - 5_000), 1, repeatCount = 16)
    assertEquals(hourMs, r.preview)
    assertEquals(hourMs, r.state.targetMs)
  }

  @Test
  fun `nao volta antes do zero`() {
    assertEquals(0L, step(initialScrub(5_000), -1, repeatCount = 0).seekTo)
  }

  @Test
  fun `commit tambem respeita as bordas`() {
    val a = step(initialScrub(hourMs - 5_000), 1, repeatCount = 16)
    val commit = tick(a.state, SCRUB_COMMIT_DELAY_MS)
    assertEquals(hourMs, commit.seekTo)
  }

  @Test
  fun `duracao desconhecida so trava no zero`() {
    val r = step(initialScrub(0), 1, repeatCount = 0, durationMs = 0)
    assertEquals(10_000L, r.seekTo)
  }

  @Test
  fun `tick sem alvo pendente e inofensivo`() {
    val r = tick(initialScrub(60_000), 999_999)
    assertNull(r.seekTo)
    assertNull(r.preview)
  }
}
