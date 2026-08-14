/**
 * Sintonizador: traduz teclas em "va para o canal N".
 *
 * Reducer puro, sem DOM e sem timers. Quem chama e que decide quando emitir o
 * evento `tick` - assim o comportamento de espera vira teste, em vez de virar
 * um `setTimeout` que ninguem consegue verificar.
 */

/** Tempo parado antes de aceitar o que foi digitado, como num controle remoto. */
export const TUNE_COMMIT_DELAY_MS = 1_200;

export interface TunerState {
  /** Canal sintonizado agora. */
  current: number;
  /** Digitos ja teclados e ainda nao confirmados. */
  buffer: string;
  /** Relogio do ultimo digito, para saber quando a espera venceu. */
  lastDigitAtMs: number | null;
}

export type TunerEvent =
  | { type: 'digit'; value: string; atMs: number }
  | { type: 'step'; delta: number }
  | { type: 'tick'; atMs: number };

export interface TunerResult {
  state: TunerState;
  /** Canal a sintonizar agora, ou null se nada mudou. */
  tuneTo: number | null;
  /** O que mostrar no OSD enquanto o usuario digita, ou null. */
  display: string | null;
  /** true quando o usuario digitou um canal que nao existe. */
  invalid: boolean;
}

export function initialTuner(current: number): TunerState {
  return { current, buffer: '', lastDigitAtMs: null };
}

function idle(state: TunerState): TunerState {
  return { current: state.current, buffer: '', lastDigitAtMs: null };
}

/** Quantos digitos vale a pena esperar, dado o maior canal que existe. */
function maxDigits(channels: readonly number[]): number {
  let widest = 1;
  for (const channel of channels) {
    widest = Math.max(widest, String(channel).length);
  }
  return widest;
}

function commit(state: TunerState, channels: readonly number[]): TunerResult {
  const wanted = Number(state.buffer);
  const exists = channels.includes(wanted);
  return {
    state: idle(state),
    tuneTo: exists ? wanted : null,
    display: null,
    invalid: !exists,
  };
}

function step(state: TunerState, delta: number, channels: readonly number[]): TunerResult {
  if (channels.length === 0) {
    return { state: idle(state), tuneTo: null, display: null, invalid: false };
  }

  const at = channels.indexOf(state.current);
  // Canal atual fora da lista (serie removida durante um rescan): recomeca do inicio.
  const next =
    at === -1
      ? channels[0]!
      : channels[(((at + delta) % channels.length) + channels.length) % channels.length]!;

  return {
    state: { current: next, buffer: '', lastDigitAtMs: null },
    tuneTo: next,
    display: null,
    invalid: false,
  };
}

export function reduceTuner(
  state: TunerState,
  event: TunerEvent,
  channels: readonly number[],
): TunerResult {
  switch (event.type) {
    case 'step':
      return step(state, event.delta, channels);

    case 'digit': {
      if (!/^\d$/.test(event.value)) {
        return { state, tuneTo: null, display: state.buffer || null, invalid: false };
      }

      const buffer = state.buffer + event.value;
      const pending: TunerState = { ...state, buffer, lastDigitAtMs: event.atMs };

      // Numero ja tem a largura maxima possivel: nao ha o que esperar.
      if (buffer.length >= maxDigits(channels)) {
        return commit(pending, channels);
      }
      return { state: pending, tuneTo: null, display: buffer, invalid: false };
    }

    case 'tick': {
      if (state.buffer === '' || state.lastDigitAtMs === null) {
        return { state, tuneTo: null, display: null, invalid: false };
      }
      if (event.atMs - state.lastDigitAtMs < TUNE_COMMIT_DELAY_MS) {
        return { state, tuneTo: null, display: state.buffer, invalid: false };
      }
      return commit(state, channels);
    }
  }
}
