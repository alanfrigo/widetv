import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { AudioTrackRef } from '../../src/shared/api-types';
import { openStore, type EpisodeInput, type Store } from '../../src/server/library/index-store';
import type { Convert } from '../../src/server/library/remux-job';
import {
  collectLegacy,
  runTranscodeLegacy,
  type VerifyResult,
} from '../../src/server/library/transcode-job';

const MP3: AudioTrackRef[] = [
  { index: 0, lang: 'por', title: null, codec: 'mp3', isDefault: true },
  { index: 1, lang: 'eng', title: null, codec: 'mp3', isDefault: false },
];

function episodeRow(id: string, over: Partial<EpisodeInput> = {}): EpisodeInput {
  return {
    id,
    absolutePath: `/lib/${id}`,
    title: id,
    season: 1,
    episode: 1,
    orderIndex: 0,
    durationMs: 1_392_000,
    videoCodec: 'mpeg4',
    audioCodec: 'mp3',
    width: 512,
    height: 384,
    faststart: false,
    audioTracks: MP3.map((t) => ({ ...t })),
    subtitleTracks: [],
    mtimeMs: 111,
    size: 195_000_000,
    ...over,
  };
}

let base: string;
let libraryRoot: string;
let store: Store;

/** Conversor de mentira: grava um arquivo e anota a chamada. */
function fakeConvert(calls: { input: string; output: string; args: string[] }[]): Convert {
  return async ({ inputPath, args, outputPath }) => {
    calls.push({ input: inputPath, output: outputPath, args });
    await writeFile(outputPath, 'h264!');
  };
}

const okVerify = async (): Promise<VerifyResult> => ({ ok: true });

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'widetv-legacy-'));
  libraryRoot = join(base, 'acervo');
  await mkdir(join(libraryRoot, 'Simpsons'), { recursive: true });
  await writeFile(join(libraryRoot, 'Simpsons', 'ep1.avi'), 'avi');
  await writeFile(join(libraryRoot, 'Simpsons', 'ep2.avi'), 'avi');
  await writeFile(join(libraryRoot, 'Simpsons', 'ep3.mkv'), 'mkv');

  store = openStore(':memory:');
  const show = store.upsertShow({
    slug: 'simpsons',
    name: 'Simpsons',
    absolutePath: join(libraryRoot, 'Simpsons'),
  });
  store.upsertEpisodes(show.id, [
    episodeRow('Simpsons/ep1.avi'),
    episodeRow('Simpsons/ep2.avi', { orderIndex: 1 }),
    // h264 num mkv: precisa de remux, nunca de reconversao.
    episodeRow('Simpsons/ep3.mkv', { orderIndex: 2, videoCodec: 'h264', audioCodec: 'aac' }),
  ]);
});

afterEach(async () => {
  store.close();
  await rm(base, { recursive: true, force: true });
});

function run(over: Partial<Parameters<typeof runTranscodeLegacy>[0]> = {}) {
  return runTranscodeLegacy({
    store,
    libraryRoot,
    dryRun: true,
    replace: false,
    keepOriginalsDir: null,
    verify: okVerify,
    ...over,
  });
}

describe('quem e candidato', () => {
  test('so os legados entram; o h264 fica de fora', () => {
    expect(collectLegacy(store).map((row) => row.id)).toEqual([
      'Simpsons/ep1.avi',
      'Simpsons/ep2.avi',
    ]);
  });

  test('`only` restringe a um caminho, para provar o lote numa temporada', () => {
    expect(collectLegacy(store, 'Simpsons/ep2').map((row) => row.id)).toEqual(['Simpsons/ep2.avi']);
    expect(collectLegacy(store, 'Outra/')).toEqual([]);
  });
});

describe('dry-run e o padrao', () => {
  test('nao chama ffmpeg e nao escreve nada', async () => {
    const calls: { input: string; output: string; args: string[] }[] = [];

    const report = await run({ convert: fakeConvert(calls) });

    expect(report.candidates).toBe(2);
    expect(report.converted).toBe(0);
    expect(calls).toEqual([]);
    expect(report.items.every((item) => item.status === 'candidate')).toBe(true);
    expect(await readdir(join(libraryRoot, 'Simpsons'))).toEqual(['ep1.avi', 'ep2.avi', 'ep3.mkv']);
  });

  test('mede o que seria convertido, para a pessoa decidir', async () => {
    const report = await run();
    expect(report.sourceBytes).toBe(2 * 195_000_000);
  });
});

describe('conversao', () => {
  test('escreve ao LADO do original e nao encosta nele', async () => {
    const calls: { input: string; output: string; args: string[] }[] = [];

    const report = await run({ dryRun: false, convert: fakeConvert(calls) });

    expect(report.converted).toBe(2);
    expect(report.replaced).toBe(0);
    const files = (await readdir(join(libraryRoot, 'Simpsons'))).sort();
    expect(files).toEqual(['ep1.avi', 'ep1.h264.mp4', 'ep2.avi', 'ep2.h264.mp4', 'ep3.mkv']);
    // O ffmpeg escreveu num .tmp; o nome final saiu de um rename.
    expect(calls[0]?.output.endsWith('.tmp')).toBe(true);
  });

  test('`limit` para a rodada, para provar antes de rodar o acervo inteiro', async () => {
    const report = await run({ dryRun: false, convert: fakeConvert([]), limit: 1 });
    expect(report.candidates).toBe(1);
    expect(report.converted).toBe(1);
  });

  test('rodar de novo pula o que ja ficou pronto', async () => {
    const calls: { input: string; output: string; args: string[] }[] = [];
    await run({ dryRun: false, convert: fakeConvert(calls) });

    const again = await run({ dryRun: false, convert: fakeConvert(calls) });

    expect(again.skipped).toBe(2);
    expect(again.converted).toBe(0);
    // Nenhuma chamada NOVA de ffmpeg.
    expect(calls).toHaveLength(2);
  });
});

describe('o original so sai depois da conferencia', () => {
  test('conferencia reprovada: o .tmp some e o ORIGINAL fica', async () => {
    const report = await run({
      dryRun: false,
      replace: true,
      convert: fakeConvert([]),
      verify: async () => ({ ok: false, reason: 'fim nao decodifica' }),
    });

    expect(report.failed).toBe(2);
    expect(report.replaced).toBe(0);
    const files = (await readdir(join(libraryRoot, 'Simpsons'))).sort();
    // Nem convertido, nem .tmp esquecido, e os originais intactos.
    expect(files).toEqual(['ep1.avi', 'ep2.avi', 'ep3.mkv']);
    expect(report.items[0]?.reason).toContain('fim nao decodifica');
  });

  test('conversor que explode nao leva o original junto', async () => {
    const explode: Convert = () => Promise.reject(new Error('ffmpeg morreu'));

    const report = await run({ dryRun: false, replace: true, convert: explode });

    expect(report.failed).toBe(2);
    expect(await readFile(join(libraryRoot, 'Simpsons', 'ep1.avi'), 'utf8')).toBe('avi');
  });

  test('sem --replace o original fica, mesmo com a conferencia passando', async () => {
    await run({ dryRun: false, convert: fakeConvert([]) });
    await stat(join(libraryRoot, 'Simpsons', 'ep1.avi'));
  });

  test('com --replace o original sai e o convertido ocupa o lugar', async () => {
    const report = await run({ dryRun: false, replace: true, convert: fakeConvert([]) });

    expect(report.replaced).toBe(2);
    const files = (await readdir(join(libraryRoot, 'Simpsons'))).sort();
    expect(files).toEqual(['ep1.h264.mp4', 'ep2.h264.mp4', 'ep3.mkv']);
  });
});

describe('--keep-originals torna o lote reversivel', () => {
  test('move preservando o caminho relativo, em vez de apagar', async () => {
    const attic = join(base, 'originais');

    const report = await run({
      dryRun: false,
      replace: true,
      keepOriginalsDir: attic,
      convert: fakeConvert([]),
    });

    expect(report.replaced).toBe(2);
    expect((await readdir(join(attic, 'Simpsons'))).sort()).toEqual(['ep1.avi', 'ep2.avi']);
    // Conteudo intacto: foi movido, nao recriado.
    expect(await readFile(join(attic, 'Simpsons', 'ep1.avi'), 'utf8')).toBe('avi');
  });
});

describe('quando a retirada do original falha', () => {
  test('a conversao NAO e desfeita, e o episodio nao conta duas vezes', async () => {
    // Destino impossivel: `--keep-originals` apontando para dentro de um
    // arquivo. E o mesmo formato de falha do EXDEV (mover entre filesystems).
    const blocker = join(base, 'bloqueio');
    await writeFile(blocker, 'nao sou diretorio');

    const report = await run({
      dryRun: false,
      replace: true,
      keepOriginalsDir: blocker,
      convert: fakeConvert([]),
    });

    // Converteu de verdade...
    expect(report.converted).toBe(2);
    // ...nao substituiu...
    expect(report.replaced).toBe(0);
    // ...e cada episodio aparece UMA vez, com o motivo.
    expect(report.items).toHaveLength(2);
    expect(report.items[0]?.status).toBe('kept-original');
    expect(report.items[0]?.reason).toContain('original nao pode ser retirado');

    // Estado seguro: os dois arquivos em disco, nada perdido.
    const files = (await readdir(join(libraryRoot, 'Simpsons'))).sort();
    expect(files).toEqual(['ep1.avi', 'ep1.h264.mp4', 'ep2.avi', 'ep2.h264.mp4', 'ep3.mkv']);
  });
});
