package com.widetv.app.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Politica de gravacao do "onde parei": quando manda, quando cala. */
class ProgressTest {

  private val vod = ProgressSnapshot(live = false, positionMs = 600_000, durationMs = 1_320_000)

  @Test
  fun `a primeira gravacao sai na hora, sem esperar o intervalo`() {
    val decision = decideProgress(ProgressState(), vod, nowMs = 1_000)
    assertTrue(decision.send)
    assertEquals(1_000, decision.state.lastSentAtMs)
    assertEquals(600_000, decision.state.lastPositionMs)
  }

  @Test
  fun `dentro do intervalo o tique nao manda nem move o relogio`() {
    val enviado = ProgressState(lastSentAtMs = 1_000, lastPositionMs = 600_000)
    val cedo = decideProgress(enviado, vod.copy(positionMs = 601_000), nowMs = 5_000)
    assertFalse(cedo.send)
    // Recusar nao pode adiar o proximo: o relogio fica onde estava.
    assertEquals(enviado, cedo.state)
  }

  @Test
  fun `passado o intervalo o tique manda`() {
    val enviado = ProgressState(lastSentAtMs = 1_000, lastPositionMs = 600_000)
    val depois = decideProgress(
      enviado,
      vod.copy(positionMs = 610_000),
      nowMs = 1_000 + PROGRESS_INTERVAL_MS,
    )
    assertTrue(depois.send)
  }

  @Test
  fun `o momento forcado ignora o intervalo`() {
    // Pausa, troca de episodio, saida do player: esperar o proximo tique pode
    // significar nunca.
    val enviado = ProgressState(lastSentAtMs = 1_000, lastPositionMs = 600_000)
    val decision =
      decideProgress(enviado, vod.copy(positionMs = 601_000), nowMs = 1_500, forced = true)
    assertTrue(decision.send)
    assertEquals(601_000, decision.state.lastPositionMs)
  }

  @Test
  fun `ao vivo nunca grava, nem forcado`() {
    // A posicao pertence a grade; gravar "onde parei" num canal linear nao
    // significa nada.
    val live = vod.copy(live = true)
    assertFalse(decideProgress(ProgressState(), live, nowMs = 1_000).send)
    assertFalse(decideProgress(ProgressState(), live, nowMs = 1_000, forced = true).send)
  }

  @Test
  fun `duracao desconhecida nao grava`() {
    // Sem duracao o servidor nao tem como decidir se o episodio terminou, e
    // devolveria 400.
    val semDuracao = vod.copy(durationMs = 0)
    assertFalse(decideProgress(ProgressState(), semDuracao, nowMs = 1_000, forced = true).send)
  }

  @Test
  fun `os primeiros segundos nao viram linha de historico`() {
    val vinheta = vod.copy(positionMs = PROGRESS_MIN_POSITION_MS - 1)
    assertFalse(decideProgress(ProgressState(), vinheta, nowMs = 1_000, forced = true).send)

    val depois = vod.copy(positionMs = PROGRESS_MIN_POSITION_MS)
    assertTrue(decideProgress(ProgressState(), depois, nowMs = 1_000).send)
  }

  @Test
  fun `posicao parada nao regrava`() {
    // Video pausado: o tique continua batendo e a posicao nao anda.
    val enviado = ProgressState(lastSentAtMs = 1_000, lastPositionMs = 600_000)
    val parado = decideProgress(enviado, vod, nowMs = 1_000_000, forced = true)
    assertFalse(parado.send)
  }

  @Test
  fun `marcacao manual cala a gravacao automatica ate o episodio virar`() {
    // Sem isto o botao "Já vi" durava dez segundos: o tique seguinte mandava uma
    // posicao no meio do episodio e o servidor, corretamente, desmarcava.
    val marcado = ProgressState(manual = true)
    assertFalse(decideProgress(marcado, vod, nowMs = 1_000).send)
    assertFalse(decideProgress(marcado, vod, nowMs = 1_000, forced = true).send)

    // Episodio novo zera o estado e a gravacao volta.
    assertTrue(decideProgress(ProgressState(), vod, nowMs = 1_000).send)
  }

  @Test
  fun `episodio novo comeca com estado zerado e grava de novo na mesma posicao`() {
    // O `lastPositionMs` e por episodio: dois episodios podem parar no mesmo
    // minuto, e o segundo tem que ser gravado.
    val enviado = ProgressState(lastSentAtMs = 1_000, lastPositionMs = 600_000)
    assertFalse(decideProgress(enviado, vod, nowMs = 900_000).send)
    assertTrue(decideProgress(ProgressState(), vod, nowMs = 900_000).send)
  }
}
