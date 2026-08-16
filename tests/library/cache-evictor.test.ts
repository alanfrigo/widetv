import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { createCacheEvictor } from '../../src/server/library/cache-evictor';
import type { CacheFileRow } from '../../src/server/library/index-store';

/**
 * Store de mentira: o evictor so precisa de tres metodos, e usar um SQLite de
 * verdade aqui esconderia qual deles ele realmente chama e em que ordem.
 */
function fakeStore(rows: CacheFileRow[]) {
  const deleted: string[] = [];
  const measured: { key: string; bytes: number }[] = [];
  return {
    deleted,
    measured,
    rows,
    listCacheFiles: () => rows.map((row) => ({ ...row })),
    setCacheFileBytes: (key: string, bytes: number) => {
      measured.push({ key, bytes });
      const found = rows.find((row) => row.key === key);
      if (found !== undefined) found.bytes = bytes;
    },
    deleteCacheFile: (key: string) => {
      deleted.push(key);
      const at = rows.findIndex((row) => row.key === key);
      if (at >= 0) rows.splice(at, 1);
    },
  };
}

function row(key: string, file: string, bytes: number, lastAccessAt: number): CacheFileRow {
  return { key, kind: 'remux', episodeId: key, audioIndex: null, file, bytes, lastAccessAt };
}

let base: string;
let remuxDir: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'widetv-evictor-'));
  remuxDir = join(base, 'remux');
  await mkdir(remuxDir, { recursive: true });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function writeCopy(name: string, bytes: number): Promise<void> {
  await writeFile(join(remuxDir, name), Buffer.alloc(bytes));
}

describe('orcamento', () => {
  test('abaixo do teto nao apaga nada', async () => {
    await writeCopy('a.mp4', 100);
    const store = fakeStore([row('remux:a', 'a.mp4', 100, 1)]);
    const evictor = createCacheEvictor({
      store,
      remuxDir,
      capBytes: () => 1000,
      pinned: () => new Set(),
    });

    const report = await evictor.sweep();

    expect(report.evicted).toBe(0);
    expect(await readdir(remuxDir)).toEqual(['a.mp4']);
  });

  test('apaga o arquivo E a linha, do mais frio para o mais quente', async () => {
    await writeCopy('frio.mp4', 400);
    await writeCopy('morno.mp4', 400);
    await writeCopy('quente.mp4', 400);
    const store = fakeStore([
      row('remux:quente', 'quente.mp4', 400, 300),
      row('remux:frio', 'frio.mp4', 400, 100),
      row('remux:morno', 'morno.mp4', 400, 200),
    ]);
    const evictor = createCacheEvictor({
      store,
      remuxDir,
      capBytes: () => 500,
      pinned: () => new Set(),
    });

    const report = await evictor.sweep();

    expect(report.evicted).toBe(2);
    expect(report.freedBytes).toBe(800);
    expect(store.deleted).toEqual(['remux:frio', 'remux:morno']);
    expect(await readdir(remuxDir)).toEqual(['quente.mp4']);
  });

  test('o pinado sobrevive mesmo sendo o mais frio', async () => {
    await writeCopy('tocando.mp4', 400);
    await writeCopy('parado.mp4', 400);
    const store = fakeStore([
      row('remux:tocando', 'tocando.mp4', 400, 1),
      row('remux:parado', 'parado.mp4', 400, 999),
    ]);
    const evictor = createCacheEvictor({
      store,
      remuxDir,
      capBytes: () => 400,
      pinned: () => new Set(['remux:tocando']),
    });

    await evictor.sweep();

    expect(await readdir(remuxDir)).toEqual(['tocando.mp4']);
  });

  test('teto zero desliga a evicção em vez de apagar tudo', async () => {
    await writeCopy('a.mp4', 999);
    const store = fakeStore([row('remux:a', 'a.mp4', 999, 1)]);
    const evictor = createCacheEvictor({
      store,
      remuxDir,
      capBytes: () => 0,
      pinned: () => new Set(),
    });

    const report = await evictor.sweep();

    expect(report.evicted).toBe(0);
    expect(report.totalBytes).toBe(999);
    expect(await readdir(remuxDir)).toEqual(['a.mp4']);
  });
});

describe('manutencao', () => {
  test('linha sem arquivo em disco e removida do indice', async () => {
    const store = fakeStore([row('remux:fantasma', 'fantasma.mp4', 500, 1)]);
    const evictor = createCacheEvictor({
      store,
      remuxDir,
      capBytes: () => 1000,
      pinned: () => new Set(),
    });

    const report = await evictor.sweep();

    expect(report.missing).toBe(1);
    expect(store.deleted).toEqual(['remux:fantasma']);
  });

  test('bytes de um fantasma nao contam para o orcamento', async () => {
    // Sem a limpeza, os 5000 bytes inexistentes estourariam o teto e a copia
    // de verdade seria apagada para caber num arquivo que nao existe.
    await writeCopy('real.mp4', 100);
    const store = fakeStore([
      row('remux:fantasma', 'fantasma.mp4', 5000, 1),
      row('remux:real', 'real.mp4', 100, 2),
    ]);
    const evictor = createCacheEvictor({
      store,
      remuxDir,
      capBytes: () => 1000,
      pinned: () => new Set(),
    });

    const report = await evictor.sweep();

    expect(report.totalBytes).toBe(100);
    expect(report.evicted).toBe(0);
    expect(await readdir(remuxDir)).toEqual(['real.mp4']);
  });

  test('linha anterior ao schema 12 ganha o tamanho por stat', async () => {
    await writeCopy('antiga.mp4', 777);
    const store = fakeStore([row('remux:antiga', 'antiga.mp4', 0, 1)]);
    const evictor = createCacheEvictor({
      store,
      remuxDir,
      capBytes: () => 10_000,
      pinned: () => new Set(),
    });

    const report = await evictor.sweep();

    expect(report.measured).toBe(1);
    expect(store.measured).toEqual([{ key: 'remux:antiga', bytes: 777 }]);
    expect(report.totalBytes).toBe(777);
  });

  test('nome de arquivo com caminho nao escapa do diretorio de remux', async () => {
    const outside = join(base, 'segredo.mp4');
    await writeFile(outside, Buffer.alloc(10));
    await writeCopy('segredo.mp4', 900);
    const store = fakeStore([row('remux:mau', '../segredo.mp4', 900, 1)]);
    const evictor = createCacheEvictor({
      store,
      remuxDir,
      capBytes: () => 1,
      pinned: () => new Set(),
    });

    await evictor.sweep();

    // O basename fez o alvo virar `remux/segredo.mp4`; o de fora fica intacto.
    expect(await readdir(remuxDir)).toEqual([]);
    expect(await readdir(base)).toContain('segredo.mp4');
  });
});

describe('concorrencia', () => {
  test('duas varreduras simultaneas compartilham a mesma rodada', async () => {
    await writeCopy('a.mp4', 400);
    await writeCopy('b.mp4', 400);
    const store = fakeStore([
      row('remux:a', 'a.mp4', 400, 1),
      row('remux:b', 'b.mp4', 400, 2),
    ]);
    const evictor = createCacheEvictor({
      store,
      remuxDir,
      capBytes: () => 400,
      pinned: () => new Set(),
    });

    const [first, second] = await Promise.all([evictor.sweep(), evictor.sweep()]);

    expect(first).toBe(second);
    expect(store.deleted).toEqual(['remux:a']);
  });

  test('depois de terminar, uma nova varredura roda de verdade', async () => {
    await writeCopy('a.mp4', 400);
    const store = fakeStore([row('remux:a', 'a.mp4', 400, 1)]);
    const evictor = createCacheEvictor({
      store,
      remuxDir,
      capBytes: () => 10_000,
      pinned: () => new Set(),
    });

    const first = await evictor.sweep();
    const second = await evictor.sweep();

    expect(second).not.toBe(first);
  });
});
