import { execFile, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import type { SubtitleTrackRef } from '../../src/shared/api-types';
import { registerSubtitleRoutes, type SubtitleSource } from '../../src/server/stream/subtitle';

const execFileAsync = promisify(execFile);

/** ffmpeg de verdade: extrair legenda so vale testado contra o binario. */
function hasBinary(name: string): boolean {
  const result = spawnSync(name, ['-version'], { stdio: 'ignore' });
  return result.error === undefined && result.status === 0;
}

const HAS_FFMPEG = hasBinary('ffmpeg');

/** Nome com espaco e parenteses, como no acervo real. */
const REL = 'Serie/ep 01 (piloto).mkv';

let base = '';
let libraryRoot = '';
let dataDir = '';
let app: FastifyInstance;
/** App com um "ffmpeg" que so dorme: e o caso do timeout. */
let travado: FastifyInstance;

function sub(over: Partial<SubtitleTrackRef> = {}): SubtitleTrackRef {
  return { index: 0, lang: 'por', title: null, codec: 'subrip', isDefault: true, forced: false, ...over };
}

const TRILHAS: SubtitleTrackRef[] = [
  sub({ index: 0, lang: 'por' }),
  sub({ index: 1, lang: 'eng', isDefault: false }),
];

const source: SubtitleSource = {
  getEpisode: (id) => {
    if (id === 'ok') return { relativePath: REL, subtitleTracks: TRILHAS };
    if (id === 'sem-legenda') return { relativePath: REL, subtitleTracks: [] };
    if (id === 'bitmap') {
      return { relativePath: REL, subtitleTracks: [sub({ codec: 'hdmv_pgs_subtitle' })] };
    }
    if (id === 'sumiu') {
      return { relativePath: 'Serie/nao-existe.mkv', subtitleTracks: [sub()] };
    }
    if (id === 'fuga') return { relativePath: '../segredo.mkv', subtitleTracks: [sub()] };
    return null;
  },
};

beforeAll(async () => {
  if (!HAS_FFMPEG) return;
  base = await mkdtemp(join(tmpdir(), 'retro-tv-subtitle-'));
  libraryRoot = join(base, 'acervo');
  dataDir = join(base, 'data');
  await mkdir(join(libraryRoot, 'Serie'), { recursive: true });
  await writeFile(join(base, 'segredo.mkv'), 'nao deveria sair daqui');

  const pt = join(base, 'pt.srt');
  const en = join(base, 'en.srt');
  await writeFile(pt, '1\n00:00:00,000 --> 00:00:01,000\nola mundo\n\n', 'utf8');
  await writeFile(en, '1\n00:00:00,000 --> 00:00:01,000\nhello world\n\n', 'utf8');

  // mkv com video, audio e duas legendas subrip: o formato do acervo novo.
  await execFileAsync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=red:s=160x120:r=25:d=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-i', pt, '-i', en,
    '-map', '0:v', '-map', '1:a', '-map', '2:s', '-map', '3:s',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-c:s', 'srt',
    '-metadata:s:s:0', 'language=por', '-metadata:s:s:1', 'language=eng',
    join(libraryRoot, REL),
  ]);

  app = Fastify();
  registerSubtitleRoutes(app, { source, libraryRoot, dataDir });
  await app.ready();

  // Stub que ignora os argumentos e dorme: garante o caminho do timeout sem
  // depender de arquivo grande nenhum.
  const dorminhoco = join(base, 'ffmpeg-dorminhoco.sh');
  await writeFile(dorminhoco, '#!/bin/sh\nsleep 30\n', { encoding: 'utf8', mode: 0o755 });

  travado = Fastify();
  registerSubtitleRoutes(travado, {
    source,
    libraryRoot,
    dataDir: join(base, 'data-travado'),
    ffmpegPath: dorminhoco,
    timeoutMs: 400,
  });
  await travado.ready();
}, 120_000);

afterAll(async () => {
  if (!HAS_FFMPEG) return;
  await app.close();
  await travado.close();
  await rm(base, { recursive: true, force: true });
});

describe.skipIf(!HAS_FFMPEG)('GET /api/stream/:id/subtitle/:track', () => {
  test('extrai a legenda embutida como WebVTT', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/stream/ok/subtitle/0' });

    expect(r.statusCode).toBe(200);
    expect(r.body.startsWith('WEBVTT')).toBe(true);
    expect(r.body).toContain('ola mundo');
    expect(r.headers['content-type']).toBe('text/vtt; charset=utf-8');
    expect(r.headers['cache-control']).toBe('private, max-age=3600');
  });

  test('o index e relativo entre legendas: 1 e a segunda faixa', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/stream/ok/subtitle/1' });

    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('hello world');
    expect(r.body).not.toContain('ola mundo');
  });

  test('track que nao e inteiro devolve 400', async () => {
    for (const track of ['abc', '-1', '1.5', '01x']) {
      const r = await app.inject({ method: 'GET', url: `/api/stream/ok/subtitle/${track}` });
      expect(r.statusCode).toBe(400);
    }
  });

  test('episodio desconhecido devolve 404', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/stream/inexistente/subtitle/0' });
    expect(r.statusCode).toBe(404);
  });

  test('track fora do range do indice devolve 404', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/stream/ok/subtitle/9' });
    expect(r.statusCode).toBe(404);
  });

  test('episodio sem legenda nenhuma devolve 404', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/stream/sem-legenda/subtitle/0' });
    expect(r.statusCode).toBe(404);
  });

  test('legenda em bitmap devolve 415, nao tenta converter', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/stream/bitmap/subtitle/0' });
    expect(r.statusCode).toBe(415);
  });

  test('arquivo sumido do disco devolve 404, nao 500', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/stream/sumiu/subtitle/0' });
    expect(r.statusCode).toBe(404);
  });

  test('caminho que escapa da raiz devolve 404 e nao le o arquivo de fora', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/stream/fuga/subtitle/0' });
    expect(r.statusCode).toBe(404);
    expect(r.body).not.toContain('nao deveria sair daqui');
  });

  test('ffmpeg ausente no PATH devolve 500 sem pendurar o request', async () => {
    const semFfmpeg = Fastify();
    registerSubtitleRoutes(semFfmpeg, {
      source,
      libraryRoot,
      dataDir: join(base, 'data-sem-ffmpeg'),
      ffmpegPath: join(base, 'nao-tem-esse-binario'),
    });
    await semFfmpeg.ready();

    const r = await semFfmpeg.inject({ method: 'GET', url: '/api/stream/ok/subtitle/0' });

    expect(r.statusCode).toBe(500);
    await semFfmpeg.close();
  }, 10_000);

  test('ffmpeg travado e morto no timeout e a resposta e 500', async () => {
    const comecou = Date.now();
    const r = await travado.inject({ method: 'GET', url: '/api/stream/ok/subtitle/0' });

    expect(r.statusCode).toBe(500);
    expect(Date.now() - comecou).toBeLessThan(10_000);
  }, 20_000);
});

describe.skipIf(!HAS_FFMPEG)('cache em disco', () => {
  test('a segunda chamada sai do cache, sem rodar o ffmpeg de novo', async () => {
    const primeira = await app.inject({ method: 'GET', url: '/api/stream/ok/subtitle/0' });
    expect(primeira.statusCode).toBe(200);

    const subs = join(dataDir, 'subs');
    const arquivos = (await readdir(subs)).filter((name) => name.endsWith('.vtt'));
    expect(arquivos.length).toBeGreaterThan(0);

    // Acha o cache DESTA faixa pelo conteudo (o diretorio tem uma entrada por
    // faixa ja pedida).
    let alvo = '';
    for (const name of arquivos) {
      const conteudo = await readFile(join(subs, name), 'utf8');
      if (conteudo.includes('ola mundo')) alvo = join(subs, name);
    }
    expect(alvo).not.toBe('');

    // Marca o arquivo do cache: se a resposta trouxer a marca, ela veio do
    // disco - o ffmpeg jamais produziria este texto a partir do mkv.
    await writeFile(alvo, 'WEBVTT\n\n00:00.000 --> 00:01.000\nveio do cache\n', 'utf8');

    const segunda = await app.inject({ method: 'GET', url: '/api/stream/ok/subtitle/0' });
    expect(segunda.statusCode).toBe(200);
    expect(segunda.body).toContain('veio do cache');
  });
});
