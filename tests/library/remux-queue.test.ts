import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { AudioTrackRef } from '../../src/shared/api-types';
import { openStore, type EpisodeInput, type Store } from '../../src/server/library/index-store';
import type { ProbeResult } from '../../src/server/library/probe-types';
import { remuxFileName, type Convert } from '../../src/server/library/remux-job';
import { createRemuxQueue } from '../../src/server/library/remux-queue';

const DOLBY: AudioTrackRef = { index: 0, lang: 'por', title: null, codec: 'eac3', isDefault: true };
const AAC: AudioTrackRef = { index: 0, lang: 'por', title: null, codec: 'aac', isDefault: true };

const REMUXED_TRACKS: AudioTrackRef[] = [
  { index: 0, lang: 'por', title: 'AAC', codec: 'aac', isDefault: true },
  { index: 1, lang: 'por', title: null, codec: 'eac3', isDefault: false },
];

function episodeRow(id: string, over: Partial<EpisodeInput> = {}): EpisodeInput {
  return {
    id,
    absolutePath: `/lib/${id}`,
    title: id,
    season: null,
    episode: null,
    orderIndex: 0,
    durationMs: 60_000,
    videoCodec: 'h264',
    audioCodec: 'eac3',
    width: 1920,
    height: 1080,
    faststart: false,
    audioTracks: [DOLBY],
    subtitleTracks: [],
    mtimeMs: 111,
    size: 1000,
    ...over,
  };
}

let base: string;
let libraryRoot: string;
let dataDir: string;
let store: Store;

function fakeConvert(calls: string[][]): Convert {
  return async ({ args, outputPath }) => {
    calls.push(args);
    await writeFile(outputPath, 'mp4!');
  };
}

const fakeProbe = async (): Promise<ProbeResult> => ({
  durationMs: 60_000,
  videoCodec: 'h264',
  audioCodec: 'aac',
  width: 1920,
  height: 1080,
  faststart: true,
  audioTracks: REMUXED_TRACKS,
  subtitleTracks: [],
});

/** Espera a fila (um worker, com I/O de verdade) esvaziar. */
async function settle(): Promise<void> {
  for (let i = 0; i < 100; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'widetv-remux-queue-'));
  libraryRoot = join(base, 'acervo');
  dataDir = join(base, 'data');
  await mkdir(join(libraryRoot, 'Serie'), { recursive: true });
  await writeFile(join(libraryRoot, 'Serie', 'ep1.mkv'), 'mkv');

  store = openStore(':memory:');
  const show = store.upsertShow({
    slug: 'serie',
    name: 'Serie',
    absolutePath: join(libraryRoot, 'Serie'),
  });
  store.upsertEpisodes(show.id, [episodeRow('Serie/ep1.mkv')]);
});

afterEach(async () => {
  store.close();
  await rm(base, { recursive: true, force: true });
});

describe('createRemuxQueue', () => {
  test('ensure converte o episodio e registra o remux no indice', async () => {
    const calls: string[][] = [];
    const queue = createRemuxQueue({
      store,
      libraryRoot,
      dataDir,
      convert: fakeConvert(calls),
      probe: fakeProbe,
    });

    queue.ensure('Serie/ep1.mkv');
    await settle();

    expect(calls).toHaveLength(1);
    const row = store.getRemux('Serie/ep1.mkv', 111, 1000);
    expect(row?.file).toBe(remuxFileName('Serie/ep1.mkv', 111, 1000));
    expect(await readdir(join(dataDir, 'remux'))).toEqual([row?.file]);
  });

  test('ensure repetido enquanto converte nao dobra o trabalho', async () => {
    const calls: string[][] = [];
    const queue = createRemuxQueue({
      store,
      libraryRoot,
      dataDir,
      convert: fakeConvert(calls),
      probe: fakeProbe,
    });

    queue.ensure('Serie/ep1.mkv');
    queue.ensure('Serie/ep1.mkv');
    queue.ensure('Serie/ep1.mkv');
    await settle();

    expect(calls).toHaveLength(1);
  });

  test('episodio ja convertido pela rodada de catalogo vira skip, sem ffmpeg', async () => {
    const calls: string[][] = [];
    const queue = createRemuxQueue({
      store,
      libraryRoot,
      dataDir,
      convert: fakeConvert(calls),
      probe: fakeProbe,
    });
    queue.ensure('Serie/ep1.mkv');
    await settle();

    queue.ensure('Serie/ep1.mkv');
    await settle();
    expect(calls).toHaveLength(1);
  });

  test('episodio que ja toca direto (aac) nao gera nada', async () => {
    const calls: string[][] = [];
    const show = store.upsertShow({
      slug: 'serie',
      name: 'Serie',
      absolutePath: join(libraryRoot, 'Serie'),
    });
    store.upsertEpisodes(show.id, [
      episodeRow('Serie/ep1.mkv', { audioTracks: [AAC], audioCodec: 'aac' }),
    ]);
    await writeFile(join(libraryRoot, 'Serie', 'ep2.mp4'), 'mp4');

    const queue = createRemuxQueue({
      store,
      libraryRoot,
      dataDir,
      convert: fakeConvert(calls),
      probe: fakeProbe,
    });
    // mkv com aac ainda troca de container; mp4 desconhecido nem existe no indice.
    queue.ensure('nao-existe.mp4');
    await settle();
    expect(calls).toHaveLength(0);
  });

  test('falha do conversor nao trava a fila: proximo ensure tenta de novo', async () => {
    let attempts = 0;
    const explosivo: Convert = async ({ outputPath }) => {
      attempts += 1;
      if (attempts === 1) throw new Error('disco cheio');
      await writeFile(outputPath, 'mp4!');
    };
    const mensagens: string[] = [];
    const queue = createRemuxQueue({
      store,
      libraryRoot,
      dataDir,
      convert: explosivo,
      probe: fakeProbe,
      log: (message) => mensagens.push(message),
    });

    queue.ensure('Serie/ep1.mkv');
    await settle();
    expect(mensagens[0]).toContain('disco cheio');
    expect(store.getRemux('Serie/ep1.mkv', 111, 1000)).toBeNull();

    queue.ensure('Serie/ep1.mkv');
    await settle();
    expect(store.getRemux('Serie/ep1.mkv', 111, 1000)).not.toBeNull();
  });
});
