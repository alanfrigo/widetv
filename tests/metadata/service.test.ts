import { readdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { ShowMetadataRow, ShowRow } from '../../src/server/library/index-store';
import {
  createEnricher,
  enrichMissing,
  listShowsMissingMetadata,
  NOT_FOUND_TTL_MS,
  type MetadataStore,
} from '../../src/server/metadata/service';
import type { LookupResult } from '../../src/server/metadata/providers';

/**
 * O que estes testes protegem, em uma frase: o indice so pode aprender coisa
 * definitiva ("achei", "nao existe") - falha de rede tem que deixar o show
 * exatamente como estava, para ser tentado de novo.
 */

const AGORA = Date.parse('2026-01-01T00:00:00Z');

function show(id: number, name: string): ShowRow {
  return { id, slug: name.toLowerCase(), name, channelNumber: id, absolutePath: `/lib/${name}` };
}

interface FakeStore extends MetadataStore {
  rows: Map<number, ShowMetadataRow>;
}

function makeStore(shows: ShowRow[]): FakeStore {
  const rows = new Map<number, ShowMetadataRow>();
  return {
    rows,
    listShows: () => shows,
    getShowMetadata: (showId) => rows.get(showId) ?? null,
    upsertShowMetadata: (row) => {
      rows.set(row.showId, row);
    },
  };
}

function found(posterUrl: string | null = 'https://img/a.jpg'): LookupResult {
  return {
    status: 'found',
    metadata: { posterUrl, year: 1985, overview: 'Sinopse.', source: 'tvmaze' },
  };
}

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'widetv-metadata-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('listShowsMissingMetadata', () => {
  test('serie nunca buscada entra', () => {
    const store = makeStore([show(1, 'ThunderCats')]);
    expect(listShowsMissingMetadata(store, AGORA).map((s) => s.id)).toEqual([1]);
  });

  test('serie ja encontrada nao volta: capa nao muda', () => {
    const store = makeStore([show(1, 'ThunderCats')]);
    store.rows.set(1, {
      showId: 1,
      posterFile: '1.jpg',
      year: 1985,
      overview: null,
      source: 'tvmaze',
      fetchedAt: AGORA - 10 * NOT_FOUND_TTL_MS,
      notFound: false,
    });
    expect(listShowsMissingMetadata(store, AGORA)).toEqual([]);
  });

  test('not_found dentro do TTL nao e reconsultado', () => {
    const store = makeStore([show(1, 'Obscura')]);
    store.rows.set(1, {
      showId: 1,
      posterFile: null,
      year: null,
      overview: null,
      source: null,
      fetchedAt: AGORA - (NOT_FOUND_TTL_MS - 1),
      notFound: true,
    });
    expect(listShowsMissingMetadata(store, AGORA)).toEqual([]);
  });

  test('not_found vencido volta para a fila', () => {
    const store = makeStore([show(1, 'Obscura')]);
    store.rows.set(1, {
      showId: 1,
      posterFile: null,
      year: null,
      overview: null,
      source: null,
      fetchedAt: AGORA - NOT_FOUND_TTL_MS,
      notFound: true,
    });
    expect(listShowsMissingMetadata(store, AGORA).map((s) => s.id)).toEqual([1]);
  });
});

describe('enrichMissing', () => {
  test('grava a linha e a capa em disco', async () => {
    const store = makeStore([show(1, 'ThunderCats')]);

    const report = await enrichMissing(store, dataDir, {
      now: () => AGORA,
      lookup: () => Promise.resolve(found()),
      download: () => Promise.resolve(new Uint8Array([0xff, 0xd8, 0xff])),
    });

    expect(report).toEqual({ considered: 1, found: 1, posters: 1, notFound: 0, failed: 0 });
    expect(store.rows.get(1)).toEqual({
      showId: 1,
      posterFile: '1.jpg',
      year: 1985,
      overview: 'Sinopse.',
      source: 'tvmaze',
      fetchedAt: AGORA,
      notFound: false,
    });
    expect(Array.from(await readFile(join(dataDir, 'posters', '1.jpg')))).toEqual([
      0xff, 0xd8, 0xff,
    ]);
  });

  test('nao deixa temporario para tras', async () => {
    const store = makeStore([show(1, 'ThunderCats')]);
    await enrichMissing(store, dataDir, {
      now: () => AGORA,
      lookup: () => Promise.resolve(found()),
      download: () => Promise.resolve(new Uint8Array([1])),
    });
    expect(await readdir(join(dataDir, 'posters'))).toEqual(['1.jpg']);
  });

  test('serie sem capa no provedor guarda ano e sinopse, sem arquivo', async () => {
    const store = makeStore([show(1, 'Sem arte')]);

    const report = await enrichMissing(store, dataDir, {
      now: () => AGORA,
      lookup: () => Promise.resolve(found(null)),
      download: () => Promise.reject(new Error('nao deveria baixar nada')),
    });

    expect(report.posters).toBe(0);
    expect(store.rows.get(1)?.posterFile).toBeNull();
    expect(store.rows.get(1)?.year).toBe(1985);
  });

  test('not-found vira linha marcada, para nao rebater no provedor toda hora', async () => {
    const store = makeStore([show(1, 'Nao existe')]);

    const report = await enrichMissing(store, dataDir, {
      now: () => AGORA,
      lookup: () => Promise.resolve({ status: 'not-found' }),
    });

    expect(report.notFound).toBe(1);
    expect(store.rows.get(1)).toEqual({
      showId: 1,
      posterFile: null,
      year: null,
      overview: null,
      source: null,
      fetchedAt: AGORA,
      notFound: true,
    });
  });

  test('erro de rede NAO grava nada: a serie tem que ser tentada de novo', async () => {
    const store = makeStore([show(1, 'ThunderCats')]);

    const report = await enrichMissing(store, dataDir, {
      now: () => AGORA,
      lookup: () => Promise.resolve({ status: 'error', reason: 'ENOTFOUND' }),
    });

    expect(report).toMatchObject({ failed: 1, found: 0, notFound: 0 });
    expect(store.rows.size).toBe(0);
    expect(listShowsMissingMetadata(store, AGORA).map((s) => s.id)).toEqual([1]);
  });

  test('lookup que lanca tem o mesmo tratamento de erro de rede', async () => {
    const store = makeStore([show(1, 'ThunderCats')]);
    const report = await enrichMissing(store, dataDir, {
      now: () => AGORA,
      lookup: () => Promise.reject(new Error('boom')),
    });
    expect(report.failed).toBe(1);
    expect(store.rows.size).toBe(0);
  });

  test('capa que falha ao baixar tambem nao grava linha', async () => {
    // Gravar sem capa selaria o show como resolvido e a imagem nunca mais seria
    // tentada - exatamente o que este projeto quer.
    const store = makeStore([show(1, 'ThunderCats')]);

    const report = await enrichMissing(store, dataDir, {
      now: () => AGORA,
      lookup: () => Promise.resolve(found()),
      download: () => Promise.reject(new Error('502')),
    });

    expect(report.failed).toBe(1);
    expect(store.rows.size).toBe(0);
  });

  test('uma serie quebrada nao derruba as outras', async () => {
    const store = makeStore([show(1, 'Boa'), show(2, 'Ruim'), show(3, 'Boa 2')]);

    const report = await enrichMissing(store, dataDir, {
      now: () => AGORA,
      lookup: (name) =>
        name === 'Ruim'
          ? Promise.resolve<LookupResult>({ status: 'error', reason: 'timeout' })
          : Promise.resolve(found()),
      download: () => Promise.resolve(new Uint8Array([1])),
    });

    expect(report).toMatchObject({ considered: 3, found: 2, failed: 1 });
    expect([...store.rows.keys()].sort()).toEqual([1, 3]);
  });

  test('respeita a concorrencia: no maximo duas buscas em voo', async () => {
    const store = makeStore([1, 2, 3, 4, 5, 6].map((n) => show(n, `Serie ${String(n)}`)));
    let emVoo = 0;
    let pico = 0;

    await enrichMissing(store, dataDir, {
      now: () => AGORA,
      lookup: async () => {
        emVoo += 1;
        pico = Math.max(pico, emVoo);
        await new Promise((r) => setTimeout(r, 1));
        emVoo -= 1;
        return found(null);
      },
    });

    expect(pico).toBe(2);
    expect(store.rows.size).toBe(6);
  });

  test('serie ja resolvida nao e consultada de novo', async () => {
    const store = makeStore([show(1, 'ThunderCats')]);
    const lookup = vi.fn(() => Promise.resolve(found(null)));

    await enrichMissing(store, dataDir, { now: () => AGORA, lookup });
    await enrichMissing(store, dataDir, { now: () => AGORA, lookup });

    expect(lookup).toHaveBeenCalledTimes(1);
  });

  test('not_found so e reconsultado depois do TTL de sete dias', async () => {
    const store = makeStore([show(1, 'Obscura')]);
    const lookup = vi.fn(() => Promise.resolve<LookupResult>({ status: 'not-found' }));

    await enrichMissing(store, dataDir, { now: () => AGORA, lookup });
    await enrichMissing(store, dataDir, { now: () => AGORA + NOT_FOUND_TTL_MS - 1, lookup });
    expect(lookup).toHaveBeenCalledTimes(1);

    await enrichMissing(store, dataDir, { now: () => AGORA + NOT_FOUND_TTL_MS, lookup });
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  test('acervo inteiro ja resolvido nao cria nem o diretorio de capas', async () => {
    const store = makeStore([]);
    const report = await enrichMissing(store, dataDir, { now: () => AGORA });
    expect(report.considered).toBe(0);
    await expect(readdir(join(dataDir, 'posters'))).rejects.toThrow();
  });
});

describe('createEnricher', () => {
  test('duas chamadas concorrentes viram UMA rodada', async () => {
    // Sem isto, uma tela de canais que recarrega sozinha abriria uma varredura
    // por carga e o provedor responderia 429 para o acervo inteiro.
    const store = makeStore([show(1, 'ThunderCats'), show(2, 'He-Man')]);
    const lookup = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return found(null);
    });
    const enricher = createEnricher(store, dataDir, { now: () => AGORA, lookup });

    const a = enricher.run();
    const b = enricher.run();
    enricher.trigger();

    expect(enricher.running).toBe(true);
    await Promise.all([a, b]);

    expect(lookup).toHaveBeenCalledTimes(2); // duas series, uma busca cada
    expect(enricher.running).toBe(false);
  });

  test('a rodada seguinte, depois que a primeira termina, pega o que sobrou', async () => {
    const store = makeStore([show(1, 'ThunderCats')]);
    let tentativas = 0;
    const enricher = createEnricher(store, dataDir, {
      now: () => AGORA,
      lookup: () => {
        tentativas += 1;
        return Promise.resolve<LookupResult>(
          tentativas === 1 ? { status: 'error', reason: 'timeout' } : found(null),
        );
      },
    });

    await enricher.run();
    expect(store.rows.size).toBe(0);

    await enricher.run();
    expect(store.rows.get(1)?.notFound).toBe(false);
    expect(tentativas).toBe(2);
  });

  test('trigger nao propaga erro para quem chamou', async () => {
    const store = makeStore([show(1, 'ThunderCats')]);
    const enricher = createEnricher(store, dataDir, {
      now: () => AGORA,
      // Explode fora do laco por serie, no proprio listShows: o pior caso.
      lookup: () => Promise.reject(new Error('boom')),
    });

    expect(() => {
      enricher.trigger();
    }).not.toThrow();
    await enricher.run();
  });
});
