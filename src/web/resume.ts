/**
 * Regras de retomada, puras: de onde continuar um episodio e quanto da barra
 * de progresso pintar. O servidor guarda a posicao; aqui mora so a decisao.
 */

export interface ProgressEntry {
  positionMs: number;
  durationMs: number;
  /**
   * Epoch ms em que o episodio passou a contar como visto; null enquanto nao
   * terminou. Opcional porque as entradas montadas na tela (barra de uma linha
   * de episodio, por exemplo) so precisam de posicao e duracao.
   */
  watchedAt?: number | null;
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
  // Ja assistido comeca do comeco: rever e rever, nao continuar dos creditos.
  if (entry.watchedAt != null) return 0;
  if (!Number.isFinite(entry.positionMs) || entry.positionMs < MIN_RESUME_MS) return 0;
  if (entry.durationMs > 0 && entry.positionMs >= entry.durationMs * FINISHED_RATIO) return 0;
  return entry.positionMs;
}

/** Fracao assistida para a barra de progresso, sempre em [0, 1]. */
export function progressRatio(entry: ProgressEntry | null | undefined): number {
  if (entry == null || entry.durationMs <= 0) return 0;
  return Math.min(1, Math.max(0, entry.positionMs / entry.durationMs));
}

/** Quanto falta do episodio, em ms; 0 quando nao ha entrada nenhuma. */
export function remainingMs(entry: ProgressEntry | null | undefined): number {
  if (entry == null || entry.durationMs <= 0) return 0;
  return Math.max(0, entry.durationMs - entry.positionMs);
}

/**
 * Estado da linha de episodio.
 *
 * A partir da versao 11 do indice o servidor MARCA em vez de apagar, e
 * `watchedAt` responde direto. Antes disso a entrada sumia ao terminar e "sem
 * entrada" era ambiguo (nunca aberto ou ja assistido); a comparacao por fracao
 * fica como rede para as linhas gravadas naquela epoca. Continuar chutando
 * "assistido" no silencio riscaria a maratona de quem acabou de instalar o
 * servidor, entao ausencia segue significando `unseen`.
 */
export type WatchState = 'unseen' | 'watching' | 'watched';

export function watchState(entry: ProgressEntry | null | undefined): WatchState {
  if (entry == null || entry.durationMs <= 0) return 'unseen';
  if (entry.watchedAt != null) return 'watched';
  if (entry.positionMs <= 0) return 'unseen';
  return progressRatio(entry) >= FINISHED_RATIO ? 'watched' : 'watching';
}
