import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import type {
  EpisodeRow,
  ShowMetadataRow,
  ShowRow,
  WatchHistoryEntry,
  WatchHistoryRow,
} from '../../src/server/library/index-store';
import { registerHistoryRoutes, type HistorySource } from '../../src/server/history/routes';
import type { ResumeEntry } from '../../src/shared/api-types';

const EP = 'Serie/ep 01.mkv';
const EP_URL = `/api/history/${encodeURIComponent(EP)}`;

const SHOW: ShowRow = {
  id: 1,
  slug: 'serie',
  name: 'Serie',
  channelNumber: 7,
  absolutePath: '/lib/serie',
};

/** Episodio completo; os testes de retomada so olham para o `EpisodeRef`. */
function episode(id: string): EpisodeRow {
  return {
    id,
    showId: 1,
    absolutePath: `/lib/${id}`,
    title: id,
    season: 1,
    episode: 1,
    orderIndex: 0,
    durationMs: 1_320_000,
    videoCodec: 'h264',
    audioCodec: 'aac',
    width: 1920,
    height: 1080,
    faststart: true,
    audioTracks: [],
    subtitleTracks: [],
    mtimeMs: 0,
    size: 1,
    thumbFile: null,
    thumbCheckedAt: null,
  };
}

let rows: Map<string, WatchHistoryRow>;
/** Episodios que o indice conhece; um rescan que apaga arquivo mexe aqui. */
let episodes: Map<string, EpisodeRow>;
let metadata: ShowMetadataRow | null;
let app: FastifyInstance;

const source: HistorySource = {
  getEpisode: (id) => episodes.get(id) ?? null,
  getShowByChannel: (channelNumber) => (channelNumber === SHOW.channelNumber ? SHOW : null),
  getShowMetadata: () => metadata,
  getWatchHistory: (id) => rows.get(id) ?? null,
  upsertWatchHistory: (row) => {
    rows.set(row.episodeId, row);
  },
  deleteWatchHistory: (id) => {
    rows.delete(id);
  },
  listWatchHistory: (limit) =>
    [...rows.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit)
      .map((row): WatchHistoryEntry => ({ ...row, channelNumber: 7 })),
};

beforeAll(async () => {
  app = Fastify({ maxParamLength: 2048 });
  registerHistoryRoutes(app, { source, now: () => 1234 });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  rows = new Map();
  episodes = new Map([[EP, episode(EP)]]);
  metadata = null;
});

describe('PUT /api/history/:id', () => {
  test('grava a posicao com o relogio do servidor', async () => {
    const r = await app.inject({
      method: 'PUT',
      url: EP_URL,
      payload: { positionMs: 600_000, durationMs: 1_320_000 },
    });
    expect(r.statusCode).toBe(204);
    expect(rows.get(EP)).toEqual({
      episodeId: EP,
      positionMs: 600_000,
      durationMs: 1_320_000,
      updatedAt: 1234,
    });
  });

  test('POST faz o mesmo: e o verbo do sendBeacon na saida da pagina', async () => {
    const r = await app.inject({
      method: 'POST',
      url: EP_URL,
      payload: { positionMs: 1000, durationMs: 1_320_000 },
    });
    expect(r.statusCode).toBe(204);
    expect(rows.has(EP)).toBe(true);
  });

  test('posicao dentro dos creditos finais APAGA o progresso', async () => {
    rows.set(EP, { episodeId: EP, positionMs: 1, durationMs: 2, updatedAt: 1 });
    const r = await app.inject({
      method: 'PUT',
      url: EP_URL,
      // 96% de 1.320.000: passou dos 95%.
      payload: { positionMs: 1_267_200, durationMs: 1_320_000 },
    });
    expect(r.statusCode).toBe(204);
    expect(rows.has(EP)).toBe(false);
  });

  test('episodio fora do indice devolve 404 sem gravar', async () => {
    const r = await app.inject({
      method: 'PUT',
      url: '/api/history/outro',
      payload: { positionMs: 1, durationMs: 2 },
    });
    expect(r.statusCode).toBe(404);
    expect(rows.size).toBe(0);
  });

  test('corpo torto devolve 400: NaN, negativo, duracao zero, campo faltando', async () => {
    for (const payload of [
      { positionMs: -1, durationMs: 10 },
      { positionMs: 1, durationMs: 0 },
      { positionMs: 'dez', durationMs: 10 },
      { durationMs: 10 },
      {},
    ]) {
      const r = await app.inject({ method: 'PUT', url: EP_URL, payload });
      expect(r.statusCode).toBe(400);
    }
    expect(rows.size).toBe(0);
  });
});

describe('GET /api/history', () => {
  test('devolve as entradas com canal, sem cache', async () => {
    rows.set(EP, { episodeId: EP, positionMs: 5000, durationMs: 10_000, updatedAt: 9 });
    const r = await app.inject({ method: 'GET', url: '/api/history' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(r.body)).toEqual([
      { episodeId: EP, channelNumber: 7, positionMs: 5000, durationMs: 10_000, updatedAt: 9 },
    ]);
  });
});

/** Grava progresso em `id` no instante `updatedAt`, criando o episodio. */
function watched(id: string, updatedAt: number): void {
  episodes.set(id, episode(id));
  rows.set(id, { episodeId: id, positionMs: 5000, durationMs: 1_320_000, updatedAt });
}

describe('GET /api/history/resume', () => {
  test('entrega a linha pronta: canal, capa, arte e episodio', async () => {
    metadata = {
      showId: 1,
      posterFile: '1.jpg',
      backdropFile: '1.jpg',
      backdropCheckedAt: null,
      backdropSource: null,
      year: 1985,
      overview: null,
      source: 'tmdb',
      fetchedAt: 1,
      notFound: false,
    };
    rows.set(EP, { episodeId: EP, positionMs: 600_000, durationMs: 1_320_000, updatedAt: 9 });

    const r = await app.inject({ url: '/api/history/resume' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');

    const lista = r.json<ResumeEntry[]>();
    expect(lista).toHaveLength(1);
    expect(lista[0]).toMatchObject({
      channelNumber: 7,
      channelName: 'Serie',
      posterUrl: '/api/channels/7/poster',
      backdropUrl: '/api/channels/7/backdrop',
      positionMs: 600_000,
      durationMs: 1_320_000,
      updatedAt: 9,
    });
    // O episodio vem no formato do contrato publico, sem os campos de disco.
    expect(Object.keys(lista[0]!.episode).sort()).toEqual(
      [
        'audioTracks',
        'durationMs',
        'episode',
        'height',
        'id',
        'season',
        'subtitleTracks',
        'thumbUrl',
        'title',
        'width',
      ].sort(),
    );
  });

  test('serie sem metadata devolve as artes como null, nao como undefined', async () => {
    rows.set(EP, { episodeId: EP, positionMs: 1, durationMs: 2, updatedAt: 9 });
    const lista = (await app.inject({ url: '/api/history/resume' })).json<ResumeEntry[]>();
    expect(lista[0]!.posterUrl).toBeNull();
    expect(lista[0]!.backdropUrl).toBeNull();
  });

  test('vem ordenado por updatedAt desc', async () => {
    watched('a.mkv', 10);
    watched('b.mkv', 30);
    watched('c.mkv', 20);

    const lista = (await app.inject({ url: '/api/history/resume' })).json<ResumeEntry[]>();
    expect(lista.map((e) => e.episode.id)).toEqual(['b.mkv', 'c.mkv', 'a.mkv']);
  });

  test('no maximo 20 entradas, as mais recentes', async () => {
    for (let i = 0; i < 30; i += 1) watched(`ep${String(i)}.mkv`, i);

    const lista = (await app.inject({ url: '/api/history/resume' })).json<ResumeEntry[]>();
    expect(lista).toHaveLength(20);
    expect(lista[0]!.episode.id).toBe('ep29.mkv');
    expect(lista[19]!.episode.id).toBe('ep10.mkv');
  });

  test('entrada cujo episodio sumiu num rescan e OMITIDA, nao devolvida com nulos', async () => {
    watched('vivo.mkv', 20);
    watched('apagado.mkv', 10);
    episodes.delete('apagado.mkv');

    const lista = (await app.inject({ url: '/api/history/resume' })).json<ResumeEntry[]>();
    expect(lista.map((e) => e.episode.id)).toEqual(['vivo.mkv']);
  });

  test('entrada cujo canal sumiu num rescan tambem e omitida', async () => {
    watched('orfao.mkv', 10);
    // Mesmo com o episodio ainda no indice, o canal foi embora.
    const semCanal = { ...source, getShowByChannel: () => null };
    const isolado = Fastify({ maxParamLength: 2048 });
    registerHistoryRoutes(isolado, { source: semCanal, now: () => 1234 });
    await isolado.ready();

    expect((await isolado.inject({ url: '/api/history/resume' })).json<ResumeEntry[]>()).toEqual([]);
    await isolado.close();
  });

  test('historico vazio devolve lista vazia, nao 404', async () => {
    const r = await app.inject({ url: '/api/history/resume' });
    expect(r.statusCode).toBe(200);
    expect(r.json<ResumeEntry[]>()).toEqual([]);
  });

  test('a rota nao colide com o PUT de progresso de um episodio chamado "resume"', async () => {
    watched('resume', 5);
    const r = await app.inject({
      method: 'PUT',
      url: '/api/history/resume',
      payload: { positionMs: 1, durationMs: 1_320_000 },
    });
    expect(r.statusCode).toBe(204);
    expect((await app.inject({ url: '/api/history/resume' })).statusCode).toBe(200);
  });
});
