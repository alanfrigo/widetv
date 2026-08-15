/**
 * Quando o relogio do catalogo pode reperguntar a grade ao servidor.
 *
 * Regra curta, mas foi um bug de verdade: o carimbo do ultimo request so era
 * marcado no caminho de sucesso e no de erro comum. O 401 saia antes de marcar,
 * entao `agora - carimbo` ficava permanentemente acima do intervalo e o
 * `setInterval` de um segundo disparava um request por segundo, para sempre,
 * todos 401. Puro e sem `Date.now()` para poder ser verificado sem browser.
 */

export interface PollGate {
  /** Epoch ms do fim do ultimo request, com sucesso OU com falha. */
  lastAtMs: number;
  /** Ha um request em voo agora. */
  inFlight: boolean;
  intervalMs: number;
}

/**
 * @param nowMs relogio local.
 * @returns true so quando nao ha request em voo E o intervalo ja passou. Um
 *          request em voo bloqueia por si: sem isso, um servidor lento faria o
 *          relogio empilhar pedidos em cima do anterior.
 */
export function shouldPoll(gate: PollGate, nowMs: number): boolean {
  if (gate.inFlight) return false;
  return nowMs - gate.lastAtMs >= gate.intervalMs;
}
