/**
 * Agendador do rescan diario.
 *
 * Vive DENTRO do servidor, nao num crond: o container do NAS nao tem shell nem
 * cron, e e o mesmo motivo de existir o AUTO_SCAN. A hora e LOCAL do processo
 * (a TZ do container manda) - "04:00" significa madrugada de verdade na casa,
 * nao em UTC.
 */

export interface RescanTime {
  hour: number;
  minute: number;
}

/**
 * Quanto falta ate a proxima ocorrencia do horario, em ms.
 *
 * Calculado em data local com `setHours`: numa virada de horario de verao o
 * relogio pula ou repete uma hora e o disparo desliza junto, o que para um
 * rescan diario e exatamente o comportamento inofensivo.
 */
export function msUntilNext(time: RescanTime, now: Date): number {
  const next = new Date(now);
  next.setHours(time.hour, time.minute, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

export interface DailyRescanOptions {
  time: RescanTime;
  /** O trabalho da madrugada. Erro aqui e logado e o dia seguinte tenta de novo. */
  run: () => Promise<void>;
  log: (message: string) => void;
  /** Injetaveis para teste. */
  now?: () => Date;
  setTimer?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
}

/**
 * Dispara `run` todo dia no horario dado. Reagenda DEPOIS de terminar, nunca
 * em paralelo: um acervo gigante que leve horas para escanear simplesmente
 * empurra o disparo seguinte, em vez de acumular dois scans no mesmo disco.
 *
 * @returns funcao que cancela o agendamento (usada no shutdown).
 */
export function startDailyRescan(options: DailyRescanOptions): () => void {
  const now = options.now ?? (() => new Date());
  const setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  function schedule(): void {
    if (stopped) return;
    const delayMs = msUntilNext(options.time, now());
    options.log(`proximo rescan em ${String(Math.round(delayMs / 60_000))} min`);
    timer = setTimer(() => {
      void options
        .run()
        .catch((error: unknown) => {
          // O rescan de amanha e a nova tentativa; derrubar o servidor por
          // causa de uma varredura noturna seria trocar o certo pelo errado.
          options.log(
            `rescan falhou: ${error instanceof Error ? error.message : String(error)}`,
          );
        })
        .finally(schedule);
    }, delayMs);
  }

  schedule();

  return () => {
    stopped = true;
    if (timer !== null) clearTimer(timer);
  };
}
