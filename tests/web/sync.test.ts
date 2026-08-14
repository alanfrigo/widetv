import { describe, expect, test } from 'vitest';
import {
  DRIFT_DEADBAND_MS,
  DRIFT_HYSTERESIS_MS,
  DRIFT_SEEK_MS,
  RATE_CORRECTION,
  decideCorrection,
  estimateSkewMs,
  expectedOffsetMs,
  type NowSample,
} from '../../src/web/sync';

/**
 * Um `NowSample` guarda o que o servidor respondeu e o relogio local nos dois
 * lados do request. Tudo deriva disso.
 */
function sample(over: Partial<NowSample> = {}): NowSample {
  return {
    serverTimeMs: 1_000_000,
    offsetMs: 60_000,
    durationMs: 1_320_000,
    sentAtMs: 500_000,
    receivedAtMs: 500_200,
    ...over,
  };
}

describe('estimateSkewMs', () => {
  test('assume que o servidor carimbou no meio do round-trip', () => {
    // Enviado em 500000, recebido em 500200: o carimbo do servidor vale para 500100.
    // Servidor disse 1000000, entao o relogio dele esta 499900ms adiante do local.
    expect(estimateSkewMs(sample())).toBe(499_900);
  });

  test('round-trip zero deixa o skew ser a diferenca crua', () => {
    const s = sample({ sentAtMs: 500_000, receivedAtMs: 500_000 });
    expect(estimateSkewMs(s)).toBe(500_000);
  });

  test('skew negativo quando o relogio local esta adiantado', () => {
    const s = sample({ serverTimeMs: 1_000_000, sentAtMs: 1_100_000, receivedAtMs: 1_100_000 });
    expect(estimateSkewMs(s)).toBe(-100_000);
  });
});

describe('expectedOffsetMs', () => {
  test('no instante da resposta, o esperado e o offset que veio do servidor', () => {
    const s = sample();
    expect(expectedOffsetMs(s, s.receivedAtMs)).toBe(60_100);
  });

  test('avanca 1:1 com o relogio local', () => {
    const s = sample();
    const dez = expectedOffsetMs(s, s.receivedAtMs + 10_000);
    expect(dez).toBe(70_100);
  });

  test('nao satura na duracao do episodio: passar do fim e o sinal de trocar', () => {
    const s = sample({ offsetMs: 1_319_000, durationMs: 1_320_000 });
    expect(expectedOffsetMs(s, s.receivedAtMs + 5_000)).toBeGreaterThan(s.durationMs);
  });
});

describe('decideCorrection', () => {
  test('drift dentro da banda morta nao faz nada', () => {
    const d = decideCorrection(DRIFT_DEADBAND_MS - 1, 1);
    expect(d.action).toBe('none');
    expect(d.playbackRate).toBe(1);
  });

  test('atrasado alem da banda morta acelera o playback', () => {
    // drift negativo = video atras do esperado = precisa correr
    const d = decideCorrection(-800, 1);
    expect(d.action).toBe('rate');
    expect(d.playbackRate).toBeCloseTo(1 + RATE_CORRECTION);
  });

  test('adiantado alem da banda morta desacelera o playback', () => {
    const d = decideCorrection(800, 1);
    expect(d.action).toBe('rate');
    expect(d.playbackRate).toBeCloseTo(1 - RATE_CORRECTION);
  });

  test('drift grande demais para corrigir por velocidade vira seek', () => {
    const d = decideCorrection(DRIFT_SEEK_MS + 1, 1);
    expect(d.action).toBe('seek');
    expect(d.playbackRate).toBe(1);
  });

  test('seek tambem para drift grande negativo', () => {
    const d = decideCorrection(-(DRIFT_SEEK_MS + 1), 1);
    expect(d.action).toBe('seek');
  });

  test('mantem a correcao ate zerar de verdade, para nao oscilar na borda', () => {
    // Ja corrigindo e ainda fora da histerese: continua corrigindo, mesmo dentro
    // da banda morta de entrada.
    const d = decideCorrection(-(DRIFT_DEADBAND_MS - 50), 1 + RATE_CORRECTION);
    expect(d.action).toBe('rate');
    expect(d.playbackRate).toBeCloseTo(1 + RATE_CORRECTION);
  });

  test('solta a correcao quando entra na histerese', () => {
    const d = decideCorrection(DRIFT_HYSTERESIS_MS - 1, 1 + RATE_CORRECTION);
    expect(d.action).toBe('none');
    expect(d.playbackRate).toBe(1);
  });

  test('inverte o sentido da correcao sem passar por 1', () => {
    const d = decideCorrection(-800, 1 - RATE_CORRECTION);
    expect(d.playbackRate).toBeCloseTo(1 + RATE_CORRECTION);
  });

  test('reporta o drift recebido para telemetria', () => {
    expect(decideCorrection(-1234, 1).driftMs).toBe(-1234);
  });
});
