/**
 * Relogio da grade. Funcao pura: sem I/O, sem Date.now(), sem estado de modulo.
 * Tudo entra por parametro.
 */

export interface ScheduleEntry {
  id: string;
  durationMs: number;
}

export interface Slot {
  /** Indice em `entries` do que esta no ar. */
  index: number;
  /** Posicao dentro desse item, em ms, no instante `nowMs`. */
  offsetMs: number;
  /** Epoch ms em que esse item termina. */
  endsAtMs: number;
  /** Indice do proximo item; volta a 0 depois do ultimo. */
  nextIndex: number;
}

export class EmptyScheduleError extends Error {
  constructor(message = 'grade vazia: nenhuma entrada para resolver') {
    super(message);
    this.name = 'EmptyScheduleError';
  }
}

/**
 * Duracao <= 0 trava a grade num loop infinito, entao e erro duro e nao
 * entrada pulada em silencio.
 */
function assertValidDuration(entry: ScheduleEntry, index: number): void {
  const { durationMs } = entry;
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new RangeError(
      `durationMs invalida na posicao ${index} (id '${entry.id}'): ${String(durationMs)}`,
    );
  }
}

/** Teto de Int32Array. Acima disso a soma prefixa precisa de Float64Array. */
const INT32_MAX = 2 ** 31 - 1;

/**
 * Somas prefixas cumulativas: `timeline[i]` e o fim do item `i` dentro do
 * ciclo, entao `timeline[n - 1]` e a duracao do ciclo inteiro. Exportada para
 * permitir cache por canal.
 */
export function buildTimeline(entries: readonly ScheduleEntry[]): Int32Array | Float64Array {
  if (entries.length === 0) {
    throw new EmptyScheduleError();
  }

  // Soma em Number (inteiro exato ate 2^53) antes de escolher o container.
  const sums: number[] = new Array<number>(entries.length);
  let total = 0;
  // Duracao vinda do ffprobe pode ter fracao de ms; Int32Array truncaria e a
  // grade derivaria alguns ms por volta.
  let inteiras = true;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!;
    assertValidDuration(entry, i);
    total += entry.durationMs;
    if (!Number.isInteger(entry.durationMs)) {
      inteiras = false;
    }
    sums[i] = total;
  }

  if (total > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`duracao total da grade fora do alcance seguro: ${String(total)}`);
  }

  // 300 episodios longos passam de 2^31 ms (~24 dias) com facilidade.
  const cabeEmInt32 = inteiras && total <= INT32_MAX;
  const timeline = cabeEmInt32 ? new Int32Array(entries.length) : new Float64Array(entries.length);
  timeline.set(sums);
  return timeline;
}

export function resolveSlot(
  entries: readonly ScheduleEntry[],
  epochMs: number,
  nowMs: number,
  timeline?: ReturnType<typeof buildTimeline>,
): Slot {
  if (entries.length === 0) {
    throw new EmptyScheduleError();
  }
  if (!Number.isFinite(epochMs) || !Number.isFinite(nowMs)) {
    // Sem isso um NaN vira um Slot com NaN dentro e o canal congela sem erro.
    throw new RangeError(
      `epochMs e nowMs tem que ser finitos: epochMs=${String(epochMs)} nowMs=${String(nowMs)}`,
    );
  }
  if (timeline !== undefined && timeline.length !== entries.length) {
    throw new RangeError(
      `timeline com ${timeline.length} somas nao corresponde a grade de ${entries.length} entradas`,
    );
  }

  // Timeline cacheada ja foi validada quando construida; nao revalida a grade.
  const sums = timeline ?? buildTimeline(entries);
  const cycleMs = sums[sums.length - 1]!;

  // Modulo que sempre cai em [0, cycleMs), inclusive com epoch no futuro.
  const elapsed = (((nowMs - epochMs) % cycleMs) + cycleMs) % cycleMs;

  // Menor indice cujo fim e estritamente maior que `elapsed`. O `>` (e nao
  // `>=`) e o que faz a fronteira exata cair no item novo com offset 0.
  let lo = 0;
  let hi = sums.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sums[mid]! > elapsed) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }

  const index = lo;
  const start = index === 0 ? 0 : sums[index - 1]!;
  const offsetMs = elapsed - start;
  const endsAtMs = nowMs + (sums[index]! - elapsed);
  return {
    index,
    offsetMs,
    endsAtMs,
    nextIndex: index + 1 === sums.length ? 0 : index + 1,
  };
}

/** FNV-1a de 32 bits com semente, sobre as unidades UTF-16 do id. */
function fnv1a32(text: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    // Math.imul faz a multiplicacao em 32 bits, sem passar pelo double.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // Avalanche final: sem isso ids vizinhos ('canal-1', 'canal-2') ficam
  // colados no comeco do ciclo.
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x2545f491) >>> 0;
  hash ^= hash >>> 15;
  return hash >>> 0;
}

/**
 * Deslocamento estavel por canal, para que canais diferentes nao estejam todos
 * no episodio 1 no mesmo instante. Deterministico: depende apenas de
 * `channelId` e `cycleMs`. Resultado inteiro sempre em [0, cycleMs).
 */
export function channelPhaseOffsetMs(channelId: string, cycleMs: number): number {
  if (!Number.isFinite(cycleMs) || cycleMs <= 0) {
    throw new RangeError(`cycleMs tem que ser positivo e finito: ${String(cycleMs)}`);
  }

  const span = Math.floor(cycleMs);
  if (span <= 0) {
    throw new RangeError(`cycleMs menor que 1 ms: ${String(cycleMs)}`);
  }

  // Dois hashes de 32 bits combinados em 53 bits exatos (limite do double),
  // para dar espalhamento mesmo em ciclos de centenas de milhoes de ms.
  const alto = fnv1a32(channelId, 0x811c9dc5);
  const baixo = fnv1a32(channelId, 0x9e3779b9);
  // O ciclo entra na mistura para que o mesmo id mude de fase se a grade mudar.
  const semente = (Math.imul(baixo ^ span, 0x85ebca6b) >>> 0) ^ (span >>> 0);
  const combinado = alto * 2_097_152 + (semente >>> 11); // < 2^53

  return combinado % span;
}
