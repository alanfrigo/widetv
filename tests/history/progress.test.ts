import { describe, expect, test } from 'vitest';

import { decideProgress, FINISHED_RATIO, validMs } from '../../src/server/history/progress';

/**
 * A regra mais facil de errar do app: o mesmo corpo pode significar "guarde onde
 * eu parei", "eu vi este" ou "esqueca que eu vi". Cada caso tem uma linha aqui.
 */

const EP = 'serie/ep01.mkv';
const DURACAO = 1_320_000;
const AGORA = 1234;

function decide(body: unknown) {
  return decideProgress({
    episodeId: EP,
    body: body as never,
    episodeDurationMs: DURACAO,
    nowMs: AGORA,
  });
}

describe('progresso do player', () => {
  test('posicao no meio grava a posicao e nao marca nada', () => {
    expect(decide({ positionMs: 600_000, durationMs: DURACAO })).toEqual({
      kind: 'save',
      row: {
        episodeId: EP,
        positionMs: 600_000,
        durationMs: DURACAO,
        updatedAt: AGORA,
        watchedAt: null,
      },
    });
  });

  test('a posicao e arredondada: o player manda fracao de milissegundo', () => {
    const decision = decide({ positionMs: 600_000.6, durationMs: DURACAO + 0.4 });
    expect(decision).toMatchObject({ row: { positionMs: 600_001, durationMs: DURACAO } });
  });

  test('cruzar os creditos marca como visto e zera a posicao', () => {
    // Zerar e o que faz a proxima abertura comecar do comeco em vez de cair
    // dentro dos creditos.
    const decision = decide({ positionMs: DURACAO * FINISHED_RATIO, durationMs: DURACAO });
    expect(decision).toEqual({
      kind: 'save',
      row: {
        episodeId: EP,
        positionMs: 0,
        durationMs: DURACAO,
        updatedAt: AGORA,
        watchedAt: AGORA,
      },
    });
  });

  test('exatamente na fracao ja conta como visto', () => {
    const decision = decide({ positionMs: DURACAO * FINISHED_RATIO, durationMs: DURACAO });
    expect(decision).toMatchObject({ row: { watchedAt: AGORA } });

    const antes = decide({ positionMs: DURACAO * FINISHED_RATIO - 1, durationMs: DURACAO });
    expect(antes).toMatchObject({ row: { watchedAt: null } });
  });

  test('rever DESMARCA: quem voltou ao meio esta assistindo de novo', () => {
    expect(decide({ positionMs: 1000, durationMs: DURACAO })).toMatchObject({
      row: { watchedAt: null },
    });
  });
});

describe('marcacao manual', () => {
  test('marcar grava posicao zero com a duracao do indice', () => {
    // O botao pode estar na lista de episodios, longe de qualquer player: a
    // duracao nao vem do corpo porque quem aperta nao a conhece.
    expect(decide({ watched: true })).toEqual({
      kind: 'save',
      row: {
        episodeId: EP,
        positionMs: 0,
        durationMs: DURACAO,
        updatedAt: AGORA,
        watchedAt: AGORA,
      },
    });
  });

  test('desmarcar apaga a linha inteira', () => {
    expect(decide({ watched: false })).toEqual({ kind: 'forget' });
  });

  test('watched vence: a marcacao manual nao carrega posicao para conferir', () => {
    expect(decide({ watched: true, positionMs: 999, durationMs: DURACAO })).toMatchObject({
      row: { positionMs: 0 },
    });
  });
});

describe('corpo torto', () => {
  test.each([
    ['sem corpo', null],
    ['vazio', {}],
    ['so duracao', { durationMs: 10 }],
    ['so posicao', { positionMs: 10 }],
    ['posicao negativa', { positionMs: -1, durationMs: 10 }],
    ['duracao zero', { positionMs: 1, durationMs: 0 }],
    ['posicao NaN', { positionMs: Number.NaN, durationMs: 10 }],
    ['posicao infinita', { positionMs: Number.POSITIVE_INFINITY, durationMs: 10 }],
    ['posicao texto', { positionMs: 'dez', durationMs: 10 }],
    ['watched texto', { watched: 'sim' }],
  ])('%s vira invalid', (_nome, body) => {
    expect(decide(body).kind).toBe('invalid');
  });
});

describe('validMs', () => {
  test('aceita zero e recusa o que nao e numero finito nao-negativo', () => {
    expect(validMs(0)).toBe(true);
    expect(validMs(1.5)).toBe(true);
    expect(validMs(-1)).toBe(false);
    expect(validMs(Number.NaN)).toBe(false);
    expect(validMs(Number.POSITIVE_INFINITY)).toBe(false);
    expect(validMs('1')).toBe(false);
    expect(validMs(null)).toBe(false);
    expect(validMs(undefined)).toBe(false);
  });
});
