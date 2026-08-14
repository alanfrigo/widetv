import { describe, it, expect } from 'vitest';
import {
  buildTimeline,
  channelPhaseOffsetMs,
  EmptyScheduleError,
  resolveSlot,
  type ScheduleEntry,
} from '../../src/server/schedule/clock.js';

/** Grade de teste com duracoes redondas, faceis de conferir de cabeca. */
const THREE: readonly ScheduleEntry[] = [
  { id: 'a', durationMs: 1000 },
  { id: 'b', durationMs: 2000 },
  { id: 'c', durationMs: 3000 },
];

describe('resolveSlot - grade vazia', () => {
  it('lanca EmptyScheduleError quando nao ha entradas', () => {
    expect(() => resolveSlot([], 0, 0)).toThrow(EmptyScheduleError);
  });
});

describe('resolveSlot - dentro da primeira volta', () => {
  it('resolve uma posicao no primeiro item', () => {
    const slot = resolveSlot(THREE, 1_000_000, 1_000_400);
    expect(slot).toEqual({
      index: 0,
      offsetMs: 400,
      endsAtMs: 1_001_000,
      nextIndex: 1,
    });
  });
});

describe('resolveSlot - wrap do loop', () => {
  it('da a volta na grade depois do fim do ciclo', () => {
    // ciclo = 6000. Duas voltas completas + 1500 cai no item 'b' (1000..3000).
    const slot = resolveSlot(THREE, 0, 6000 * 2 + 1500);
    expect(slot).toEqual({
      index: 1,
      offsetMs: 500,
      endsAtMs: 6000 * 2 + 3000,
      nextIndex: 2,
    });
  });
});

describe('resolveSlot - epoch no futuro', () => {
  it('nunca devolve offset negativo quando nowMs < epochMs', () => {
    // -1500 em um ciclo de 6000 equivale a 4500: item 'c' (3000..6000).
    const slot = resolveSlot(THREE, 10_000, 8500);
    expect(slot).toEqual({
      index: 2,
      offsetMs: 1500,
      endsAtMs: 10_000, // 8500 + (3000 - 1500)
      nextIndex: 0,
    });
  });

  it('trata muitas voltas negativas sem perder o sinal', () => {
    // -6000 * 3 - 500 -> elapsed 5500, ainda no item 'c'.
    const slot = resolveSlot(THREE, 0, -18_500);
    expect(slot.index).toBe(2);
    expect(slot.offsetMs).toBe(2500);
    expect(slot.offsetMs).toBeGreaterThanOrEqual(0);
    expect(slot.endsAtMs).toBe(-18_000);
  });
});

describe('resolveSlot - duracao invalida', () => {
  it('rejeita durationMs zero em vez de pular a entrada', () => {
    const entries: ScheduleEntry[] = [
      { id: 'a', durationMs: 1000 },
      { id: 'zero', durationMs: 0 },
      { id: 'c', durationMs: 3000 },
    ];
    expect(() => resolveSlot(entries, 0, 500)).toThrow(RangeError);
    // A mensagem tem que dizer qual entrada, senao nao da pra achar o arquivo.
    expect(() => resolveSlot(entries, 0, 500)).toThrow(/zero/);
  });

  it('rejeita durationMs negativa', () => {
    const entries: ScheduleEntry[] = [{ id: 'neg', durationMs: -1 }];
    expect(() => resolveSlot(entries, 0, 0)).toThrow(RangeError);
  });

  it('rejeita durationMs NaN e infinita', () => {
    expect(() => resolveSlot([{ id: 'nan', durationMs: NaN }], 0, 0)).toThrow(RangeError);
    expect(() => resolveSlot([{ id: 'inf', durationMs: Infinity }], 0, 0)).toThrow(RangeError);
  });
});

describe('buildTimeline', () => {
  it('devolve as somas prefixas cumulativas, terminando no ciclo', () => {
    const timeline = buildTimeline(THREE);
    expect(Array.from(timeline)).toEqual([1000, 3000, 6000]);
  });

  it('lanca EmptyScheduleError para grade vazia', () => {
    expect(() => buildTimeline([])).toThrow(EmptyScheduleError);
  });

  it('lanca RangeError para duracao invalida', () => {
    expect(() => buildTimeline([{ id: 'x', durationMs: 0 }])).toThrow(RangeError);
  });

  it('nao perde precisao quando a soma passa de 2^31 ms', () => {
    // 300 x 10.000.000 ms = 3e9, bem acima do teto de Int32Array.
    const entries: ScheduleEntry[] = Array.from({ length: 300 }, (_, i) => ({
      id: `e${i}`,
      durationMs: 10_000_000,
    }));
    const timeline = buildTimeline(entries);
    expect(timeline.length).toBe(300);
    expect(timeline[299]).toBe(3_000_000_000);
    expect(timeline[299]).toBeGreaterThan(2 ** 31 - 1);
  });
});

describe('resolveSlot - timeline cacheada', () => {
  it('aceita uma timeline pre-computada e da o mesmo resultado', () => {
    const timeline = buildTimeline(THREE);
    const comCache = resolveSlot(THREE, 0, 4500, timeline);
    const semCache = resolveSlot(THREE, 0, 4500);
    expect(comCache).toEqual(semCache);
    expect(comCache.index).toBe(2);
    expect(comCache.offsetMs).toBe(1500);
  });

  it('rejeita timeline que nao corresponde a grade', () => {
    const outra = buildTimeline([{ id: 'x', durationMs: 5 }]);
    expect(() => resolveSlot(THREE, 0, 0, outra)).toThrow(RangeError);
  });
});

describe('resolveSlot - fronteiras exatas', () => {
  it('no instante exato de troca entra o item NOVO com offsetMs 0', () => {
    // 1000 e o fim de 'a' e o inicio de 'b'.
    const slot = resolveSlot(THREE, 0, 1000);
    expect(slot.index).toBe(1);
    expect(slot.offsetMs).toBe(0);
    expect(slot.endsAtMs).toBe(3000);
    expect(slot.nextIndex).toBe(2);
  });

  it('o ultimo ms de um item ainda pertence a ele', () => {
    const slot = resolveSlot(THREE, 0, 999);
    expect(slot.index).toBe(0);
    expect(slot.offsetMs).toBe(999);
    expect(slot.endsAtMs).toBe(1000);
  });

  it('no ponto exato de wrap volta ao item 0 com offsetMs 0', () => {
    const slot = resolveSlot(THREE, 0, 6000);
    expect(slot).toEqual({ index: 0, offsetMs: 0, endsAtMs: 7000, nextIndex: 1 });
  });

  it('o ultimo ms do ciclo ainda pertence ao ultimo item', () => {
    const slot = resolveSlot(THREE, 0, 5999);
    expect(slot.index).toBe(2);
    expect(slot.offsetMs).toBe(2999);
    expect(slot.endsAtMs).toBe(6000);
    expect(slot.nextIndex).toBe(0);
  });

  it('wrap exato com epoch no futuro tambem cai no item 0 com offset 0', () => {
    // nowMs - epochMs = -6000, exatamente um ciclo negativo.
    const slot = resolveSlot(THREE, 6000, 0);
    expect(slot).toEqual({ index: 0, offsetMs: 0, endsAtMs: 1000, nextIndex: 1 });
  });

  it('nowMs igual a epochMs comeca no primeiro item com offsetMs 0', () => {
    const slot = resolveSlot(THREE, 1_700_000_000_000, 1_700_000_000_000);
    expect(slot).toEqual({
      index: 0,
      offsetMs: 0,
      endsAtMs: 1_700_000_001_000,
      nextIndex: 1,
    });
  });

  it('toda fronteira de uma grade longa entra no item novo com offset 0', () => {
    const entries: ScheduleEntry[] = Array.from({ length: 50 }, (_, i) => ({
      id: `e${i}`,
      durationMs: (i + 1) * 1000,
    }));
    const timeline = buildTimeline(entries);
    let start = 0;
    for (let i = 0; i < entries.length; i += 1) {
      const slot = resolveSlot(entries, 0, start, timeline);
      expect([i, slot.offsetMs]).toEqual([slot.index, 0]);
      // O ms anterior tem que ser do item anterior, nunca do novo.
      if (i > 0) {
        const antes = resolveSlot(entries, 0, start - 1, timeline);
        expect(antes.index).toBe(i - 1);
        expect(antes.offsetMs).toBe(entries[i - 1]!.durationMs - 1);
      }
      start += entries[i]!.durationMs;
    }
  });
});

describe('channelPhaseOffsetMs', () => {
  const CYCLE = 300 * 22 * 60 * 1000; // 300 episodios de 22 min

  it('e deterministico para a mesma entrada', () => {
    const a = channelPhaseOffsetMs('tom-e-jerry', CYCLE);
    const b = channelPhaseOffsetMs('tom-e-jerry', CYCLE);
    const c = channelPhaseOffsetMs('tom-e-jerry', CYCLE);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('devolve inteiro sempre em [0, cycleMs)', () => {
    for (let i = 0; i < 500; i += 1) {
      const cycle = 1000 + i * 7919;
      const offset = channelPhaseOffsetMs(`canal-${i}`, cycle);
      expect(Number.isInteger(offset)).toBe(true);
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThan(cycle);
    }
  });

  it('funciona com ciclo minimo de 1 ms', () => {
    expect(channelPhaseOffsetMs('x', 1)).toBe(0);
  });

  it('ids diferentes tendem a offsets diferentes', () => {
    const ids = Array.from({ length: 500 }, (_, i) => `canal-${i}`);
    const offsets = new Set(ids.map((id) => channelPhaseOffsetMs(id, CYCLE)));
    expect(offsets.size).toBeGreaterThan(490);
  });

  it('espalha ids parecidos pelo ciclo inteiro, nao so no comeco', () => {
    // Ids que diferem em um caractere nao podem cair todos no mesmo pedaco.
    const baldes = new Set<number>();
    for (let i = 0; i < 300; i += 1) {
      const offset = channelPhaseOffsetMs(`serie-${i}`, CYCLE);
      baldes.add(Math.floor((offset / CYCLE) * 10));
    }
    expect(baldes.size).toBe(10);
  });

  it('o mesmo id em ciclos diferentes da fases diferentes', () => {
    const a = channelPhaseOffsetMs('scooby-doo', CYCLE);
    const b = channelPhaseOffsetMs('scooby-doo', CYCLE + 1);
    expect(a).not.toBe(b);
  });

  it('aceita id vazio e id com acento sem quebrar', () => {
    expect(channelPhaseOffsetMs('', CYCLE)).toBeGreaterThanOrEqual(0);
    expect(channelPhaseOffsetMs('', CYCLE)).toBeLessThan(CYCLE);
    const acentuado = channelPhaseOffsetMs('caverna-do-dragão', CYCLE);
    expect(acentuado).toBeGreaterThanOrEqual(0);
    expect(acentuado).toBeLessThan(CYCLE);
    expect(acentuado).not.toBe(channelPhaseOffsetMs('caverna-do-dragao', CYCLE));
  });

  it('rejeita ciclo zero ou negativo', () => {
    expect(() => channelPhaseOffsetMs('x', 0)).toThrow(RangeError);
    expect(() => channelPhaseOffsetMs('x', -1)).toThrow(RangeError);
    expect(() => channelPhaseOffsetMs('x', NaN)).toThrow(RangeError);
  });
});

describe('resolveSlot - instantes invalidos', () => {
  it('rejeita nowMs ou epochMs nao finito em vez de devolver slot com NaN', () => {
    expect(() => resolveSlot(THREE, 0, NaN)).toThrow(RangeError);
    expect(() => resolveSlot(THREE, NaN, 0)).toThrow(RangeError);
    expect(() => resolveSlot(THREE, 0, Infinity)).toThrow(RangeError);
  });
});

describe('resolveSlot - posicoes dentro da grade', () => {
  it('resolve o item do meio', () => {
    const slot = resolveSlot(THREE, 0, 2500);
    expect(slot).toEqual({ index: 1, offsetMs: 1500, endsAtMs: 3000, nextIndex: 2 });
  });

  it('resolve o ultimo item e aponta o proximo para o comeco', () => {
    const slot = resolveSlot(THREE, 0, 4000);
    expect(slot).toEqual({ index: 2, offsetMs: 1000, endsAtMs: 6000, nextIndex: 0 });
  });
});

describe('resolveSlot - serie de um episodio so', () => {
  const UM: readonly ScheduleEntry[] = [{ id: 'unico', durationMs: 1_320_000 }];

  it('index e nextIndex sao sempre 0', () => {
    for (const nowMs of [0, 1, 1_319_999, 1_320_000, 1_320_001, 99_999_999_999]) {
      const slot = resolveSlot(UM, 0, nowMs);
      expect(slot.index).toBe(0);
      expect(slot.nextIndex).toBe(0);
      expect(slot.offsetMs).toBe(nowMs % 1_320_000);
      expect(slot.endsAtMs).toBe(nowMs + (1_320_000 - (nowMs % 1_320_000)));
    }
  });

  it('reinicia em offsetMs 0 no fim exato do unico episodio', () => {
    expect(resolveSlot(UM, 0, 1_320_000).offsetMs).toBe(0);
  });
});

describe('resolveSlot - ciclo grande, varias voltas', () => {
  // 300 episodios com duracoes desiguais, para nao mascarar erro de soma.
  const LONGA: readonly ScheduleEntry[] = Array.from({ length: 300 }, (_, i) => ({
    id: `ep-${i}`,
    durationMs: (20 + (i % 7)) * 60 * 1000,
  }));
  const CYCLE = LONGA.reduce((acc, e) => acc + e.durationMs, 0);
  const EPOCH = 1_700_000_000_000; // epoch realista, nao zero

  /** Oraculo ingenuo e obvio, para conferir a busca binaria. */
  function referencia(nowMs: number): { index: number; offsetMs: number } {
    let elapsed = ((nowMs - EPOCH) % CYCLE + CYCLE) % CYCLE;
    for (let i = 0; i < LONGA.length; i += 1) {
      const d = LONGA[i]!.durationMs;
      if (elapsed < d) return { index: i, offsetMs: elapsed };
      elapsed -= d;
    }
    throw new Error('inalcancavel');
  }

  it('bate com o oraculo em milhares de instantes espalhados', () => {
    const timeline = buildTimeline(LONGA);
    // Gerador determinista, sem Math.random.
    let seed = 12345;
    for (let n = 0; n < 3000; n += 1) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const voltas = seed % 9000; // ate ~9000 voltas: mais de 100 anos de grade
      const dentro = seed % CYCLE;
      const nowMs = EPOCH + voltas * CYCLE + dentro;
      const slot = resolveSlot(LONGA, EPOCH, nowMs, timeline);
      expect({ index: slot.index, offsetMs: slot.offsetMs }).toEqual(referencia(nowMs));
    }
  });

  it('nao perde precisao depois de milhares de voltas', () => {
    const nowMs = EPOCH + 8765 * CYCLE + 137 * (20 * 60 * 1000);
    const alvo = referencia(nowMs);
    const slot = resolveSlot(LONGA, EPOCH, nowMs);
    expect(slot.index).toBe(alvo.index);
    expect(slot.offsetMs).toBe(alvo.offsetMs);
    expect(Number.isInteger(slot.offsetMs)).toBe(true);
    expect(Number.isInteger(slot.endsAtMs)).toBe(true);
    expect(slot.endsAtMs).toBe(nowMs + (LONGA[slot.index]!.durationMs - slot.offsetMs));
  });

  it('todas as fronteiras da volta 4321 entram com offsetMs 0', () => {
    const timeline = buildTimeline(LONGA);
    const base = EPOCH + 4321 * CYCLE;
    let start = 0;
    for (let i = 0; i < LONGA.length; i += 1) {
      const slot = resolveSlot(LONGA, EPOCH, base + start, timeline);
      expect([slot.index, slot.offsetMs]).toEqual([i, 0]);
      start += LONGA[i]!.durationMs;
    }
    // Depois da ultima fronteira + duracao, volta para o item 0.
    expect(resolveSlot(LONGA, EPOCH, base + start, timeline).index).toBe(0);
  });

  it('mantem exatidao quando o ciclo passa de 2^31 ms', () => {
    // 300 x 2h = 2.16e9 ms, acima do teto de Int32Array.
    const entries: ScheduleEntry[] = Array.from({ length: 300 }, (_, i) => ({
      id: `longo-${i}`,
      durationMs: 2 * 60 * 60 * 1000,
    }));
    const cycle = 300 * 2 * 60 * 60 * 1000;
    expect(cycle).toBeGreaterThan(2 ** 31 - 1);
    const nowMs = EPOCH + 3 * cycle + 299 * 2 * 60 * 60 * 1000 + 12_345;
    const slot = resolveSlot(entries, EPOCH, nowMs);
    expect(slot.index).toBe(299);
    expect(slot.offsetMs).toBe(12_345);
    expect(slot.nextIndex).toBe(0);
  });
});

describe('duracoes fracionarias vindas do probe', () => {
  // format.duration do ffprobe vem em segundos e pode gerar ms com fracao.
  // Truncar aqui faria a grade derivar alguns ms por volta, entao a soma
  // prefixa tem que preservar o valor exato.
  const FRAC: readonly ScheduleEntry[] = [
    { id: 'a', durationMs: 1000.5 },
    { id: 'b', durationMs: 2000.25 },
  ];

  it('a timeline nao trunca a fracao', () => {
    expect(Array.from(buildTimeline(FRAC))).toEqual([1000.5, 3000.75]);
  });

  it('a fronteira fracionaria ainda entra no item novo com offset 0', () => {
    const slot = resolveSlot(FRAC, 0, 1000.5);
    expect(slot.index).toBe(1);
    expect(slot.offsetMs).toBe(0);
    expect(slot.endsAtMs).toBe(3000.75);
  });
});
