/**
 * Unica porta de entrada para o binario `ffprobe` no projeto.
 */
import { execFile } from 'node:child_process';
import { open } from 'node:fs/promises';
import { promisify } from 'node:util';

import type { AudioTrackRef, SubtitleTrackRef } from '@shared/api-types';

import type { ProbeResult } from './probe-types.js';

export type { ProbeResult } from './probe-types.js';

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 30_000;

/** Arquivo com muitos streams e capitulos rende JSON grande; 1 MB do node nao basta. */
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;

export class ProbeError extends Error {
  readonly filePath: string;

  constructor(filePath: string, cause: string) {
    super(`ffprobe falhou em ${filePath}: ${cause}`);
    this.name = 'ProbeError';
    this.filePath = filePath;
  }
}

export interface ProbeOptions {
  /** Caminho do binario. Default: 'ffprobe' no PATH. */
  ffprobePath?: string;
  /** Timeout por arquivo em ms. Default: 30000. */
  timeoutMs?: number;
}

export async function probeFile(filePath: string, options?: ProbeOptions): Promise<ProbeResult> {
  const ffprobePath = options?.ffprobePath ?? 'ffprobe';
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let stdout: string;
  try {
    // Array de argumentos, nunca string de shell: os nomes tem espaco, acento,
    // aspas e parenteses.
    // `-show_streams` ja traz `tags` e `disposition` de todo stream, que e de
    // onde saem lingua, titulo, default e forced das trilhas. Nao ha
    // `-show_entries` a acrescentar: ele so RESTRINGIRIA o que ja vem.
    ({ stdout } = await execFileAsync(ffprobePath, [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath,
    ], { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: MAX_STDOUT_BYTES }));
  } catch (caught) {
    throw new ProbeError(filePath, describeFailure(caught, timeoutMs));
  }

  let parsed: FfprobeOutput;
  try {
    parsed = JSON.parse(stdout) as FfprobeOutput;
  } catch (caught) {
    const detail = caught instanceof Error ? caught.message : String(caught);
    throw new ProbeError(filePath, `json invalido na saida do ffprobe: ${detail}`);
  }

  const streams = parsed.streams ?? [];
  // Capa embutida entra como stream de video; nao e o video do episodio.
  const video = streams.find(
    (stream) => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1,
  );
  const audio = streams.find((stream) => stream.codec_type === 'audio');

  // O format manda; sem ele, cai para o stream de video.
  const durationMs = parseDurationMs(parsed.format?.duration) ?? parseDurationMs(video?.duration);
  if (durationMs === null) {
    throw new ProbeError(filePath, 'sem duracao no format e no stream de video');
  }
  if (durationMs <= 0) {
    // Episodio de duracao zero trava a grade num loop infinito.
    throw new ProbeError(filePath, `duracao invalida: ${String(durationMs)} ms`);
  }

  let faststart: boolean;
  try {
    faststart = await detectFaststart(filePath);
  } catch (caught) {
    const detail = caught instanceof Error ? caught.message : String(caught);
    throw new ProbeError(filePath, `falha ao ler os atomos do arquivo: ${detail}`);
  }

  return {
    durationMs,
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    width: typeof video?.width === 'number' ? video.width : null,
    height: typeof video?.height === 'number' ? video.height : null,
    faststart,
    audioTracks: collectAudioTracks(streams),
    subtitleTracks: collectSubtitleTracks(streams),
  };
}

/** Streams do tipo pedido, na ordem do container, sem capa embutida. */
function streamsOfType(streams: readonly FfprobeStream[], type: string): FfprobeStream[] {
  return streams.filter(
    (stream) => stream.codec_type === type && stream.disposition?.attached_pic !== 1,
  );
}

/** Tag de texto do container: string vazia vale como ausencia. */
function tag(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function collectAudioTracks(streams: readonly FfprobeStream[]): AudioTrackRef[] {
  return streamsOfType(streams, 'audio').map((stream, index) => ({
    index,
    lang: tag(stream.tags?.language),
    // MP4 guarda o titulo do stream na tag `name` (e o que o proprio mux do
    // ffmpeg escreve); MKV usa `title`. Sem o fallback, todo MP4 - inclusive
    // os remuxados por nos - perderia o rotulo da faixa no painel.
    title: tag(stream.tags?.title) ?? tag(stream.tags?.name),
    codec: stream.codec_name ?? null,
    isDefault: stream.disposition?.default === 1,
  }));
}

function collectSubtitleTracks(streams: readonly FfprobeStream[]): SubtitleTrackRef[] {
  // `index` e a posicao entre as legendas, nao no container: e exatamente o N
  // que o `-map 0:s:N` do ffmpeg entende na hora de extrair.
  return streamsOfType(streams, 'subtitle').map((stream, index) => ({
    index,
    lang: tag(stream.tags?.language),
    // Mesmo fallback do audio: em MP4 o titulo vem na tag `name`.
    title: tag(stream.tags?.title) ?? tag(stream.tags?.name),
    codec: stream.codec_name ?? null,
    isDefault: stream.disposition?.default === 1,
    forced: stream.disposition?.forced === 1,
  }));
}

/** Segundos em texto -> ms inteiros. `null` quando o campo nao existe ou nao e numero. */
function parseDurationMs(seconds: string | undefined): number | null {
  if (typeof seconds !== 'string' || seconds.trim() === '') return null;
  const value = Number(seconds);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 1000);
}

/** Resume a falha do processo numa linha curta, com o stderr quando existir. */
function describeFailure(caught: unknown, timeoutMs: number): string {
  const error = caught as NodeJS.ErrnoException & {
    stderr?: string;
    code?: number | string;
    killed?: boolean;
  };
  if (error.killed === true) return `timeout apos ${String(timeoutMs)} ms`;
  const stderr = typeof error.stderr === 'string' ? error.stderr.trim() : '';
  const detail = stderr !== '' ? stderr : (error.message ?? String(caught));
  const summary = detail.replace(/\s+/g, ' ').slice(0, 300);
  return `exit ${String(error.code ?? 'desconhecido')}: ${summary}`;
}

/** Tipos aceitos como primeira caixa de um arquivo MP4/MOV. */
const MP4_FIRST_BOXES = new Set([
  'ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'pnot', 'junk', 'uuid', 'pict',
]);

const BOX_TYPE_RE = /^[\x20-\x7e]{4}$/;

/**
 * Percorre as caixas de topo do arquivo comparando a posicao de `moov` e
 * `mdat`. So le 16 bytes por caixa, nunca o arquivo inteiro. Container que nao
 * for MP4/MOV devolve true, porque o conceito nao se aplica.
 */
async function detectFaststart(filePath: string): Promise<boolean> {
  const handle = await open(filePath, 'r');
  try {
    const stats = await handle.stat();
    const header = Buffer.alloc(16);
    let offset = 0;
    let isFirstBox = true;

    while (offset + 8 <= stats.size) {
      const { bytesRead } = await handle.read(header, 0, 16, offset);
      if (bytesRead < 8) return true;

      const type = header.toString('latin1', 4, 8);
      if (!BOX_TYPE_RE.test(type)) return true;
      if (isFirstBox) {
        if (!MP4_FIRST_BOXES.has(type)) return true;
        isFirstBox = false;
      }

      if (type === 'moov') return true;
      if (type === 'mdat') return false;

      let boxSize = header.readUInt32BE(0);
      if (boxSize === 1) {
        if (bytesRead < 16) return true;
        boxSize = Number(header.readBigUInt64BE(8));
      } else if (boxSize === 0) {
        // Caixa que vai ate o fim do arquivo: nao ha mais nada depois dela.
        return true;
      }
      if (boxSize < 8 || !Number.isFinite(boxSize)) return true;

      offset += boxSize;
    }

    return true;
  } finally {
    await handle.close();
  }
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
  disposition?: { attached_pic?: number; default?: number; forced?: number };
  tags?: { language?: string; title?: string; name?: string };
}

interface FfprobeOutput {
  format?: { duration?: string };
  streams?: FfprobeStream[];
}
