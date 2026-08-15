import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { AudioTrackRef } from '../../src/shared/api-types';
import { openStore, type EpisodeRow, type Store } from '../../src/server/library/index-store';
import type { Convert } from '../../src/server/library/remux-job';
import { createVariantQueue, variantFileName } from '../../src/server/library/variant-queue';

const DUAL: AudioTrackRef[] = [
  { index: 0, lang: 'por', title: 'Brazilian', codec: 'eac3', isDefault: true },
  { index: 1, lang: 'eng', title: null, codec: 'eac3', isDefault: false },
];

function episodeRow(id: string): Omit<EpisodeRow, 'showId'> {
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
    audioTracks: DUAL.map((t) => ({ ...t })),
    subtitleTracks: [],
    mtimeMs: 111,
    size: 1000,
  };
}

let base: string;
let libraryRoot: string;
let dataDir: string;
let store: Store;

/** Conversor de mentira, com trava opcional para observar o estado "no meio". */
function fakeConvert(calls: string[][], gate?: Promise<void>): Convert {
  return async ({ args, outputPath }) => {
    calls.push(args);
    if (gate !== undefined) await gate;
    await writeFile(outputPath, 'variante!');
  };
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'widetv-variant-'));
  libraryRoot = join(base, 'acervo');
  dataDir = join(base, 'data');
  await mkdir(join(libraryRoot, 'Serie'), { recursive: true });
  await writeFile(join(libraryRoot, 'Serie', 'ep1.mkv'), 'mkv');

  store = openStore(':memory:');
  const show = store.upsertShow({ slug: 'serie', name: 'Serie', absolutePath: join(libraryRoot, 'Serie') });
  store.upsertEpisodes(show.id, [episodeRow('Serie/ep1.mkv')]);
});

afterEach(async () => {
  store.close();
  await rm(base, { recursive: true, force: true });
});

/** Espera a fila (um worker, com I/O de verdade) esvaziar. */
async function settle(): Promise<void> {
  for (let i = 0; i < 100; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

/** Consulta ate ficar pronto, como o cliente real faz. */
async function waitReady(
  queue: ReturnType<typeof createVariantQueue>,
  episodeId: string,
  audioIndex: number,
): Promise<{ status: 'ready'; path: string }> {
  for (let i = 0; i < 200; i += 1) {
    const result = await queue.request(episodeId, audioIndex);
    if (result.status === 'ready') return result;
    if (result.status === 'invalid') throw new Error('invalid');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('variante nunca ficou pronta');
}

describe('createVariantQueue', () => {
  test('primeiro pedido devolve preparing e gera; o seguinte devolve ready', async () => {
    const calls: string[][] = [];
    const queue = createVariantQueue({ store, libraryRoot, dataDir, convert: fakeConvert(calls) });

    const first = await queue.request('Serie/ep1.mkv', 1);
    expect(first.status).toBe('preparing');

    const second = await waitReady(queue, 'Serie/ep1.mkv', 1);
    expect(second.path).toBe(join(dataDir, 'remux', variantFileName('Serie/ep1.mkv', 1, 111, 1000)));
    expect(calls).toHaveLength(1);
    // A variante mapeia a faixa pedida (1), nao a default.
    expect(calls[0]).toEqual(expect.arrayContaining(['0:a:1']));
  });

  test('pedidos repetidos enquanto gera nao dobram a fila', async () => {
    const calls: string[][] = [];
    let open = () => undefined as void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const queue = createVariantQueue({ store, libraryRoot, dataDir, convert: fakeConvert(calls, gate) });

    await queue.request('Serie/ep1.mkv', 1);
    await queue.request('Serie/ep1.mkv', 1);
    await queue.request('Serie/ep1.mkv', 1);
    open();
    await settle();

    expect(calls).toHaveLength(1);
  });

  test('faixa inexistente e episodio desconhecido devolvem invalid, sem enfileirar', async () => {
    const calls: string[][] = [];
    const queue = createVariantQueue({ store, libraryRoot, dataDir, convert: fakeConvert(calls) });

    expect((await queue.request('Serie/ep1.mkv', 9)).status).toBe('invalid');
    expect((await queue.request('nao-existe.mkv', 0)).status).toBe('invalid');
    await settle();
    expect(calls).toHaveLength(0);
  });

  test('falha do conversor nao trava a fila: proximo pedido tenta de novo', async () => {
    let attempts = 0;
    const explosivo: Convert = async ({ outputPath }) => {
      attempts += 1;
      if (attempts === 1) throw new Error('disco cheio');
      await writeFile(outputPath, 'variante!');
    };
    const mensagens: string[] = [];
    const queue = createVariantQueue({
      store,
      libraryRoot,
      dataDir,
      convert: explosivo,
      log: (message) => mensagens.push(message),
    });

    await queue.request('Serie/ep1.mkv', 1);
    await settle();
    expect(mensagens[0]).toContain('disco cheio');
    expect((await queue.request('Serie/ep1.mkv', 1)).status).toBe('preparing');
    await waitReady(queue, 'Serie/ep1.mkv', 1);
  });

  test('linha valida com arquivo apagado gera de novo em vez de servir 404', async () => {
    const queue = createVariantQueue({ store, libraryRoot, dataDir, convert: fakeConvert([]) });
    await waitReady(queue, 'Serie/ep1.mkv', 1).catch(() => undefined);
    await queue.request('Serie/ep1.mkv', 1);

    const file = variantFileName('Serie/ep1.mkv', 1, 111, 1000);
    await rm(join(dataDir, 'remux', file));

    expect((await queue.request('Serie/ep1.mkv', 1)).status).toBe('preparing');
    await waitReady(queue, 'Serie/ep1.mkv', 1);
    expect(await readdir(join(dataDir, 'remux'))).toEqual([file]);
  });
});
