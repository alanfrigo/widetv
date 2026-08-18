import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { registerAdminRoutes, type AdminDeps } from '../../src/server/admin/routes';
import { openStore, type ShowRow, type Store } from '../../src/server/library/index-store';
import type { AdminShow, MergeSuggestion, MetadataCandidate, TaskAccepted } from '../../src/shared/api-types';

/**
 * As rotas nao decidem curadoria: elas validam o corpo e chamam o indice. O
 * que elas guardam sozinhas e a porta - o PUT de metadata baixa uma URL que
 * veio do cliente, e host fora da lista tem de morrer aqui.
 */

let app: FastifyInstance;
let store: Store;
/** O que o `startScan` de mentira devolve no proximo disparo. */
let scanResult: TaskAccepted;
/** Termos que chegaram em `searchCandidates`, na ordem das chamadas. */
let searchTerms: string[];
/** Series que passaram por `clearMetadata`, na ordem das chamadas. */
let clearedShows: ShowRow[];

const CANDIDATE: MetadataCandidate = {
  source: 'tmdb',
  externalId: '1',
  title: 'Serie',
  year: 1989,
  overview: 'sinopse',
  posterUrl: 'https://image.tmdb.org/t/p/w500/p.jpg',
  backdropUrl: null,
};

beforeEach(async () => {
  store = openStore(':memory:');
  app = Fastify();
  scanResult = { started: true };
  searchTerms = [];
  clearedShows = [];
  const deps: AdminDeps = {
    store,
    dataDir: '/tmp/widetv-teste',
    tmdbApiKey: null,
    startScan: () => scanResult,
    searchCandidates: async (term) => {
      searchTerms.push(term);
      return [CANDIDATE];
    },
    applyMetadata: async () => undefined,
    clearMetadata: (show) => {
      clearedShows.push(show);
    },
  };
  registerAdminRoutes(app, deps);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  store.close();
});

function createShow(slug: string, name: string): number {
  const row = store.upsertShow({ slug, name, absolutePath: `/lib/${name}` });
  store.upsertEpisodes(row.id, [
    {
      id: `${slug}/e1.mkv`,
      absolutePath: `/lib/${name}/e1.mkv`,
      title: 'e1',
      season: 1,
      episode: 1,
      orderIndex: 0,
      durationMs: 1000,
      videoCodec: 'h264',
      audioCodec: 'aac',
      width: 1280,
      height: 720,
      faststart: true,
      audioTracks: [],
      subtitleTracks: [],
      mtimeMs: 1,
      size: 1,
    },
  ]);
  return row.id;
}

describe('GET /api/admin/shows', () => {
  test('devolve a serie com pasta, contagem e selos', async () => {
    const id = createShow('serie', 'Serie');
    store.setShowOverride({ slug: 'serie', name: 'Outro', hidden: true, channelNumber: null });

    const response = await app.inject({ method: 'GET', url: '/api/admin/shows' });

    expect(response.statusCode).toBe(200);
    const shows = response.json<AdminShow[]>();
    expect(shows).toHaveLength(1);
    expect(shows[0]).toMatchObject({
      id,
      slug: 'serie',
      folderName: 'Serie',
      episodeCount: 1,
      hidden: true,
      renamed: true,
      manual: false,
    });
  });
});

describe('PATCH /api/admin/shows/:id', () => {
  test('renomeia agora e grava o override', async () => {
    const id = createShow('serie', 'Serie');

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/admin/shows/${String(id)}`,
      payload: { name: 'Os Simpsons' },
    });

    expect(response.statusCode).toBe(200);
    expect(store.listShows()[0]?.name).toBe('Os Simpsons');
    expect(store.getShowOverride('serie')?.name).toBe('Os Simpsons');
  });

  test('numero de canal ocupado troca com o ocupante', async () => {
    const first = createShow('a', 'A');
    const second = createShow('b', 'B');
    const channelOfFirst = store.listShows().find((s) => s.id === first)!.channelNumber;

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/admin/shows/${String(second)}`,
      payload: { channelNumber: channelOfFirst },
    });

    expect(response.statusCode).toBe(200);
    expect(store.getShowByChannel(channelOfFirst)?.id).toBe(second);
    // O handler rele a serie DEPOIS da troca: sem isto, o corpo mostraria o
    // numero de canal de antes do swap.
    expect(response.json<AdminShow>().channelNumber).toBe(channelOfFirst);
  });

  test('tipo errado e 400', async () => {
    const id = createShow('serie', 'Serie');

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/admin/shows/${String(id)}`,
      payload: { hidden: 'sim' },
    });

    expect(response.statusCode).toBe(400);
  });

  test('serie inexistente e 404', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/admin/shows/999',
      payload: { hidden: true },
    });

    expect(response.statusCode).toBe(404);
  });
});

describe('POST /api/admin/shows/:id/merge', () => {
  test('funde a fonte no alvo e grava o alias', async () => {
    const target = createShow('serie', 'Serie');
    const source = createShow('serie-extra', 'Serie Extra');

    const response = await app.inject({
      method: 'POST',
      url: `/api/admin/shows/${String(target)}/merge`,
      payload: { sourceIds: [source] },
    });

    expect(response.statusCode).toBe(202);
    expect(store.listShows().map((s) => s.slug)).toEqual(['serie']);
    expect(store.listShowAliases()).toEqual([
      { slug: 'serie-extra', targetSlug: 'serie', createdAt: expect.any(Number) },
    ]);
  });

  test('fundir a serie nela mesma e 400', async () => {
    const target = createShow('serie', 'Serie');

    const response = await app.inject({
      method: 'POST',
      url: `/api/admin/shows/${String(target)}/merge`,
      payload: { sourceIds: [target] },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('PUT /api/admin/shows/:id/metadata', () => {
  test('host fora da lista e 400', async () => {
    const id = createShow('serie', 'Serie');

    const response = await app.inject({
      method: 'PUT',
      url: `/api/admin/shows/${String(id)}/metadata`,
      payload: {
        candidate: { ...CANDIDATE, posterUrl: 'https://169.254.169.254/latest/meta-data/' },
      },
    });

    expect(response.statusCode).toBe(400);
  });

  test('candidato valido responde a serie atualizada', async () => {
    const id = createShow('serie', 'Serie');

    const response = await app.inject({
      method: 'PUT',
      url: `/api/admin/shows/${String(id)}/metadata`,
      payload: { candidate: CANDIDATE },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<AdminShow>().id).toBe(id);
  });
});

describe('GET /api/admin/merge-suggestions', () => {
  test('devolve os grupos de duplicata obvia', async () => {
    const first = createShow('os-simpsons', 'Os Simpsons');
    const second = createShow('os-simpsons-2', 'Os Simpsons');

    const response = await app.inject({ method: 'GET', url: '/api/admin/merge-suggestions' });

    expect(response.statusCode).toBe(200);
    expect(response.json<MergeSuggestion[]>()).toEqual([
      { reason: 'nome-identico', showIds: [first, second] },
    ]);
  });
});

describe('POST /api/admin/shows/:id/unmerge', () => {
  test('solta o alias e dispara o scan', async () => {
    const target = createShow('serie', 'Serie');
    store.addShowAlias('serie-extra', 'serie');

    const response = await app.inject({
      method: 'POST',
      url: `/api/admin/shows/${String(target)}/unmerge`,
      payload: { slug: 'serie-extra' },
    });

    expect(response.statusCode).toBe(202);
    expect(store.listShowAliases()).toEqual([]);
  });

  test('scan ja rodando devolve 409, nao 202 mentiroso', async () => {
    const target = createShow('serie', 'Serie');
    store.addShowAlias('serie-extra', 'serie');
    scanResult = { started: false, reason: 'scan ja esta em andamento' };

    const response = await app.inject({
      method: 'POST',
      url: `/api/admin/shows/${String(target)}/unmerge`,
      payload: { slug: 'serie-extra' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json<TaskAccepted>()).toEqual(scanResult);
  });
});

describe('GET /api/admin/shows/:id/metadata/search', () => {
  test('busca pelo termo enviado em q', async () => {
    const id = createShow('serie', 'Serie');

    const response = await app.inject({
      method: 'GET',
      url: `/api/admin/shows/${String(id)}/metadata/search?q=${encodeURIComponent('Outro Termo')}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<MetadataCandidate[]>()).toEqual([CANDIDATE]);
    expect(searchTerms).toEqual(['Outro Termo']);
  });

  test('sem q, cai no nome da serie', async () => {
    const id = createShow('serie', 'Serie');

    const response = await app.inject({
      method: 'GET',
      url: `/api/admin/shows/${String(id)}/metadata/search`,
    });

    expect(response.statusCode).toBe(200);
    expect(searchTerms).toEqual(['Serie']);
  });

  test('q repetido e 400, nunca 500', async () => {
    const id = createShow('serie', 'Serie');

    const response = await app.inject({
      method: 'GET',
      url: `/api/admin/shows/${String(id)}/metadata/search?q=a&q=b`,
    });

    expect(response.statusCode).toBe(400);
    expect(searchTerms).toEqual([]);
  });
});

describe('DELETE /api/admin/shows/:id/metadata', () => {
  test('chama clearMetadata para a serie certa e responde 202', async () => {
    const id = createShow('serie', 'Serie');

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/admin/shows/${String(id)}/metadata`,
    });

    expect(response.statusCode).toBe(202);
    expect(clearedShows.map((show) => show.id)).toEqual([id]);
  });
});
