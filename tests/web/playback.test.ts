import { describe, expect, test, vi } from 'vitest';

import { awaitMediaReady, type PlayableMedia, startPlayback } from '../../src/web/playback';

/**
 * A politica de autoplay do Chrome recusa video com som antes de um gesto do
 * usuario, mas nunca recusa video mudo. A imagem por isso nao tem motivo para
 * esperar: se o som for negado, entra mudo na hora e o som liga no primeiro
 * toque.
 */

function media(behaviour: { failUnmuted?: boolean; failAlways?: boolean } = {}): PlayableMedia & {
  attempts: { muted: boolean }[];
} {
  const attempts: { muted: boolean }[] = [];
  return {
    muted: false,
    attempts,
    async play() {
      attempts.push({ muted: this.muted });
      if (behaviour.failAlways === true) throw new Error('NotAllowedError');
      if (behaviour.failUnmuted === true && !this.muted) throw new Error('NotAllowedError');
    },
  };
}

describe('startPlayback', () => {
  test('navegador permitindo som, toca com som numa tentativa so', async () => {
    const m = media();
    expect(await startPlayback(m, false)).toBe('playing');
    expect(m.muted).toBe(false);
    expect(m.attempts).toHaveLength(1);
  });

  test('som negado cai para mudo em vez de deixar a tela parada', async () => {
    const m = media({ failUnmuted: true });
    expect(await startPlayback(m, false)).toBe('playing-muted');
    expect(m.muted).toBe(true);
    expect(m.attempts.map((a) => a.muted)).toEqual([false, true]);
  });

  test('nem mudo funcionando, reporta bloqueio', async () => {
    const m = media({ failAlways: true });
    expect(await startPlayback(m, false)).toBe('blocked');
    expect(m.attempts).toHaveLength(2);
  });

  test('usuario ja escolheu mudo: nao existe fallback a fazer', async () => {
    const m = media({ failUnmuted: true });
    m.muted = true;
    expect(await startPlayback(m, true)).toBe('playing');
    expect(m.attempts).toHaveLength(1);
  });

  test('mudo do usuario nunca e desfeito para tentar tocar com som', async () => {
    const m = media();
    m.muted = true;
    await startPlayback(m, true);
    expect(m.attempts).toEqual([{ muted: true }]);
    expect(m.muted).toBe(true);
  });

  test('falha com o mudo do usuario ligado tambem reporta bloqueio', async () => {
    const m = media({ failAlways: true });
    m.muted = true;
    expect(await startPlayback(m, true)).toBe('blocked');
    expect(m.attempts).toHaveLength(1);
  });

  test('nao deixa o elemento mudo quando a primeira tentativa deu certo', async () => {
    const m = media();
    await startPlayback(m, false);
    expect(m.muted).toBe(false);
  });

  test('rejeicao sincrona de play tambem e tratada', async () => {
    const m: PlayableMedia = {
      muted: false,
      play: vi.fn(() => Promise.reject(new Error('NotAllowedError'))),
    };
    expect(await startPlayback(m, false)).toBe('blocked');
  });
});

/**
 * `loadedmetadata` pode simplesmente nunca chegar: aba em segundo plano que o
 * Chrome estrangula, arquivo corrompido, rede que morre no meio. Esperar por ele
 * sem prazo trava o canal para sempre, sem erro e sem tela.
 */
describe('awaitMediaReady', () => {
  function media() {
    const listeners: Record<string, (() => void)[]> = {};
    return {
      readyState: 0,
      addEventListener(type: string, fn: () => void) {
        (listeners[type] ??= []).push(fn);
      },
      emit(type: string) {
        for (const fn of listeners[type] ?? []) fn();
      },
      count(type: string) {
        return (listeners[type] ?? []).length;
      },
    };
  }

  test('resolve na hora quando a metadata ja chegou', async () => {
    const m = media();
    m.readyState = 1;
    await expect(awaitMediaReady(m, 5000)).resolves.toBe('ready');
    expect(m.count('loadedmetadata')).toBe(0);
  });

  test('resolve quando loadedmetadata dispara', async () => {
    const m = media();
    const p = awaitMediaReady(m, 5000);
    m.emit('loadedmetadata');
    await expect(p).resolves.toBe('ready');
  });

  test('resolve com erro em vez de esperar para sempre', async () => {
    const m = media();
    const p = awaitMediaReady(m, 5000);
    m.emit('error');
    await expect(p).resolves.toBe('error');
  });

  test('estourar o prazo resolve como timeout, nao lanca nem trava', async () => {
    vi.useFakeTimers();
    try {
      const m = media();
      const p = awaitMediaReady(m, 5000);
      await vi.advanceTimersByTimeAsync(5001);
      await expect(p).resolves.toBe('timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  test('metadata chegando antes do prazo vence o timeout', async () => {
    vi.useFakeTimers();
    try {
      const m = media();
      const p = awaitMediaReady(m, 5000);
      await vi.advanceTimersByTimeAsync(100);
      m.emit('loadedmetadata');
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(p).resolves.toBe('ready');
    } finally {
      vi.useRealTimers();
    }
  });

  test('so resolve uma vez, mesmo com varios eventos', async () => {
    const m = media();
    const p = awaitMediaReady(m, 5000);
    m.emit('loadedmetadata');
    m.emit('error');
    m.emit('loadedmetadata');
    await expect(p).resolves.toBe('ready');
  });
});
