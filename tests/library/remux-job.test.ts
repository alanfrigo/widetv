import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { AudioTrackRef } from '../../src/shared/api-types';
import { openStore, type EpisodeInput, type Store } from '../../src/server/library/index-store';
import type { ProbeResult } from '../../src/server/library/probe-types';
import { runRemux, remuxFileName, type Convert } from '../../src/server/library/remux-job';

const DOLBY: AudioTrackRef = { index: 0, lang: 'por', title: null, codec: 'eac3', isDefault: true };
const AAC: AudioTrackRef = { index: 0, lang: 'por', title: null, codec: 'aac', isDefault: true };

/** Trilhas que o probe "ve" no MP4 gerado: gemea AAC na frente, Dolby atras. */
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

/** Conversor de mentira: grava um arquivo e anota a chamada. */
function fakeConvert(calls: { input: string; args: string[] }[]): Convert {
  return async ({ inputPath, args, outputPath }) => {
    calls.push({ input: inputPath, args });
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

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'widetv-remux-'));
  libraryRoot = join(base, 'acervo');
  dataDir = join(base, 'data');
  await mkdir(join(libraryRoot, 'Serie'), { recursive: true });
  await writeFile(join(libraryRoot, 'Serie', 'ep1.mkv'), 'mkv');
  await writeFile(join(libraryRoot, 'Serie', 'ep2.mp4'), 'mp4');

  store = openStore(':memory:');
  const show = store.upsertShow({ slug: 'serie', name: 'Serie', absolutePath: join(libraryRoot, 'Serie') });
  store.upsertEpisodes(show.id, [
    episodeRow('Serie/ep1.mkv'),
    episodeRow('Serie/ep2.mp4', { audioTracks: [AAC], audioCodec: 'aac', orderIndex: 1 }),
  ]);
});

afterEach(async () => {
  store.close();
  await rm(base, { recursive: true, force: true });
});

describe('runRemux', () => {
  test('converte so quem precisa e registra as trilhas do MP4 gerado', async () => {
    const calls: { input: string; args: string[] }[] = [];
    const report = await runRemux({
      store,
      libraryRoot,
      dataDir,
      convert: fakeConvert(calls),
      probe: fakeProbe,
    });

    expect(report.planned).toBe(1);
    expect(report.converted).toBe(1);
    expect(report.failed).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(join(libraryRoot, 'Serie/ep1.mkv'));

    const row = store.getRemux('Serie/ep1.mkv', 111, 1000);
    expect(row?.audioTracks).toEqual(REMUXED_TRACKS);

    // O arquivo esta no lugar, ja renomeado (sem .tmp sobrando).
    const file = remuxFileName('Serie/ep1.mkv', 111, 1000);
    expect(await readFile(join(dataDir, 'remux', file), 'utf8')).toBe('mp4!');
    expect(await readdir(join(dataDir, 'remux'))).toEqual([file]);
  });

  test('segunda rodada pula o que ja esta convertido, sem chamar o ffmpeg', async () => {
    const calls: { input: string; args: string[] }[] = [];
    await runRemux({ store, libraryRoot, dataDir, convert: fakeConvert(calls), probe: fakeProbe });
    const report = await runRemux({
      store,
      libraryRoot,
      dataDir,
      convert: fakeConvert(calls),
      probe: fakeProbe,
    });

    expect(report.skipped).toBe(1);
    expect(report.converted).toBe(0);
    expect(calls).toHaveLength(1);
  });

  test('fonte que mudou (mtime) reconverte e recolhe o MP4 antigo', async () => {
    await runRemux({ store, libraryRoot, dataDir, convert: fakeConvert([]), probe: fakeProbe });
    const antigo = remuxFileName('Serie/ep1.mkv', 111, 1000);

    const show = store.upsertShow({ slug: 'serie', name: 'Serie', absolutePath: join(libraryRoot, 'Serie') });
    store.upsertEpisodes(show.id, [
      episodeRow('Serie/ep1.mkv', { mtimeMs: 222 }),
      episodeRow('Serie/ep2.mp4', { audioTracks: [AAC], audioCodec: 'aac', orderIndex: 1 }),
    ]);

    const report = await runRemux({
      store,
      libraryRoot,
      dataDir,
      convert: fakeConvert([]),
      probe: fakeProbe,
    });

    expect(report.converted).toBe(1);
    expect(report.removedFiles).toBe(1);
    const files = await readdir(join(dataDir, 'remux'));
    expect(files).toEqual([remuxFileName('Serie/ep1.mkv', 222, 1000)]);
    expect(files).not.toContain(antigo);
  });

  test('remux gravado por versao antiga do plano reconverte e apaga o MP4 antigo', async () => {
    // Simula rodada anterior: linha valida no indice, mas com o nome que uma
    // versao antiga do plano gerava (ex.: gemea AAC sem aformat, muda no Safari).
    await mkdir(join(dataDir, 'remux'), { recursive: true });
    await writeFile(join(dataDir, 'remux', 'plano-antigo.mp4'), 'mp4 velho');
    store.upsertRemux({
      episodeId: 'Serie/ep1.mkv',
      file: 'plano-antigo.mp4',
      mtimeMs: 111,
      size: 1000,
      audioTracks: REMUXED_TRACKS,
      createdAt: 1,
    });

    const report = await runRemux({
      store,
      libraryRoot,
      dataDir,
      convert: fakeConvert([]),
      probe: fakeProbe,
    });

    expect(report.converted).toBe(1);
    expect(report.skipped).toBe(0);
    expect(await readdir(join(dataDir, 'remux'))).toEqual([
      remuxFileName('Serie/ep1.mkv', 111, 1000),
    ]);
  });

  test('linha valida com arquivo apagado do disco reconverte em vez de pular', async () => {
    await runRemux({ store, libraryRoot, dataDir, convert: fakeConvert([]), probe: fakeProbe });
    const file = remuxFileName('Serie/ep1.mkv', 111, 1000);
    await rm(join(dataDir, 'remux', file));

    const report = await runRemux({
      store,
      libraryRoot,
      dataDir,
      convert: fakeConvert([]),
      probe: fakeProbe,
    });
    expect(report.converted).toBe(1);
    expect(await readdir(join(dataDir, 'remux'))).toEqual([file]);
  });

  test('falha num arquivo nao derruba a rodada nem deixa .tmp para tras', async () => {
    const explosivo: Convert = async ({ outputPath }) => {
      await writeFile(outputPath, 'meio arquivo');
      throw new Error('ffmpeg saiu com 1: corrupt input');
    };
    const report = await runRemux({ store, libraryRoot, dataDir, convert: explosivo, probe: fakeProbe });

    expect(report.converted).toBe(0);
    expect(report.failed).toEqual([
      { path: 'Serie/ep1.mkv', reason: 'ffmpeg saiu com 1: corrupt input' },
    ]);
    expect(store.getRemux('Serie/ep1.mkv', 111, 1000)).toBeNull();
    expect(await readdir(join(dataDir, 'remux'))).toEqual([]);
  });

  test('arquivo estranho no diretorio de remux e recolhido', async () => {
    await mkdir(join(dataDir, 'remux'), { recursive: true });
    await writeFile(join(dataDir, 'remux', 'lixo.mp4'), 'x');
    const report = await runRemux({ store, libraryRoot, dataDir, convert: fakeConvert([]), probe: fakeProbe });

    expect(report.removedFiles).toBe(1);
    const files = await readdir(join(dataDir, 'remux'));
    expect(files).not.toContain('lixo.mp4');
  });
});

describe('orcamento de disco', () => {
  /**
   * Tres episodios MKV, todos precisando de remux. O conversor grava um
   * arquivo de tamanho controlado para o teto ser atingido de forma previsivel.
   */
  async function tresMkv(bytesPorCopia: number): Promise<{ calls: { input: string }[]; convert: Convert }> {
    await writeFile(join(libraryRoot, 'Serie', 'ep3.mkv'), 'mkv');
    await writeFile(join(libraryRoot, 'Serie', 'ep4.mkv'), 'mkv');
    const show = store.listShows()[0];
    if (show === undefined) throw new Error('fixture sem serie');
    store.upsertEpisodes(show.id, [
      episodeRow('Serie/ep1.mkv'),
      episodeRow('Serie/ep3.mkv', { orderIndex: 1 }),
      episodeRow('Serie/ep4.mkv', { orderIndex: 2 }),
    ]);
    const calls: { input: string }[] = [];
    const convert: Convert = async ({ inputPath, outputPath }) => {
      calls.push({ input: inputPath });
      await writeFile(outputPath, Buffer.alloc(bytesPorCopia));
    };
    return { calls, convert };
  }

  test('sem teto converte o catalogo inteiro', async () => {
    const { calls, convert } = await tresMkv(1000);

    const report = await runRemux({ store, libraryRoot, dataDir, convert, probe: fakeProbe });

    expect(report.converted).toBe(3);
    expect(report.budgetSkipped).toBe(0);
    expect(calls).toHaveLength(3);
  });

  test('a rodada PARA quando o orcamento acaba, em vez de converter e evictar em circulo', async () => {
    // Cada copia ocupa 1000 bytes e o fonte tambem declara 1000 (episodeRow).
    // Com teto de 2500 cabem dois: o terceiro seria estimado em 3000 > 2500.
    const { calls, convert } = await tresMkv(1000);

    const report = await runRemux({
      store,
      libraryRoot,
      dataDir,
      convert,
      probe: fakeProbe,
      cacheMaxBytes: 2500,
    });

    expect(report.converted).toBe(2);
    expect(report.budgetSkipped).toBe(1);
    expect(calls).toHaveLength(2);
  });

  test('teto zero significa SEM teto, nao "nao converta nada"', async () => {
    const { calls, convert } = await tresMkv(1000);

    const report = await runRemux({
      store,
      libraryRoot,
      dataDir,
      convert,
      probe: fakeProbe,
      cacheMaxBytes: 0,
    });

    expect(report.converted).toBe(3);
    expect(report.budgetSkipped).toBe(0);
    expect(calls).toHaveLength(3);
  });

  test('teto menor que um unico episodio nao converte nada, e diz por que', async () => {
    const { calls, convert } = await tresMkv(1000);

    const report = await runRemux({
      store,
      libraryRoot,
      dataDir,
      convert,
      probe: fakeProbe,
      cacheMaxBytes: 10,
    });

    expect(report.converted).toBe(0);
    expect(report.budgetSkipped).toBe(3);
    expect(calls).toEqual([]);
  });

  test('o tamanho do arquivo GERADO fica registrado para o evictor', async () => {
    const { convert } = await tresMkv(4096);

    await runRemux({ store, libraryRoot, dataDir, convert, probe: fakeProbe });

    // `size` (1000) e do fonte; `bytes` e do MP4 que foi realmente escrito.
    expect(store.getCacheFileBytes('remux:Serie/ep1.mkv')).toBe(4096);
    expect(store.totalCacheBytes()).toBe(3 * 4096);
  });
});
