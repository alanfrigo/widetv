import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { Store } from './index-store';
import { probeFile } from './probe';
import type { ProbeResult } from './probe-types';
import { ffmpegConvert, remuxEpisode, type Convert } from './remux-job';
import { planRemux } from './remux-plan';

/**
 * Fila de remux sob demanda, para o episodio que alguem esta TENTANDO assistir.
 *
 * A rodada de catalogo (remux-job) anda na ordem da grade; num acervo grande
 * ela leva horas ate chegar no episodio em tela, e enquanto isso a rota de
 * stream responderia "preparando" para sempre. Esta fila fura a ordem: quando
 * um pedido de stream cairia no original mudo (faixa default dolby/dts sem
 * remux valido), o proprio episodio entra aqui na frente de tudo.
 *
 * Roda mesmo com autoRemux desligado: aquela preferencia poupa o NAS da rodada
 * em massa, nao proibe atender quem apertou play. Um worker so, pelo mesmo
 * motivo das outras filas: o custo e o disco, e duas copias simultaneas so
 * brigam entre si.
 */

export interface RemuxQueueOptions {
  store: Store;
  libraryRoot: string;
  /** DATA_DIR do servidor; as copias vivem em `<dataDir>/remux`. */
  dataDir: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  timeoutMs?: number;
  /** Injetaveis para teste. */
  convert?: Convert;
  probe?: (filePath: string) => Promise<ProbeResult>;
  log?: (message: string) => void;
  now?: () => number;
  /**
   * Chamado depois de CADA item, com ou sem sucesso. Existe para o orcamento de
   * disco: acabou de nascer uma copia do tamanho de um episodio, e a hora de
   * conferir o teto e agora, nao no proximo boot.
   */
  onSettled?: () => void;
}

export interface RemuxQueue {
  /**
   * Garante que o episodio tenha (ou passe a ter) remux valido. Nao devolve
   * status: o cliente ja recebeu 202 e vai consultar a rota de stream de novo,
   * que enxerga a linha nova do indice assim que a conversao termina.
   */
  ensure(episodeId: string): void;
}

const DEFAULT_TIMEOUT_MS = 30 * 60_000;

export function createRemuxQueue(options: RemuxQueueOptions): RemuxQueue {
  const { store, libraryRoot } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => undefined);
  const probe =
    options.probe ??
    ((filePath: string) => probeFile(filePath, { ffprobePath: options.ffprobePath ?? 'ffprobe' }));
  const convert =
    options.convert ??
    ffmpegConvert(options.ffmpegPath ?? 'ffmpeg', options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const remuxDir = join(options.dataDir, 'remux');

  /** Ids em voo ou na fila; e o que impede o mesmo episodio de dobrar. */
  const pending = new Set<string>();
  const queue: string[] = [];
  let running = false;

  async function generate(episodeId: string): Promise<void> {
    const row = store.getEpisode(episodeId);
    if (row === null) return;

    const plan = planRemux({
      relativePath: row.id,
      videoCodec: row.videoCodec,
      audioTracks: row.audioTracks,
    });
    if (plan === null) return;

    await mkdir(remuxDir, { recursive: true });
    // 'skipped' e um resultado normal aqui: a rodada de catalogo pode ter
    // convertido este episodio entre o enfileiramento e a vez dele.
    await remuxEpisode({ store, libraryRoot, remuxDir, convert, probe, now }, row, plan);
  }

  function pump(): void {
    if (running) return;
    const next = queue.shift();
    if (next === undefined) return;
    running = true;

    void generate(next)
      .catch((error: unknown) => {
        // Falha nao fica presa no `pending`: o proximo pedido tenta de novo.
        log(
          `remux sob demanda falhou em ${next}: ` +
            (error instanceof Error ? error.message : String(error)),
        );
      })
      .finally(() => {
        pending.delete(next);
        running = false;
        options.onSettled?.();
        pump();
      });
  }

  return {
    ensure(episodeId) {
      if (pending.has(episodeId)) return;
      pending.add(episodeId);
      queue.push(episodeId);
      pump();
    },
  };
}
