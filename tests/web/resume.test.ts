import { describe, expect, test } from 'vitest';

import { progressRatio, resumeStartMs } from '../../src/web/resume';

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
