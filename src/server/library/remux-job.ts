import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveWithinRoot } from '../stream/direct';

import { remuxCacheKey, type EpisodeRow, type Store } from './index-store';
import { probeFile } from './probe';
import type { ProbeResult } from './probe-types';
import { planRemux, REMUX_PLAN_VERSION, type RemuxPlan } from './remux-plan';

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
  /**
   * Episodios planejados que a rodada nao chegou a converter porque o orcamento
   * de disco acabou. Zero quando nao ha teto ou quando tudo coube.
   */
  budgetSkipped: number;
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
  /** Caminho do ffprobe usado no arquivo GERADO; mesmo motivo do ffmpegPath. */
  ffprobePath?: string;
  /** Teto por arquivo. Default: 30 min - um MKV grande num disco de rede demora. */
  timeoutMs?: number;
  /** Probe do ARQUIVO GERADO; injetavel para teste. */
  probe?: (filePath: string) => Promise<ProbeResult>;
  /** Conversor; injetavel para teste. */
  convert?: Convert;
  onProgress?: (progress: RemuxProgress) => void;
  now?: () => number;
  /**
   * Teto de disco das copias geradas, em bytes; `0` (ou ausente) = sem teto.
   *
   * A rodada de catalogo existe para pre-converter o acervo, e isso so faz
   * sentido enquanto o resultado CABE. Converter alem do orcamento nao adianta
   * nada: cada arquivo novo evictaria um anterior, o NAS passaria dias lendo e
   * escrevendo, e no fim o disco teria a mesma coisa que teria parando na hora.
   * Por isso a rodada para em vez de continuar - a fila sob demanda cobre
   * quem apertar play num episodio que ficou de fora.
   */
  cacheMaxBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 30 * 60_000;

/**
 * Nome do arquivo convertido. mtime e size do FONTE entram na chave: fonte
 * trocado gera outro nome, e o antigo vira orfao que a coleta remove - nunca
 * ha meia-troca servindo video novo com nome velho. A versao do plano tambem
 * entra: receita nova de ffmpeg invalida o nome antigo e forca a reconversao.
 */
export function remuxFileName(episodeId: string, mtimeMs: number, size: number): string {
  const key = `${episodeId} ${String(mtimeMs)} ${String(size)} plan:${String(REMUX_PLAN_VERSION)}`;
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

export interface RemuxEpisodeOptions {
  store: Store;
  libraryRoot: string;
  /** `<dataDir>/remux`, ja criado pelo chamador. */
  remuxDir: string;
  convert: Convert;
  probe: (filePath: string) => Promise<ProbeResult>;
  now: () => number;
}

/**
 * Converte UM episodio ja planejado: tmp + rename atomico, registro no indice
 * e limpeza do MP4 de versao antiga do plano. E o miolo compartilhado entre a
 * rodada de catalogo (runRemux) e a fila sob demanda (remux-queue).
 *
 * @returns 'skipped' quando a copia atual ja vale; 'converted' quando gerou.
 * @throws quando o ffmpeg/probe falham ou o caminho escapa da raiz.
 */
export async function remuxEpisode(
  options: RemuxEpisodeOptions,
  row: EpisodeRow,
  plan: RemuxPlan,
): Promise<'converted' | 'skipped'> {
  const { store, remuxDir } = options;
  const file = remuxFileName(row.id, row.mtimeMs, row.size);

  // mtime e size vem do INDICE, nao de um stat novo: o scan e a fonte da
  // verdade, e um arquivo trocado depois dele sera revisto no proximo scan.
  // O nome tambem tem que bater: linha com nome de outra versao do plano e
  // um MP4 gravado com a receita antiga - reconverte.
  const existing = store.getRemux(row.id, row.mtimeMs, row.size);
  if (existing !== null && existing.file === file) {
    try {
      await stat(join(remuxDir, existing.file));
      return 'skipped';
    } catch {
      // Linha sem arquivo (volume trocado, limpeza manual): reconverte.
    }
  }

  const inputPath = resolveWithinRoot(options.libraryRoot, row.id);
  if (inputPath === null) {
    throw new Error('caminho fora da raiz da biblioteca');
  }

  const targetPath = join(remuxDir, file);
  // Grava num temporario e renomeia: rename e atomico no mesmo filesystem,
  // entao o servidor nunca enxerga (nem serve) um MP4 pela metade.
  const tmpPath = `${targetPath}.${randomUUID()}.tmp`;

  try {
    await options.convert({ inputPath, args: plan.args, outputPath: tmpPath });
    // Probe do RESULTADO, nao previsao: e a lista que o painel de trilhas vai
    // usar para selecionar por posicao, entao ela tem que vir do arquivo real.
    const result = await options.probe(tmpPath);
    // Tamanho do GERADO, antes do rename: e o que o orcamento de disco conta.
    // Sem isto a linha nasceria com 0 bytes e o evictor so descobriria o custo
    // real dela na proxima varredura.
    const generated = await stat(tmpPath).then(
      (info) => info.size,
      () => 0,
    );
    await rename(tmpPath, targetPath);
    store.upsertRemux({
      episodeId: row.id,
      file,
      mtimeMs: row.mtimeMs,
      size: row.size,
      audioTracks: result.audioTracks,
      createdAt: options.now(),
    });
    store.setCacheFileBytes(remuxCacheKey(row.id), generated);
  } catch (error) {
    await unlink(tmpPath).catch(() => undefined);
    throw error;
  }

  // Apaga o MP4 da versao antiga ja, em vez de esperar a coleta do fim da
  // rodada: numa reconversao em massa (bump de versao do plano) os orfaos
  // acumulados dobrariam o espaco do diretorio ate a rodada acabar.
  if (existing !== null && existing.file !== file) {
    await unlink(join(remuxDir, existing.file)).catch(() => undefined);
  }
  return 'converted';
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
  const probe =
    options.probe ??
    ((filePath: string) => probeFile(filePath, { ffprobePath: options.ffprobePath ?? 'ffprobe' }));
  const convert =
    options.convert ??
    ffmpegConvert(options.ffmpegPath ?? 'ffmpeg', options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  const remuxDir = join(options.dataDir, 'remux');
  await mkdir(remuxDir, { recursive: true });

  const planned = collectPlanned(store);
  const failed: RemuxFailure[] = [];
  const cacheMaxBytes = options.cacheMaxBytes ?? 0;
  let converted = 0;
  let skipped = 0;
  let done = 0;
  let budgetSkipped = 0;

  // Ocupacao corrente, mantida em memoria durante a rodada. Reler o indice
  // inteiro a cada episodio custaria uma varredura das duas tabelas por
  // conversao; o unico escritor durante a rodada e ela propria, entao somar o
  // que ela gera basta.
  let cacheBytes = cacheMaxBytes > 0 ? store.totalCacheBytes() : 0;

  for (const { row, plan } of planned) {
    options.onProgress?.({ done, total: planned.length, episode: row.id });
    done += 1;

    // Orcamento estourado: o resto do catalogo fica para a fila sob demanda.
    // A conta e feita ANTES de converter, com o tamanho do fonte como
    // estimativa do gerado - o video sai copiado byte a byte, entao os dois
    // tamanhos ficam na mesma ordem de grandeza.
    if (cacheMaxBytes > 0 && cacheBytes + row.size > cacheMaxBytes) {
      budgetSkipped += 1;
      continue;
    }

    try {
      const outcome = await remuxEpisode(
        { store, libraryRoot, remuxDir, convert, probe, now },
        row,
        plan,
      );
      if (outcome === 'converted') {
        converted += 1;
        if (cacheMaxBytes > 0) cacheBytes += store.getCacheFileBytes(remuxCacheKey(row.id));
      } else skipped += 1;
    } catch (error) {
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
    budgetSkipped,
  };
}
