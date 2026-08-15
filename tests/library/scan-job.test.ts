import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { openStore, type Store } from '../../src/server/library/index-store';
import type { ProbeResult } from '../../src/server/library/probe-types';
import { runScan } from '../../src/server/library/scan-job';

let root: string;
let store: Store;

/** Probe falso e deterministico: o teste e do orquestrador, nao do ffprobe. */
function fakeProbe(durationMs = 60_000) {
  const calls: string[] = [];
  const probe = async (filePath: string): Promise<ProbeResult> => {
    calls.push(filePath);
    if (filePath.includes('corrompido')) throw new Error('ffprobe falhou');
    return {
      durationMs,
      videoCodec: 'av1',
      audioCodec: 'aac',
      width: 640,
      height: 480,
      faststart: true,
      audioTracks: [
        { index: 0, lang: 'por', title: 'Brazilian', codec: 'eac3', isDefault: true },
        { index: 1, lang: 'eng', title: null, codec: 'eac3', isDefault: false },
      ],
      subtitleTracks: [
        { index: 0, lang: 'por', title: null, codec: 'subrip', isDefault: true, forced: true },
      ],
    };
  };
  return { probe, calls };
}

async function makeEpisode(show: string, file: string): Promise<string> {
  const dir = join(root, show);
  await mkdir(dir, { recursive: true });
  const path = join(dir, file);
  await writeFile(path, 'x');
  return path;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'widetv-scan-'));
  store = openStore(':memory:');
});

afterEach(async () => {
  store.close();
  await rm(root, { recursive: true, force: true });
});

describe('runScan', () => {
  test('indexa series e episodios encontrados', async () => {
    await makeEpisode('ThunderCats', 'ep 01.mp4');
    await makeEpisode('ThunderCats', 'ep 02.mp4');
    await makeEpisode('He-Man', 'ep 01.mp4');

    const { probe } = fakeProbe();
    const report = await runScan({ root, store, probe });

    expect(report.shows).toBe(2);
    expect(report.episodes).toBe(3);
    expect(store.listShows()).toHaveLength(2);
  });

  test('grava a duracao vinda do probe', async () => {
    await makeEpisode('ThunderCats', 'ep 01.mp4');
    const { probe } = fakeProbe(1_320_000);

    await runScan({ root, store, probe });

    const show = store.listShows()[0]!;
    expect(store.listEpisodes(show.id)[0]!.durationMs).toBe(1_320_000);
  });

  test('grava as trilhas de audio e legenda vindas do probe', async () => {
    await makeEpisode('ThunderCats', 'ep 01.mkv');

    await runScan({ root, store, probe: fakeProbe().probe });

    const show = store.listShows()[0]!;
    const episode = store.listEpisodes(show.id)[0]!;
    expect(episode.audioTracks.map((t) => t.lang)).toEqual(['por', 'eng']);
    expect(episode.subtitleTracks).toEqual([
      { index: 0, lang: 'por', title: null, codec: 'subrip', isDefault: true, forced: true },
    ]);
  });

  test('trilhas sobrevivem ao cache: segundo scan sem probe mantem o que foi gravado', async () => {
    await makeEpisode('ThunderCats', 'ep 01.mkv');
    await runScan({ root, store, probe: fakeProbe().probe });

    const segundo = fakeProbe();
    await runScan({ root, store, probe: segundo.probe });

    expect(segundo.calls).toHaveLength(0);
    const show = store.listShows()[0]!;
    expect(store.listEpisodes(show.id)[0]!.audioTracks).toHaveLength(2);
  });

  test('segundo scan nao reprocessa arquivo intocado', async () => {
    await makeEpisode('ThunderCats', 'ep 01.mp4');

    const primeiro = fakeProbe();
    await runScan({ root, store, probe: primeiro.probe });
    expect(primeiro.calls).toHaveLength(1);

    const segundo = fakeProbe();
    const report = await runScan({ root, store, probe: segundo.probe });
    expect(segundo.calls).toHaveLength(0);
    expect(report.cached).toBe(1);
    expect(report.probed).toBe(0);
  });

  test('arquivo alterado e reprocessado', async () => {
    const path = await makeEpisode('ThunderCats', 'ep 01.mp4');
    await runScan({ root, store, probe: fakeProbe().probe });

    // Mesmo tamanho, mtime diferente: o cache tem que cair.
    const futuro = new Date(Date.now() + 60_000);
    await utimes(path, futuro, futuro);

    const segundo = fakeProbe();
    await runScan({ root, store, probe: segundo.probe });
    expect(segundo.calls).toHaveLength(1);
  });

  test('numero de canal sobrevive a um rescan com serie nova', async () => {
    await makeEpisode('ThunderCats', 'ep 01.mp4');
    await runScan({ root, store, probe: fakeProbe().probe });
    const antes = store.listShows().find((s) => s.name === 'ThunderCats')!.channelNumber;

    // 'A-Team' viria antes em ordem alfabetica: se o numero fosse recalculado,
    // ele roubaria o canal do ThunderCats.
    await makeEpisode('A-Team', 'ep 01.mp4');
    await runScan({ root, store, probe: fakeProbe().probe });

    expect(store.listShows().find((s) => s.name === 'ThunderCats')!.channelNumber).toBe(antes);
  });

  test('episodio removido do disco sai do indice', async () => {
    await makeEpisode('ThunderCats', 'ep 01.mp4');
    const segundo = await makeEpisode('ThunderCats', 'ep 02.mp4');
    await runScan({ root, store, probe: fakeProbe().probe });

    await rm(segundo);
    const report = await runScan({ root, store, probe: fakeProbe().probe });

    const show = store.listShows()[0]!;
    expect(store.listEpisodes(show.id)).toHaveLength(1);
    expect(report.removedEpisodes).toBe(1);
  });

  test('serie removida do disco sai do indice', async () => {
    await makeEpisode('ThunderCats', 'ep 01.mp4');
    await makeEpisode('He-Man', 'ep 01.mp4');
    await runScan({ root, store, probe: fakeProbe().probe });

    await rm(join(root, 'He-Man'), { recursive: true });
    const report = await runScan({ root, store, probe: fakeProbe().probe });

    expect(store.listShows()).toHaveLength(1);
    expect(report.removedShows).toBe(1);
  });

  test('arquivo que falha no probe e reportado e nao entra na grade', async () => {
    await makeEpisode('ThunderCats', 'ep 01.mp4');
    await makeEpisode('ThunderCats', 'ep 02 corrompido.mp4');

    const report = await runScan({ root, store, probe: fakeProbe().probe });

    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]!.path).toContain('corrompido');
    expect(report.episodes).toBe(1);

    // Duracao invalida na grade travaria o relogio do canal num loop.
    const show = store.listShows()[0]!;
    expect(store.listEpisodes(show.id).every((e) => e.durationMs > 0)).toBe(true);
  });

  test('serie cujos arquivos falharam todos nao vira canal', async () => {
    await makeEpisode('Quebrada', 'ep 01 corrompido.mp4');
    const report = await runScan({ root, store, probe: fakeProbe().probe });
    expect(report.shows).toBe(0);
    expect(store.listShows()).toHaveLength(0);
  });

  test('reporta progresso durante o scan', async () => {
    await makeEpisode('ThunderCats', 'ep 01.mp4');
    await makeEpisode('He-Man', 'ep 01.mp4');

    const eventos: number[] = [];
    await runScan({
      root,
      store,
      probe: fakeProbe().probe,
      onProgress: (p) => eventos.push(p.done),
    });

    expect(eventos.length).toBeGreaterThan(0);
    expect(eventos.at(-1)).toBe(2);
  });

  test('raiz vazia nao quebra e devolve relatorio zerado', async () => {
    const report = await runScan({ root, store, probe: fakeProbe().probe });
    expect(report).toMatchObject({ shows: 0, episodes: 0, probed: 0 });
  });
});
