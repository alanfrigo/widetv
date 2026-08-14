import { describe, expect, test } from 'vitest';

import {
  LAST_CHANNEL_KEY,
  type StorageLike,
  readLastChannel,
  writeLastChannel,
} from '../../src/web/last-channel';

/**
 * Voltar no canal onde parou e a unica memoria que este app tem. Tudo o mais e
 * derivado do relogio, entao esta e a peca que precisa aguentar acervo mudando
 * embaixo dela sem deixar o usuario numa tela morta.
 */

const CANAIS = [1, 2, 7, 12];

function storage(initial: Record<string, string> = {}): StorageLike & {
  data: Record<string, string>;
} {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

/** Navegador em modo restrito: qualquer acesso lanca. */
const hostil: StorageLike = {
  getItem() {
    throw new Error('SecurityError');
  },
  setItem() {
    throw new Error('QuotaExceededError');
  },
};

describe('readLastChannel', () => {
  test('devolve o canal salvo quando ele ainda existe', () => {
    expect(readLastChannel(storage({ [LAST_CHANNEL_KEY]: '7' }), CANAIS)).toBe(7);
  });

  test('sem nada salvo, devolve null para quem chama decidir o padrao', () => {
    expect(readLastChannel(storage(), CANAIS)).toBeNull();
  });

  test('canal salvo que sumiu do acervo devolve null em vez de tela morta', () => {
    expect(readLastChannel(storage({ [LAST_CHANNEL_KEY]: '99' }), CANAIS)).toBeNull();
  });

  test.each(['', '   ', 'abc', '-1', '1.5', 'NaN', 'Infinity', '007x'])(
    'valor corrompido (%s) devolve null',
    (raw) => {
      expect(readLastChannel(storage({ [LAST_CHANNEL_KEY]: raw }), CANAIS)).toBeNull();
    },
  );

  test('zero a esquerda continua valendo, e o que o teclado produz', () => {
    expect(readLastChannel(storage({ [LAST_CHANNEL_KEY]: '07' }), CANAIS)).toBe(7);
  });

  test('lista de canais vazia devolve null', () => {
    expect(readLastChannel(storage({ [LAST_CHANNEL_KEY]: '7' }), [])).toBeNull();
  });

  test('storage indisponivel nao derruba o app', () => {
    expect(readLastChannel(null, CANAIS)).toBeNull();
    expect(readLastChannel(hostil, CANAIS)).toBeNull();
  });
});

describe('writeLastChannel', () => {
  test('grava o canal', () => {
    const s = storage();
    writeLastChannel(s, 12);
    expect(s.data[LAST_CHANNEL_KEY]).toBe('12');
  });

  test('sobrescreve o anterior', () => {
    const s = storage({ [LAST_CHANNEL_KEY]: '1' });
    writeLastChannel(s, 7);
    expect(s.data[LAST_CHANNEL_KEY]).toBe('7');
  });

  test('storage indisponivel nao lanca', () => {
    expect(() => writeLastChannel(null, 7)).not.toThrow();
    expect(() => writeLastChannel(hostil, 7)).not.toThrow();
  });

  test('o que foi gravado e lido de volta', () => {
    const s = storage();
    writeLastChannel(s, 7);
    expect(readLastChannel(s, CANAIS)).toBe(7);
  });
});
