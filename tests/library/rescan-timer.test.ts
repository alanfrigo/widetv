import { describe, expect, test } from 'vitest';

import { msUntilNext, startDailyRescan } from '../../src/server/library/rescan-timer';

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Data local no dia 10 de junho de 2026 (sem horario de verao no Brasil). */
function at(hour: number, minute: number): Date {
  return new Date(2026, 5, 10, hour, minute, 0, 0);
}

describe('msUntilNext', () => {
  test('horario ainda por vir hoje: conta ate ele', () => {
    expect(msUntilNext({ hour: 4, minute: 0 }, at(1, 30))).toBe(2 * HOUR + 30 * MIN);
  });

  test('horario ja passou hoje: conta ate amanha', () => {
    expect(msUntilNext({ hour: 4, minute: 0 }, at(5, 0))).toBe(23 * HOUR);
  });

  test('exatamente no horario: agenda para amanha, nunca dispara duas vezes', () => {
    expect(msUntilNext({ hour: 4, minute: 0 }, at(4, 0))).toBe(24 * HOUR);
  });
});

describe('startDailyRescan', () => {
  interface FakeTimer {
    callback: () => void;
    delayMs: number;
  }

  /** Relogio e timer de mentira: o teste avanca o mundo na mao. */
  function harness(startAt: Date) {
    let clock = startAt.getTime();
    const timers: FakeTimer[] = [];
    const runs: number[] = [];
    const logs: string[] = [];
    let failNext = false;

    const stop = startDailyRescan({
      time: { hour: 4, minute: 0 },
      log: (message) => logs.push(message),
      now: () => new Date(clock),
      setTimer: (callback, delayMs) => {
        timers.push({ callback, delayMs });
        return 0 as unknown as NodeJS.Timeout;
      },
      clearTimer: () => undefined,
      run: async () => {
        runs.push(clock);
        if (failNext) {
          failNext = false;
          throw new Error('disco fora do ar');
        }
      },
    });

    return {
      stop,
      runs,
      logs,
      setFailNext: () => {
        failNext = true;
      },
      /** Dispara o timer pendente como se o relogio tivesse chegado la. */
      async fire(): Promise<void> {
        const timer = timers.shift();
        if (timer === undefined) throw new Error('nenhum timer agendado');
        clock += timer.delayMs;
        timer.callback();
        // O run e assincrono; espera a promessa dele assentar.
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      pendingDelay: () => timers[0]?.delayMs ?? null,
    };
  }

  test('dispara no horario e reagenda para o dia seguinte', async () => {
    const h = harness(at(1, 0));
    expect(h.pendingDelay()).toBe(3 * HOUR);

    await h.fire();
    expect(h.runs).toHaveLength(1);
    // Reagendado para 24h depois do disparo.
    expect(h.pendingDelay()).toBe(24 * HOUR);

    await h.fire();
    expect(h.runs).toHaveLength(2);
  });

  test('falha do run e logada e o dia seguinte tenta de novo', async () => {
    const h = harness(at(1, 0));
    h.setFailNext();
    await h.fire();

    expect(h.logs.some((line) => line.includes('disco fora do ar'))).toBe(true);
    // Mesmo com erro, ha um proximo agendamento.
    expect(h.pendingDelay()).toBe(24 * HOUR);
    await h.fire();
    expect(h.runs).toHaveLength(2);
  });

  test('stop cancela: nada mais e agendado depois do disparo em voo', async () => {
    const h = harness(at(1, 0));
    h.stop();
    await h.fire();
    expect(h.pendingDelay()).toBeNull();
  });
});
