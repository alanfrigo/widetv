/**
 * Regras de retomada, puras: de onde continuar um episodio e quanto da barra
 * de progresso pintar. O servidor guarda a posicao; aqui mora so a decisao.
 */

export interface ProgressEntry {
  positionMs: number;
  durationMs: number;
}

/**
 * Abaixo disto nao vale retomar: quem parou na vinheta de abertura quer o
 * episodio do comeco, e um seek de 20 segundos so atrapalha.
 */
const MIN_RESUME_MS = 30_000;

/**
 * Daqui em diante o episodio conta como assistido e a proxima abertura comeca
 * do zero. Mesmo valor do servidor (que nem chega a guardar posicao assim),
 * repetido aqui porque uma entrada velha pode ter sido gravada por outra regra.
 */
const FINISHED_RATIO = 0.95;

/** Posicao de partida em ms; 0 quando nao ha nada util para retomar. */
export function resumeStartMs(entry: ProgressEntry | null | undefined): number {
  if (entry == null) return 0;
  if (!Number.isFinite(entry.positionMs) || entry.positionMs < MIN_RESUME_MS) return 0;
  if (entry.durationMs > 0 && entry.positionMs >= entry.durationMs * FINISHED_RATIO) return 0;
  return entry.positionMs;
}

/** Fracao assistida para a barra de progresso, sempre em [0, 1]. */
export function progressRatio(entry: ProgressEntry | null | undefined): number {
  if (entry == null || entry.durationMs <= 0) return 0;
  return Math.min(1, Math.max(0, entry.positionMs / entry.durationMs));
}
