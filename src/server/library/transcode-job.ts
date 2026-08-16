import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';

import { resolveWithinRoot } from '../stream/direct';

import type { EpisodeRow, Store } from './index-store';
import { probeFile } from './probe';
import type { ProbeResult } from './probe-types';
import { ffmpegConvert, type Convert } from './remux-job';
import { isLegacyVideo, planTranscode, transcodeOutputPath } from './transcode-plan';

/**
 * Execucao da reconversao de arquivos legados (ver `transcode-plan.ts`).
 *
 * O unico processo do projeto que ESCREVE na biblioteca. Todas as decisoes de
 * desenho aqui vem disso:
 *
 * - o padrao e `dryRun`: rodar sem pensar nao converte nada;
 * - a saida vai para um `.tmp` e so depois vira `.h264.mp4`, para uma
 *   interrupcao no meio nao deixar arquivo pela metade parecendo pronto;
 * - o original NUNCA sai antes de o resultado ser verificado, e so quando a
 *   pessoa pediu `replace`;
 * - com `keepOriginalsDir`, "remover" e MOVER: o lote inteiro fica reversivel.
 *
 * Nenhum gatilho automatico chama isto. Nao ha import deste modulo no servidor,
 * no scan nem no controlador - so na CLI.
 */

const execFileAsync = promisify(execFile);

/** Tolerancia entre a duracao do fonte e a do convertido. */
const DURATION_TOLERANCE_MS = 1_000;

/** Quanto decodificar nas pontas para provar que o arquivo abre e fecha. */
const DECODE_PROBE_SECONDS = 2;

export type TranscodeStatus =
  | 'candidate'
  | 'converted'
  | 'replaced'
  | 'skipped-exists'
  /** Convertido e conferido, mas o original nao pode ser retirado. Nada perdido. */
  | 'kept-original'
  | 'failed';

export interface TranscodeItem {
  episodeId: string;
  status: TranscodeStatus;
  sourceBytes: number;
  /** null enquanto nao houver arquivo gerado (dry-run, falha). */
  outputBytes: number | null;
  /** Preenchido em `failed` e em `skipped-exists`. */
  reason?: string;
}

export interface TranscodeReport {
  candidates: number;
  converted: number;
  replaced: number;
  failed: number;
  skipped: number;
  /** Soma dos fontes considerados. */
  sourceBytes: number;
  /** Soma do que foi gerado. */
  outputBytes: number;
  durationMs: number;
  items: TranscodeItem[];
}

export interface TranscodeProgress {
  done: number;
  total: number;
  episode: string;
}

/** Resultado da conferencia do arquivo gerado. */
export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

export interface TranscodeJobOptions {
  store: Store;
  libraryRoot: string;
  /** Padrao do modo: lista e mede, nao converte. */
  dryRun: boolean;
  /** Remove (ou move) o original DEPOIS de o convertido passar na conferencia. */
  replace: boolean;
  /** Destino dos originais em vez do lixo; null apaga de vez. */
  keepOriginalsDir: string | null;
  /** Teto de episodios nesta rodada; util para provar o lote numa temporada. */
  limit?: number | undefined;
  /** Converte so o que estiver sob este caminho relativo (prefixo). */
  only?: string | undefined;
  ffmpegPath?: string;
  ffprobePath?: string;
  timeoutMs?: number;
  onProgress?: (progress: TranscodeProgress) => void;
  /** Injetaveis para teste. */
  convert?: Convert;
  probe?: (filePath: string) => Promise<ProbeResult>;
  verify?: (filePath: string, expectedDurationMs: number) => Promise<VerifyResult>;
  now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 60 * 60_000;

/** Episodios que o plano considera legados, na ordem do catalogo. */
export function collectLegacy(store: Store, only?: string): EpisodeRow[] {
  const found: EpisodeRow[] = [];
  for (const show of store.listShows()) {
    for (const row of store.listEpisodes(show.id)) {
      if (!isLegacyVideo(row.videoCodec)) continue;
      if (only !== undefined && only !== '' && !row.id.startsWith(only)) continue;
      found.push(row);
    }
  }
  return found;
}

/**
 * Conferencia do arquivo gerado, em tres perguntas.
 *
 * A terceira e a que importa: um ffmpeg interrompido produz um MP4 cuja
 * duracao DECLARADA esta certa e cujos ultimos minutos nao existem. Sem
 * decodificar as pontas de verdade, `--replace` apagaria o original confiando
 * num cabecalho.
 */
export function makeVerifier(ffmpegPath: string, ffprobePath: string) {
  return async function verify(filePath: string, expectedDurationMs: number): Promise<VerifyResult> {
    let probed: ProbeResult;
    try {
      probed = await probeFile(filePath, { ffprobePath });
    } catch (error) {
      return { ok: false, reason: `probe falhou: ${detail(error)}` };
    }

    if (probed.videoCodec !== 'h264') {
      return { ok: false, reason: `video saiu como ${probed.videoCodec ?? 'nada'}, esperava h264` };
    }

    const drift = Math.abs(probed.durationMs - expectedDurationMs);
    if (drift > DURATION_TOLERANCE_MS) {
      return {
        ok: false,
        reason: `duracao divergiu ${String(Math.round(drift / 1000))}s do original`,
      };
    }

    // Comeco e fim decodificados de verdade. O `-f null` joga fora a saida: o
    // que interessa e o ffmpeg conseguir chegar ate la sem erro.
    const nearEnd = Math.max(0, probed.durationMs / 1000 - DECODE_PROBE_SECONDS - 1);
    for (const [label, offset] of [
      ['inicio', 0],
      ['fim', nearEnd],
    ] as const) {
      try {
        const { stderr } = await execFileAsync(
          ffmpegPath,
          [
            '-nostdin', '-v', 'error',
            '-ss', String(offset),
            '-i', filePath,
            '-t', String(DECODE_PROBE_SECONDS),
            '-f', 'null', '-',
          ],
          { timeout: 120_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 },
        );
        if (stderr.trim() !== '') {
          return { ok: false, reason: `${label} nao decodifica: ${stderr.trim().slice(0, 160)}` };
        }
      } catch (error) {
        return { ok: false, reason: `${label} nao decodifica: ${detail(error)}` };
      }
    }

    return { ok: true };
  };
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Tira o original de circulacao.
 *
 * Com `keepOriginalsDir`, MOVE preservando o caminho relativo - o lote inteiro
 * volta com um `mv` se a pessoa nao gostar do resultado daqui a uma semana.
 * Sem ele, apaga.
 */
async function retireOriginal(
  sourcePath: string,
  libraryRoot: string,
  keepOriginalsDir: string | null,
): Promise<void> {
  if (keepOriginalsDir === null) {
    await unlink(sourcePath);
    return;
  }
  const target = join(keepOriginalsDir, relative(libraryRoot, sourcePath));
  await mkdir(dirname(target), { recursive: true });
  // `rename` falha entre filesystems diferentes (EXDEV). Nao ha fallback de
  // copia de proposito: copiar 200 MB por episodio para "guardar o original"
  // encheria o disco que este comando existe para aliviar. O erro sobe e quem
  // chama registra `kept-original` - os dois arquivos ficam, nada se perde.
  await rename(sourcePath, target);
}

export async function runTranscodeLegacy(
  options: TranscodeJobOptions,
): Promise<TranscodeReport> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const { store, libraryRoot } = options;
  const ffmpegPath = options.ffmpegPath ?? 'ffmpeg';
  const ffprobePath = options.ffprobePath ?? 'ffprobe';
  const convert =
    options.convert ?? ffmpegConvert(ffmpegPath, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const verify = options.verify ?? makeVerifier(ffmpegPath, ffprobePath);

  const all = collectLegacy(store, options.only);
  const candidates =
    options.limit === undefined || options.limit <= 0 ? all : all.slice(0, options.limit);

  const items: TranscodeItem[] = [];
  let converted = 0;
  let replaced = 0;
  let failed = 0;
  let skipped = 0;
  let sourceBytes = 0;
  let outputBytes = 0;
  let done = 0;

  for (const row of candidates) {
    options.onProgress?.({ done, total: candidates.length, episode: row.id });
    done += 1;
    sourceBytes += row.size;

    const plan = planTranscode({
      relativePath: row.id,
      videoCodec: row.videoCodec,
      audioTracks: row.audioTracks,
    });
    // `collectLegacy` ja filtrou por `isLegacyVideo`, entao null aqui so
    // aconteceria com as duas regras fora de sincronia.
    if (plan === null) continue;

    if (options.dryRun) {
      items.push({ episodeId: row.id, status: 'candidate', sourceBytes: row.size, outputBytes: null });
      continue;
    }

    const inputPath = resolveWithinRoot(libraryRoot, row.id);
    if (inputPath === null) {
      failed += 1;
      items.push({
        episodeId: row.id,
        status: 'failed',
        sourceBytes: row.size,
        outputBytes: null,
        reason: 'caminho fora da raiz da biblioteca',
      });
      continue;
    }

    const outputPath = transcodeOutputPath(inputPath);

    // Rodar de novo depois de um Ctrl-C nao pode refazer o que ja ficou pronto:
    // sao minutos por arquivo e horas por lote.
    try {
      await stat(outputPath);
      skipped += 1;
      items.push({
        episodeId: row.id,
        status: 'skipped-exists',
        sourceBytes: row.size,
        outputBytes: null,
        reason: 'ja convertido',
      });
      continue;
    } catch {
      // Nao existe: converte.
    }

    const tmpPath = `${outputPath}.${randomUUID()}.tmp`;
    try {
      await convert({ inputPath, args: plan.args, outputPath: tmpPath });

      const check = await verify(tmpPath, row.durationMs);
      if (!check.ok) {
        await unlink(tmpPath).catch(() => undefined);
        failed += 1;
        items.push({
          episodeId: row.id,
          status: 'failed',
          sourceBytes: row.size,
          outputBytes: null,
          reason: check.reason ?? 'conferencia falhou',
        });
        continue;
      }

      const generated = await stat(tmpPath).then(
        (info) => info.size,
        () => 0,
      );
      await rename(tmpPath, outputPath);
      outputBytes += generated;
      converted += 1;

      if (!options.replace) {
        items.push({
          episodeId: row.id,
          status: 'converted',
          sourceBytes: row.size,
          outputBytes: generated,
        });
        continue;
      }

      // A retirada do original tem `try` PROPRIO. Ela acontece depois de o
      // convertido ja estar em disco e conferido, entao uma falha aqui (EXDEV
      // num `--keep-originals` para outro filesystem, permissao de escrita no
      // diretorio) nao desfaz a conversao - e cair no catch de fora contaria o
      // mesmo episodio como convertido E como falho.
      //
      // O estado que sobra e o mais seguro que existe: os dois arquivos no
      // disco, nada perdido, e uma linha dizendo o que fazer.
      try {
        await retireOriginal(inputPath, libraryRoot, options.keepOriginalsDir);
        replaced += 1;
        items.push({
          episodeId: row.id,
          status: 'replaced',
          sourceBytes: row.size,
          outputBytes: generated,
        });
      } catch (error) {
        failed += 1;
        items.push({
          episodeId: row.id,
          status: 'kept-original',
          sourceBytes: row.size,
          outputBytes: generated,
          reason: `convertido, mas o original nao pode ser retirado: ${detail(error)}`,
        });
      }
    } catch (error) {
      await unlink(tmpPath).catch(() => undefined);
      failed += 1;
      items.push({
        episodeId: row.id,
        status: 'failed',
        sourceBytes: row.size,
        outputBytes: null,
        reason: detail(error),
      });
    }
  }

  options.onProgress?.({ done, total: candidates.length, episode: '' });

  return {
    candidates: candidates.length,
    converted,
    replaced,
    failed,
    skipped,
    sourceBytes,
    outputBytes,
    durationMs: now() - startedAt,
    items,
  };
}
