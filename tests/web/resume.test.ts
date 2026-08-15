import { describe, expect, test } from 'vitest';

import { progressRatio, remainingMs, resumeStartMs, watchState } from '../../src/web/resume';

const MIN = 60_000;

describe('resumeStartMs', () => {
  test('sem entrada nao ha o que retomar', () => {
    expect(resumeStartMs(null)).toBe(0);
    expect(resumeStartMs(undefined)).toBe(0);
  });

  test('parou no meio: retoma exatamente de la', () => {
    expect(resumeStartMs({ positionMs: 10 * MIN, durationMs: 22 * MIN })).toBe(10 * MIN);
  });

  test('parou na vinheta de abertura: comeca do zero', () => {
    expect(resumeStartMs({ positionMs: 20_000, durationMs: 22 * MIN })).toBe(0);
  });

  test('parou nos creditos finais: episodio assistido, comeca do zero', () => {
    expect(resumeStartMs({ positionMs: 21.5 * MIN, durationMs: 22 * MIN })).toBe(0);
  });

  test('entrada corrompida (NaN) nao vira seek', () => {
    expect(resumeStartMs({ positionMs: Number.NaN, durationMs: 22 * MIN })).toBe(0);
  });
});

describe('progressRatio', () => {
  test('metade assistida pinta metade da barra', () => {
    expect(progressRatio({ positionMs: 11 * MIN, durationMs: 22 * MIN })).toBeCloseTo(0.5);
  });

  test('nunca passa de 1 nem fica negativo', () => {
    expect(progressRatio({ positionMs: 30 * MIN, durationMs: 22 * MIN })).toBe(1);
    expect(progressRatio({ positionMs: -5, durationMs: 22 * MIN })).toBe(0);
  });

  test('sem entrada ou duracao zero: barra vazia', () => {
    expect(progressRatio(null)).toBe(0);
    expect(progressRatio({ positionMs: 5, durationMs: 0 })).toBe(0);
  });
});

describe('de onde a faixa "Continuar assistindo" retoma', () => {
  /**
   * A entrada da faixa vem `no-store` do servidor; o mapa local de
   * `GET /api/history` so e rebuscado ao entrar numa serie. Quando outro
   * aparelho da casa avanca o episodio, os dois discordam - e quem tem razao e
   * a entrada, porque foi ela que desenhou o card.
   */
  const doServidor = { positionMs: 40 * MIN, durationMs: 44 * MIN };
  const doMapaLocal = { positionMs: 5 * MIN, durationMs: 44 * MIN };

  test('a posicao da entrada e a que o card acabou de mostrar', () => {
    expect(resumeStartMs(doServidor)).toBe(40 * MIN);
    expect(resumeStartMs(doServidor)).not.toBe(resumeStartMs(doMapaLocal));
  });

  test('mapa local vazio (GET /api/history falhou) nao zera a retomada', () => {
    // Sem a entrada, `resumeStartMs(undefined)` e 0: todo card da faixa tocaria
    // do inicio com a barra pintada na tela.
    expect(resumeStartMs(undefined)).toBe(0);
    expect(resumeStartMs(doServidor)).toBeGreaterThan(0);
  });

  test('a entrada continua passando pelas regras de retomada', () => {
    // Nao e "abra onde o servidor disse" e sim "decida com o que ele disse":
    // vinheta de abertura e creditos finais continuam comecando do zero.
    expect(resumeStartMs({ positionMs: 20_000, durationMs: 44 * MIN })).toBe(0);
    expect(resumeStartMs({ positionMs: 43 * MIN, durationMs: 44 * MIN })).toBe(0);
  });
});

describe('remainingMs', () => {
  test('o que falta e o resto da duracao', () => {
    expect(remainingMs({ positionMs: 10 * MIN, durationMs: 22 * MIN })).toBe(12 * MIN);
  });

  test('posicao alem do fim nao vira tempo negativo na tela', () => {
    expect(remainingMs({ positionMs: 30 * MIN, durationMs: 22 * MIN })).toBe(0);
    expect(remainingMs(null)).toBe(0);
  });
});

describe('watchState', () => {
  test('sem entrada a linha nao afirma nada', () => {
    // O servidor apaga a entrada no fim: silencio aqui e ambiguo, e dizer
    // "assistido" riscaria a maratona inteira de quem acabou de instalar.
    expect(watchState(null)).toBe('unseen');
    expect(watchState({ positionMs: 0, durationMs: 22 * MIN })).toBe('unseen');
  });

  test('parou no meio: episodio comecado', () => {
    expect(watchState({ positionMs: 10 * MIN, durationMs: 22 * MIN })).toBe('watching');
    // Mesmo antes do minimo de retomada a barra ja mostra que foi aberto.
    expect(watchState({ positionMs: 5_000, durationMs: 22 * MIN })).toBe('watching');
  });

  test('entrada velha que chegou aos creditos conta como assistido', () => {
    expect(watchState({ positionMs: 21.5 * MIN, durationMs: 22 * MIN })).toBe('watched');
  });

  test('duracao desconhecida nao inventa estado', () => {
    expect(watchState({ positionMs: 5 * MIN, durationMs: 0 })).toBe('unseen');
  });
});
