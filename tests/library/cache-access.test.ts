import { describe, expect, test } from 'vitest';

import { createCacheAccess } from '../../src/server/library/cache-access';

function harness(options: { touchIntervalMs?: number; pinTtlMs?: number } = {}) {
  const touches: { key: string; at: number }[] = [];
  let clock = 1_000_000;
  const access = createCacheAccess({
    store: {
      touchCacheFile: (key, at) => {
        touches.push({ key, at });
      },
    },
    now: () => clock,
    touchIntervalMs: options.touchIntervalMs ?? 60_000,
    pinTtlMs: options.pinTtlMs ?? 300_000,
  });
  return {
    access,
    touches,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('throttle das gravacoes', () => {
  test('o primeiro uso grava', () => {
    const { access, touches } = harness();
    access.record('remux:a');
    expect(touches).toEqual([{ key: 'remux:a', at: 1_000_000 }]);
  });

  test('rajada de Range do <video> vira UMA gravacao', () => {
    const { access, touches } = harness();
    for (let i = 0; i < 200; i += 1) access.record('remux:a');
    expect(touches).toHaveLength(1);
  });

  test('grava de novo depois do intervalo', () => {
    const { access, touches, advance } = harness({ touchIntervalMs: 60_000 });
    access.record('remux:a');
    advance(59_999);
    access.record('remux:a');
    expect(touches).toHaveLength(1);
    advance(2);
    access.record('remux:a');
    expect(touches).toHaveLength(2);
    expect(touches[1]?.at).toBe(1_060_001);
  });

  test('o throttle e por arquivo, nao global', () => {
    const { access, touches } = harness();
    access.record('remux:a');
    access.record('remux:b');
    expect(touches.map((item) => item.key)).toEqual(['remux:a', 'remux:b']);
  });

  test('pin nunca grava no banco', () => {
    const { access, touches } = harness();
    access.pin('remux:a');
    expect(touches).toEqual([]);
  });
});

describe('pinning', () => {
  test('o que acabou de ser usado esta protegido', () => {
    const { access } = harness();
    access.record('remux:a');
    expect(access.pinned().has('remux:a')).toBe(true);
  });

  test('o pin expira depois do TTL', () => {
    const { access, advance } = harness({ pinTtlMs: 300_000 });
    access.record('remux:a');
    advance(300_001);
    expect(access.pinned().has('remux:a')).toBe(false);
  });

  test('uso repetido renova o pin mesmo sem gravar', () => {
    const { access, touches, advance } = harness({ touchIntervalMs: 60_000, pinTtlMs: 300_000 });
    access.record('remux:a');
    // Meia hora de episodio, gravando de minuto em minuto; o pin nunca cai.
    for (let minute = 0; minute < 30; minute += 1) {
      advance(60_000);
      access.record('remux:a');
      expect(access.pinned().has('remux:a')).toBe(true);
    }
    expect(touches.length).toBeGreaterThan(1);
  });

  test('pin sem record tambem protege, e e o caso do preload', () => {
    const { access } = harness();
    access.pin('remux:proximo');
    expect(access.pinned().has('remux:proximo')).toBe(true);
  });

  test('arquivo nunca visto nao esta protegido', () => {
    const { access } = harness();
    expect(access.pinned().has('remux:desconhecido')).toBe(false);
  });
});

describe('memoria', () => {
  test('a tabela interna nao cresce sem limite', () => {
    const { access, advance } = harness({ pinTtlMs: 1_000 });
    for (let i = 0; i < 600; i += 1) access.record(`remux:${String(i)}`);
    advance(2_000);
    // Passado o TTL, uma gravacao nova dispara a poda e o conjunto protegido
    // volta a ter so o que e recente.
    access.record('remux:novo');
    expect([...access.pinned()]).toEqual(['remux:novo']);
  });
});
