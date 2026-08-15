package com.widetv.app.tuner

/**
 * Sintonizador: traduz teclas em "va para o canal N". Porte de `src/web/tuner.ts`.
 *
 * Reducer puro, sem View e sem timers. Quem chama e que decide quando emitir o
 * evento `Tick` — assim o comportamento de espera vira teste, em vez de virar um
 * `postDelayed` que ninguem consegue verificar.
 *
 * Diferenca para o web: o controle da TV repete a tecla enquanto ela fica
 * pressionada. Segurar a seta atravessa 460 canais, e sintonizar cada um deles
 * seria uma tempestade de requests. Por isso o passo repetido so move um alvo
 * na tela; a sintonia de verdade sai quando a mao solta.
 */

/** Tempo parado antes de aceitar o que foi digitado, como num controle remoto. */
const val TUNE_COMMIT_DELAY_MS = 1_200L

/** Tempo parado antes de aceitar o alvo escolhido segurando a seta. */
const val STEP_COMMIT_DELAY_MS = 250L

data class TunerState(
  /** Canal sintonizado agora. */
  val current: Int,
  /** Digitos ja teclados e ainda nao confirmados. */
  val buffer: String = "",
  /** Relogio do ultimo digito, para saber quando a espera venceu. */
  val lastDigitAtMs: Long? = null,
  /** Canal escolhido pelas setas e ainda nao sintonizado. */
  val pending: Int? = null,
  /** Relogio do ultimo passo. */
  val lastStepAtMs: Long? = null,
)

sealed interface TunerEvent {
  data class Digit(val value: Char, val atMs: Long) : TunerEvent

  /**
   * @param repeatCount 0 no primeiro toque; cresce enquanto a tecla fica presa.
   */
  data class Step(val delta: Int, val repeatCount: Int, val atMs: Long) : TunerEvent

  data class Tick(val atMs: Long) : TunerEvent
}

data class TunerResult(
  val state: TunerState,
  /** Canal a sintonizar agora, ou null se nada mudou. */
  val tuneTo: Int? = null,
  /** Digitos a mostrar enquanto o usuario tecla, ou null. */
  val digits: String? = null,
  /** Canal so previsto (setas em movimento), para o OSD mostrar antes de sintonizar. */
  val preview: Int? = null,
  /** true quando o usuario digitou um canal que nao existe. */
  val invalid: Boolean = false,
)

fun initialTuner(current: Int) = TunerState(current = current)

/**
 * Aceleracao do passo. Segurar a seta tem que atravessar centenas de canais sem
 * virar exercicio de paciencia, mas o primeiro toque precisa continuar valendo
 * um canal exato.
 */
fun stepSize(repeatCount: Int): Int = when {
  repeatCount < 6 -> 1
  repeatCount < 16 -> 5
  else -> 20
}

/** Volta ao repouso: sem digitos pendentes e sem alvo de seta. */
private fun idle(state: TunerState) = TunerState(current = state.current)

/** Quantos digitos vale a pena esperar, dado o maior canal que existe. */
private fun maxDigits(channels: List<Int>): Int {
  var widest = 1
  for (channel in channels) widest = maxOf(widest, channel.toString().length)
  return widest
}

private fun walk(from: Int, delta: Int, channels: List<Int>): Int {
  val at = channels.indexOf(from)
  // Canal atual fora da lista (serie removida durante um rescan): recomeca do inicio.
  if (at == -1) return channels[0]
  val size = channels.size
  return channels[((at + delta) % size + size) % size]
}

private fun commitDigits(state: TunerState, channels: List<Int>): TunerResult {
  val wanted = state.buffer.toIntOrNull()
  val exists = wanted != null && channels.contains(wanted)
  return TunerResult(
    state = if (exists) idle(state).copy(current = wanted!!) else idle(state),
    tuneTo = if (exists) wanted else null,
    invalid = !exists,
  )
}

fun reduceTuner(state: TunerState, event: TunerEvent, channels: List<Int>): TunerResult =
  when (event) {
    is TunerEvent.Step -> step(state, event, channels)
    is TunerEvent.Digit -> digit(state, event, channels)
    is TunerEvent.Tick -> tick(state, event, channels)
  }

private fun step(state: TunerState, event: TunerEvent.Step, channels: List<Int>): TunerResult {
  if (channels.isEmpty()) return TunerResult(idle(state))

  val from = state.pending ?: state.current
  val target = walk(from, event.delta * stepSize(event.repeatCount), channels)

  // Toque solto sintoniza na hora: esperar 250ms num unico passo seria lentidao
  // sem motivo. A espera existe so para a tecla presa.
  if (event.repeatCount == 0) {
    return TunerResult(TunerState(current = target), tuneTo = target, preview = target)
  }

  return TunerResult(
    state = TunerState(current = state.current, pending = target, lastStepAtMs = event.atMs),
    preview = target,
  )
}

private fun digit(state: TunerState, event: TunerEvent.Digit, channels: List<Int>): TunerResult {
  if (!event.value.isDigit()) {
    return TunerResult(state, digits = state.buffer.ifEmpty { null })
  }

  val buffer = state.buffer + event.value
  // Digitar cancela o alvo das setas: o usuario mudou de ideia sobre como chegar la.
  val pendingState = state.copy(
    buffer = buffer,
    lastDigitAtMs = event.atMs,
    pending = null,
    lastStepAtMs = null,
  )

  // Numero ja tem a largura maxima possivel: nao ha o que esperar.
  if (buffer.length >= maxDigits(channels)) return commitDigits(pendingState, channels)
  return TunerResult(pendingState, digits = buffer)
}

private fun tick(state: TunerState, event: TunerEvent.Tick, channels: List<Int>): TunerResult {
  val lastDigitAtMs = state.lastDigitAtMs
  if (state.buffer.isNotEmpty() && lastDigitAtMs != null) {
    if (event.atMs - lastDigitAtMs < TUNE_COMMIT_DELAY_MS) {
      return TunerResult(state, digits = state.buffer)
    }
    return commitDigits(state, channels)
  }

  val pending = state.pending
  val lastStepAtMs = state.lastStepAtMs
  if (pending != null && lastStepAtMs != null) {
    if (event.atMs - lastStepAtMs < STEP_COMMIT_DELAY_MS) {
      return TunerResult(state, preview = pending)
    }
    return TunerResult(TunerState(current = pending), tuneTo = pending)
  }

  return TunerResult(state)
}
