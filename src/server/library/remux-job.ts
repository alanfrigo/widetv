import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveWithinRoot } from '../stream/direct';

import type { EpisodeRow, Store } from './index-store';
import { probeFile } from './probe';
import type { ProbeResult } from './probe-types';
import { planRemux, type RemuxPlan } from './remux-plan';

/**
 * Orquestracao do remux: converte para MP4 os episodios que o navegador nao
 * toca direto do disco (ver remux-plan.ts) e registra o resultado no indice.
 *
 * Roda DEPOIS do scan, um arquivo por vez: remux e copia de bytes, o custo e
 * disco e nao CPU, e dois ffmpeg lendo o mesmo NAS ao mesmo tempo so brigam
 * pelo mesmo prato. Rodar de novo e barato - o que ja foi convertido e pulado
 * pelo par (mtime, size) do fonte, igual ao cache de probe.
 */

export interface RemuxFailure {
  path: string;
  reason: string;
}

export interface RemuxReport {
  /** Episodios que precisam de remux segundo o plano. */
  planned: number;
  /** Convertidos nesta rodada. */
  converted: number;
  /** Ja convertidos em rodada anterior e ainda validos. */
  skipped: number;
  /** Arquivos orfaos removidos de `<DATA_DIR>/remux`. */
  removedFiles: number;
  failed: RemuxFailure[];
  durationMs: number;
}

export interface RemuxProgress {
  done: number;
  total: number;
  episode: string;
}

/** Assinatura do conversor, injetavel para testar o job sem ffmpeg. */
export type Convert = (options: {
  inputPath: string;
  args: string[];
  outputPath: string;
}) => Promise<void>;

export interface RemuxJobOptions {
  store: Store;
  libraryRoot: string;
  /** DATA_DIR do servidor; as copias vivem em `<dataDir>/remux`. */
  dataDir: string;
  ffmpegPath?: string;
  /** Teto por arquivo. Default: 30 min - um MKV grande num disco de rede demora. */
  timeoutMs?: number;
  /** Probe do ARQUIVO GERADO; injetavel para teste. */
  probe?: (filePath: string) => Promise<ProbeResult>;
  /** Conversor; injetavel para teste. */
  convert?: Convert;
  onProgress?: (progress: RemuxProgress) => void;
  now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 30 * 60_000;

/**
 * Nome do arquivo convertido. mtime e size do FONTE entram na chave: fonte
 * trocado gera outro nome, e o antigo vira orfao que a coleta remove - nunca
 * ha meia-troca servindo video novo com nome velho.
 */
export function remuxFileName(episodeId: string, mtimeMs: number, size: number): string {
  const key = `${episodeId} ${String(mtimeMs)} ${String(size)}`;
  return `${createHash('sha1').update(key).digest('hex')}.mp4`;
}

/**
 * Roda o ffmpeg gravando direto no destino. Mesma disciplina do extrator de
 * legenda: SIGKILL no timeout, 'exit' e nao 'close', stderr curto na mensagem.
 * Exportado porque a fila de variantes de dublagem usa o mesmo conversor.
 */
export function ffmpegConvert(ffmpegPath: string, timeoutMs: number): Convert {
  return async ({ inputPath, args, outputPath }) => {
    const child = spawn(
      ffmpegPath,
      ['-nostdin', '-v', 'error', '-y', '-i', inputPath, ...args, '-f', 'mp4', outputPath],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 2_000) stderr += chunk;
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      child.stderr.destroy();
    }, timeoutMs);

    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', (error) => {
          child.stderr.destroy();
          reject(error);
        });
        child.once('exit', (code, signal) => {
          if (timedOut) {
            reject(new Error(`ffmpeg passou de ${String(timeoutMs)} ms e foi morto`));
          } else if (code === 0) {
            resolve();
          } else {
            reject(
              new Error(
                `ffmpeg saiu com ${String(code ?? signal)}: ${stderr.replace(/\s+/g, ' ').trim().slice(0, 300)}`,
              ),
            );
          }
        });
      });
    } finally {
      clearTimeout(timer);
    }
  };
}

interface PlannedEpisode {
  row: EpisodeRow;
  plan: RemuxPlan;
}

/** Episodios que o plano manda converter, na ordem da grade. */
function collectPlanned(store: Store): PlannedEpisode[] {
  const planned: PlannedEpisode[] = [];
  for (const show of store.listShows()) {
    for (const row of store.listEpisodes(show.id)) {
      const plan = planRemux({
        relativePath: row.id,
        videoCodec: row.videoCodec,
        audioTracks: row.audioTracks,
      });
      if (plan !== null) planned.push({ row, plan });
    }
  }
  return planned;
}

export async function runRemux(options: RemuxJobOptions): Promise<RemuxReport> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const { store, libraryRoot } = options;
  const probe = options.probe ?? probeFile;
  const convert =
    options.convert ??
    ffmpegConvert(options.ffmpegPath ?? 'ffmpeg', options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  const remuxDir = join(options.dataDir, 'remux');
  await mkdir(remuxDir, { recursive: true });

  const planned = collectPlanned(store);
  const failed: RemuxFailure[] = [];
  let converted = 0;
  let skipped = 0;
  let done = 0;

  for (const { row, plan } of planned) {
    options.onProgress?.({ done, total: planned.length, episode: row.id });
    done += 1;

    // mtime e size vem do INDICE, nao de um stat novo: o scan e a fonte da
    // verdade, e um arquivo trocado depois dele sera revisto no proximo scan.
    const existing = store.getRemux(row.id, row.mtimeMs, row.size);
    if (existing !== null) {
      try {
        await stat(join(remuxDir, existing.file));
        skipped += 1;
        continue;
      } catch {
        // Linha sem arquivo (volume trocado, limpeza manual): reconverte.
      }
    }

    const inputPath = resolveWithinRoot(libraryRoot, row.id);
    if (inputPath === null) {
      failed.push({ path: row.id, reason: 'caminho fora da raiz da biblioteca' });
      continue;
    }

    const file = remuxFileName(row.id, row.mtimeMs, row.size);
    const targetPath = join(remuxDir, file);
    // Grava num temporario e renomeia: rename e atomico no mesmo filesystem,
    // entao o servidor nunca enxerga (nem serve) um MP4 pela metade.
    const tmpPath = `${targetPath}.${randomUUID()}.tmp`;

    try {
      await convert({ inputPath, args: plan.args, outputPath: tmpPath });
      // Probe do RESULTADO, nao previsao: e a lista que o painel de trilhas vai
      // usar para selecionar por posicao, entao ela tem que vir do arquivo real.
      const result = await probe(tmpPath);
      await rename(tmpPath, targetPath);
      store.upsertRemux({
        episodeId: row.id,
        file,
        mtimeMs: row.mtimeMs,
        size: row.size,
        audioTracks: result.audioTracks,
        createdAt: now(),
      });
      converted += 1;
    } catch (error) {
      await unlink(tmpPath).catch(() => undefined);
      failed.push({
        path: row.id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  options.onProgress?.({ done, total: planned.length, episode: '' });

  // Coleta de orfaos: fonte que mudou gera nome novo, e o MP4 antigo ficaria
  // ocupando o dobro do espaco para sempre. Inclui .tmp de execucao interrompida.
  // As variantes de dublagem moram no mesmo diretorio e entram na mesma lista.
  let removedFiles = 0;
  const keep = new Set([...store.listRemuxFiles(), ...store.listAudioVariantFiles()]);
  for (const entry of await readdir(remuxDir)) {
    if (keep.has(entry)) continue;
    try {
      await unlink(join(remuxDir, entry));
      removedFiles += 1;
    } catch {
      // Sumiu no meio do caminho: o objetivo (nao existir) foi atingido.
    }
  }

  return {
    planned: planned.length,
    converted,
    skipped,
    removedFiles,
    failed,
    durationMs: now() - startedAt,
  };
}
