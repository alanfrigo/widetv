import { describe, expect, test } from 'vitest';
import { shouldPoll, type PollGate } from '../../src/web/polling';

const MINUTE = 60_000;

function gate(over: Partial<PollGate> = {}): PollGate {
  return { lastAtMs: 1_000_000, inFlight: false, intervalMs: MINUTE, ...over };
}

describe('shouldPoll', () => {
  test('espera o intervalo inteiro antes de reperguntar', () => {
    expect(shouldPoll(gate(), 1_000_000 + MINUTE - 1)).toBe(false);
    expect(shouldPoll(gate(), 1_000_000 + MINUTE)).toBe(true);
  });

  test('request em voo bloqueia, por mais velho que esteja o carimbo', () => {
    // Servidor lento: sem esta trava o relogio de um segundo empilharia
    // pedidos em cima do anterior.
    expect(shouldPoll(gate({ inFlight: true }), 1_000_000 + 10 * MINUTE)).toBe(false);
  });

  test('o carimbo de uma tentativa que FALHOU segura o relogio igual', () => {
    // E o defeito do 401: quem sai do `catch` sem carimbar deixa a diferenca
    // permanentemente acima do intervalo, e o relogio vira um request por
    // segundo, para sempre.
    const failedNow = gate({ lastAtMs: 2_000_000 });
    expect(shouldPoll(failedNow, 2_000_000 + 1_000)).toBe(false);
    expect(shouldPoll(failedNow, 2_000_000 + 30 * 1_000)).toBe(false);
    expect(shouldPoll(failedNow, 2_000_000 + MINUTE)).toBe(true);
  });

  test('carimbo zerado (nenhum request ainda) libera o primeiro', () => {
    // `lastAtMs` nasce 0 e o relogio real e da ordem de 1.7e12: o primeiro tick
    // ja passa. Quem impede o pedido em duplicata com o da abertura da tela e o
    // `inFlight`, nao o intervalo.
    expect(shouldPoll(gate({ lastAtMs: 0 }), Date.now())).toBe(true);
    expect(shouldPoll(gate({ lastAtMs: 0, inFlight: true }), Date.now())).toBe(false);
  });
});
