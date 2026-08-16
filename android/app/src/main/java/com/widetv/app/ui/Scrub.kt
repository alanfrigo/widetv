package com.widetv.app.ui

/**
 * Scrub do sob demanda: traduz as setas laterais em UM seek. Mesmo desenho do
 * `tuner/Tuner.kt`, pelo mesmo motivo — o controle da TV repete a tecla
 * enquanto ela fica presa, e um seek real por repeticao viraria uma rajada de
 * saltos que o player nunca alcanca. O passo repetido so move um alvo na barra;
 * o seek de verdade sai quando a mao solta.
 *
 * Reducer puro, sem View e sem timers: quem chama decide quando emitir `Tick`,
 * e a espera vira teste em vez de `postDelayed`.
 */

/** Tempo parado antes de aceitar o alvo escolhido segurando a seta. */
const val SCRUB_COMMIT_DELAY_MS = 250L

data class ScrubState(
  /** Posicao real da ultima vez que alguem olhou o player. */
  val basePositionMs: Long,
  /** Alvo escolhido pelas setas e ainda nao aplicado. null em repouso. */
  val targetMs: Long? = null,
  /** Relogio do ultimo passo, para saber quando a espera venceu. */
  val lastStepAtMs: Long? = null,
)

sealed interface ScrubEvent {
  /**
   * @param repeatCount 0 no primeiro toque; cresce enquanto a tecla fica presa.
   */
  data class Step(val delta: Int, val repeatCount: Int, val atMs: Long) : ScrubEvent

  data class Tick(val atMs: Long) : ScrubEvent
}

data class ScrubResult(
  val state: ScrubState,
  /** Posicao a aplicar no player agora, ou null se nada a fazer. */
  val seekTo: Long? = null,
  /** Posicao so prevista (tecla em movimento), para a barra mostrar antes do seek. */
  val preview: Long? = null,
)

fun initialScrub(positionMs: Long) = ScrubState(basePositionMs = positionMs)

/**
 * Aceleracao do passo, na mesma escada do `stepSize` do sintonizador. O toque
 * solto vale os 10s de sempre (o `SEEK_MS` do player); a tecla presa precisa
 * atravessar um episodio inteiro sem virar exercicio de paciencia.
 */
fun scrubStepMs(repeatCount: Int): Long = when {
  repeatCount < 6 -> 10_000L
  repeatCount < 16 -> 30_000L
  else -> 60_000L
}

fun reduceScrub(state: ScrubState, event: ScrubEvent, durationMs: Long): ScrubResult =
  when (event) {
    is ScrubEvent.Step -> step(state, event, durationMs)
    is ScrubEvent.Tick -> tick(state, event)
  }

/** 0..durationMs. Duracao desconhecida (<= 0) so trava no zero: nao ha fim a respeitar. */
private fun clamp(positionMs: Long, durationMs: Long): Long {
  val floor = positionMs.coerceAtLeast(0L)
  return if (durationMs > 0) floor.coerceAtMost(durationMs) else floor
}

private fun step(state: ScrubState, event: ScrubEvent.Step, durationMs: Long): ScrubResult {
  val from = state.targetMs ?: state.basePositionMs
  val target = clamp(from + event.delta * scrubStepMs(event.repeatCount), durationMs)

  // Toque solto salta na hora: esperar 250ms num unico passo seria lentidao
  // sem motivo. A espera existe so para a tecla presa.
  if (event.repeatCount == 0) {
    return ScrubResult(ScrubState(basePositionMs = target), seekTo = target, preview = target)
  }

  return ScrubResult(
    ScrubState(
      basePositionMs = state.basePositionMs,
      targetMs = target,
      lastStepAtMs = event.atMs,
    ),
    preview = target,
  )
}

private fun tick(state: ScrubState, event: ScrubEvent.Tick): ScrubResult {
  val target = state.targetMs ?: return ScrubResult(state)
  val lastStepAtMs = state.lastStepAtMs ?: return ScrubResult(state)
  if (event.atMs - lastStepAtMs < SCRUB_COMMIT_DELAY_MS) {
    return ScrubResult(state, preview = target)
  }
  // Um seek so, e o estado volta ao repouso: o proximo tick nao repete nada.
  return ScrubResult(ScrubState(basePositionMs = target), seekTo = target)
}
