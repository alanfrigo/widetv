package com.widetv.app.tuner

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Porte de `tests/web/tuner.test.ts`, mais os casos que so existem no controle
 * remoto: aceleracao e commit por ociosidade do passo.
 *
 * O sintonizador so trabalha durante a reproducao ao vivo; no acervo e na tela
 * de serie quem anda e o foco do Android.
 */
class TunerTest {

  /** Canais 1, 2, 3, 7 e 12: com buracos, como acontece depois de remover uma serie. */
  private val channels = listOf(1, 2, 3, 7, 12)

  private fun digit(state: TunerState, value: Char, atMs: Long = 0) =
    reduceTuner(state, TunerEvent.Digit(value, atMs), channels)

  private fun tap(state: TunerState, delta: Int, list: List<Int> = channels) =
    reduceTuner(state, TunerEvent.Step(delta, repeatCount = 0, atMs = 0), list)

  // passo com as setas

  @Test
  fun `sobe para o proximo canal existente pulando buracos`() {
    assertEquals(7, tap(initialTuner(3), 1).tuneTo)
  }

  @Test
  fun `desce para o anterior existente`() {
    assertEquals(3, tap(initialTuner(7), -1).tuneTo)
  }

  @Test
  fun `do ultimo canal da a volta para o primeiro`() {
    assertEquals(1, tap(initialTuner(12), 1).tuneTo)
  }

  @Test
  fun `do primeiro canal para tras da a volta para o ultimo`() {
    assertEquals(12, tap(initialTuner(1), -1).tuneTo)
  }

  @Test
  fun `canal atual desconhecido cai no primeiro canal`() {
    assertEquals(1, tap(initialTuner(99), 1).tuneTo)
  }

  @Test
  fun `lista vazia nao sintoniza nada`() {
    assertNull(tap(initialTuner(1), 1, emptyList()).tuneTo)
  }

  @Test
  fun `seta descarta digitacao em andamento`() {
    val a = digit(initialTuner(1), '1')
    val r = tap(a.state, 1)
    assertEquals("", r.state.buffer)
    assertNull(r.digits)
  }

  // aceleracao

  @Test
  fun `primeiro toque anda um canal e os toques presos aceleram`() {
    assertEquals(1, stepSize(0))
    assertEquals(1, stepSize(5))
    assertEquals(5, stepSize(6))
    assertEquals(5, stepSize(15))
    assertEquals(20, stepSize(16))
  }

  @Test
  fun `tecla presa move o alvo sem sintonizar`() {
    val wide = (1..100).toList()
    val r = reduceTuner(initialTuner(1), TunerEvent.Step(1, repeatCount = 8, atMs = 0), wide)
    assertNull(r.tuneTo)
    assertEquals(6, r.preview)
    assertEquals(6, r.state.pending)
  }

  @Test
  fun `passos presos se acumulam a partir do alvo anterior`() {
    val wide = (1..100).toList()
    val a = reduceTuner(initialTuner(1), TunerEvent.Step(1, repeatCount = 8, atMs = 0), wide)
    val b = reduceTuner(a.state, TunerEvent.Step(1, repeatCount = 9, atMs = 50), wide)
    assertEquals(11, b.preview)
    assertNull(b.tuneTo)
  }

  @Test
  fun `soltar a tecla sintoniza o alvo depois da espera`() {
    val wide = (1..100).toList()
    val a = reduceTuner(initialTuner(1), TunerEvent.Step(1, repeatCount = 8, atMs = 0), wide)
    val cedo = reduceTuner(a.state, TunerEvent.Tick(STEP_COMMIT_DELAY_MS - 1), wide)
    assertNull(cedo.tuneTo)
    val tarde = reduceTuner(a.state, TunerEvent.Tick(STEP_COMMIT_DELAY_MS), wide)
    assertEquals(6, tarde.tuneTo)
    assertEquals(6, tarde.state.current)
    assertNull(tarde.state.pending)
  }

  @Test
  fun `digitar cancela o alvo das setas`() {
    val wide = (1..100).toList()
    val a = reduceTuner(initialTuner(1), TunerEvent.Step(1, repeatCount = 8, atMs = 0), wide)
    val b = reduceTuner(a.state, TunerEvent.Digit('4', 10), wide)
    assertNull(b.state.pending)
  }

  // digitacao direta

  @Test
  fun `um digito fica pendente e nao sintoniza na hora`() {
    // '1' pode virar 1 ou 12; esperar e o que um controle remoto faz.
    val r = digit(initialTuner(1), '1')
    assertNull(r.tuneTo)
    assertEquals("1", r.digits)
  }

  @Test
  fun `atingir o numero maximo de digitos sintoniza na hora`() {
    val a = digit(initialTuner(1), '1', 0)
    val b = digit(a.state, '2', 100)
    assertEquals(12, b.tuneTo)
    assertEquals("", b.state.buffer)
  }

  @Test
  fun `o tempo de espera sintoniza o que foi digitado`() {
    val a = digit(initialTuner(12), '7', 0)
    val b = reduceTuner(a.state, TunerEvent.Tick(TUNE_COMMIT_DELAY_MS), channels)
    assertEquals(7, b.tuneTo)
    assertEquals("", b.state.buffer)
  }

  @Test
  fun `tick antes do tempo nao sintoniza`() {
    val a = digit(initialTuner(12), '7', 0)
    val b = reduceTuner(a.state, TunerEvent.Tick(TUNE_COMMIT_DELAY_MS - 1), channels)
    assertNull(b.tuneTo)
    assertEquals("7", b.state.buffer)
  }

  @Test
  fun `cada digito novo reinicia a contagem`() {
    val a = digit(initialTuner(1), '0', 0)
    val b = digit(a.state, '3', TUNE_COMMIT_DELAY_MS - 10)
    val c = reduceTuner(b.state, TunerEvent.Tick(TUNE_COMMIT_DELAY_MS), channels)
    assertNull(c.tuneTo)
  }

  @Test
  fun `zeros a esquerda funcionam como em controle remoto`() {
    val a = digit(initialTuner(12), '0', 0)
    val b = digit(a.state, '7', 100)
    assertEquals(7, b.tuneTo)
  }

  @Test
  fun `canal inexistente e descartado sem sintonizar`() {
    val a = digit(initialTuner(1), '9', 0)
    val b = digit(a.state, '9', 100)
    assertNull(b.tuneTo)
    assertEquals("", b.state.buffer)
    assertTrue(b.invalid)
  }

  @Test
  fun `tick sem nada pendente e inofensivo`() {
    val r = reduceTuner(initialTuner(1), TunerEvent.Tick(999_999), channels)
    assertNull(r.tuneTo)
    assertEquals("", r.state.buffer)
  }

  @Test
  fun `nao-digito e ignorado`() {
    val r = digit(initialTuner(1), 'a')
    assertEquals("", r.state.buffer)
    assertNull(r.digits)
  }

  @Test
  fun `largura maxima acompanha o maior canal existente`() {
    // So ha canais de um digito: o primeiro digito ja sintoniza.
    val r = reduceTuner(initialTuner(1), TunerEvent.Digit('3', 0), listOf(1, 2, 3))
    assertEquals(3, r.tuneTo)
  }

  @Test
  fun `com canais de tres digitos espera tres digitos`() {
    val wide = listOf(1, 100, 250)
    val a = reduceTuner(initialTuner(1), TunerEvent.Digit('2', 0), wide)
    val b = reduceTuner(a.state, TunerEvent.Digit('5', 10), wide)
    assertNull(b.tuneTo)
    val c = reduceTuner(b.state, TunerEvent.Digit('0', 20), wide)
    assertEquals(250, c.tuneTo)
  }
}
