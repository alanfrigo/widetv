import { describe, expect, test } from 'vitest';

import { planEvictions, type CacheEntry } from '../../src/server/library/cache-budget';

const GB = 1024 * 1024 * 1024;

function entry(key: string, bytes: number, lastAccessAt: number): CacheEntry {
  return { key, file: `${key}.mp4`, bytes, lastAccessAt };
}

function keys(entries: readonly CacheEntry[]): string[] {
  return entries.map((item) => item.key);
}

describe('quando nao ha nada a fazer', () => {
  test('cache vazio nao evicta nada', () => {
    expect(planEvictions([], 10 * GB, new Set())).toEqual([]);
  });

  test('soma abaixo do teto nao evicta nada', () => {
    const entries = [entry('a', 3 * GB, 100), entry('b', 4 * GB, 200)];
    expect(planEvictions(entries, 10 * GB, new Set())).toEqual([]);
  });

  test('soma EXATAMENTE no teto nao evicta nada', () => {
    const entries = [entry('a', 5 * GB, 100), entry('b', 5 * GB, 200)];
    expect(planEvictions(entries, 10 * GB, new Set())).toEqual([]);
  });
});

describe('ordem de evicção', () => {
  test('sai o menos recentemente USADO, nao o mais antigo em disco', () => {
    // 'velho' foi criado primeiro mas foi acessado agora; 'novo' esta parado.
    // Ordenar por criacao evictaria o episodio que esta tocando.
    const entries = [entry('velho', 6 * GB, 9_000), entry('novo', 6 * GB, 1_000)];
    expect(keys(planEvictions(entries, 10 * GB, new Set()))).toEqual(['novo']);
  });

  test('evicta em cadeia ate caber, do mais frio para o mais quente', () => {
    const entries = [
      entry('a', 4 * GB, 100),
      entry('b', 4 * GB, 200),
      entry('c', 4 * GB, 300),
      entry('d', 4 * GB, 400),
    ];
    // 16 GB para um teto de 6 GB: precisa derrubar 10 GB, ou seja 3 arquivos.
    expect(keys(planEvictions(entries, 6 * GB, new Set()))).toEqual(['a', 'b', 'c']);
  });

  test('para assim que cabe, sem esvaziar o cache inteiro', () => {
    const entries = [entry('a', 1 * GB, 100), entry('b', 1 * GB, 200), entry('c', 1 * GB, 300)];
    expect(keys(planEvictions(entries, 2 * GB, new Set()))).toEqual(['a']);
  });

  test('empate de lastAccessAt e resolvido pela chave, para o plano ser deterministico', () => {
    const entries = [entry('b', 4 * GB, 100), entry('a', 4 * GB, 100)];
    expect(keys(planEvictions(entries, 4 * GB, new Set()))).toEqual(['a']);
  });
});

describe('pinning', () => {
  test('item pinado nunca sai, mesmo sendo o mais frio', () => {
    const entries = [entry('tocando', 6 * GB, 1), entry('parado', 6 * GB, 999)];
    expect(keys(planEvictions(entries, 6 * GB, new Set(['tocando'])))).toEqual(['parado']);
  });

  test('pinados contam para o total: o resto do cache paga a conta', () => {
    const entries = [
      entry('pin', 8 * GB, 1),
      entry('a', 2 * GB, 100),
      entry('b', 2 * GB, 200),
    ];
    // 12 GB no total, teto 10 GB. O pinado sozinho ja ocupa 8, entao os 2 GB
    // excedentes saem do primeiro nao-pinado mais frio.
    expect(keys(planEvictions(entries, 10 * GB, new Set(['pin'])))).toEqual(['a']);
  });

  test('pinados sozinhos acima do teto: evicta todo o resto e para, sem laco infinito', () => {
    const entries = [
      entry('pin1', 8 * GB, 1),
      entry('pin2', 8 * GB, 2),
      entry('a', 1 * GB, 100),
    ];
    const pinned = new Set(['pin1', 'pin2']);
    expect(keys(planEvictions(entries, 10 * GB, pinned))).toEqual(['a']);
  });

  test('tudo pinado e acima do teto nao evicta nada', () => {
    const entries = [entry('pin1', 8 * GB, 1), entry('pin2', 8 * GB, 2)];
    const pinned = new Set(['pin1', 'pin2']);
    expect(planEvictions(entries, 10 * GB, pinned)).toEqual([]);
  });
});

describe('entradas degeneradas', () => {
  test('teto zero derruba tudo que nao esta pinado', () => {
    const entries = [entry('a', 1, 100), entry('b', 1, 200)];
    expect(keys(planEvictions(entries, 0, new Set()))).toEqual(['a', 'b']);
  });

  test('bytes negativo ou NaN conta como zero, nunca reduz o total', () => {
    const entries = [
      { key: 'ruim', file: 'ruim.mp4', bytes: Number.NaN, lastAccessAt: 1 },
      entry('a', 4 * GB, 100),
    ];
    // Se NaN entrasse na soma, a comparacao viraria NaN > cap === false e
    // NADA seria evictado, mesmo com o cache estourado.
    expect(keys(planEvictions(entries, 2 * GB, new Set()))).toEqual(['ruim', 'a']);
  });

  test('teto negativo se comporta como zero', () => {
    expect(keys(planEvictions([entry('a', 1, 1)], -5, new Set()))).toEqual(['a']);
  });

  test('nao muta o array recebido', () => {
    const entries = [entry('b', 4 * GB, 200), entry('a', 4 * GB, 100)];
    const snapshot = keys(entries);
    planEvictions(entries, 1, new Set());
    expect(keys(entries)).toEqual(snapshot);
  });
});
