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
/**
 * Canal de cada episodio. Existe porque a faixa de retomada deduplica por
 * SERIE: sem isto, todo episodio do teste cairia no mesmo canal e a lista
 * inteira colapsaria num card so.
 */
let channelOf: Map<string, number>;
/** Proximo canal livre do helper `watched`. */
let nextChannel: number;
let metadata: ShowMetadataRow | null;
let app: FastifyInstance;

const source: HistorySource = {
  getEpisode: (id) => episodes.get(id) ?? null,
  // Uma serie por canal, sintetizada: o `id` acompanha o numero, que e por onde
  // a faixa de retomada reconhece "outra serie".
  getShowByChannel: (channelNumber) =>
    channelNumber === SHOW.channelNumber
      ? SHOW
      : { ...SHOW, id: channelNumber, slug: `serie-${String(channelNumber)}`, channelNumber },
  getShowMetadata: () => metadata,
  getWatchHistory: (id) => rows.get(id) ?? null,
  upsertWatchHistory: (row) => {
    rows.set(row.episodeId, row);
  },
  deleteWatchHistory: (id) => {
    rows.delete(id);
  },
  clearWatchHistory: () => {
    rows.clear();
  },
  listWatchHistory: (limit) =>
    [...rows.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit)
      .map(
        (row): WatchHistoryEntry => ({
          ...row,
          channelNumber: channelOf.get(row.episodeId) ?? SHOW.channelNumber,
        }),
      ),
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
  channelOf = new Map();
  nextChannel = 100;
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
      watchedAt: null,
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

  test('posicao dentro dos creditos finais MARCA como visto e zera a posicao', async () => {
    rows.set(EP, { episodeId: EP, positionMs: 1, durationMs: 2, updatedAt: 1, watchedAt: null });
    const r = await app.inject({
      method: 'PUT',
      url: EP_URL,
      // 96% de 1.320.000: passou dos 95%.
      payload: { positionMs: 1_267_200, durationMs: 1_320_000 },
    });
    expect(r.statusCode).toBe(204);
    // A linha SOBREVIVE: e ela que responde "ja vi este" na lista de episodios.
    expect(rows.get(EP)).toEqual({
      episodeId: EP,
      positionMs: 0,
      durationMs: 1_320_000,
      updatedAt: 1234,
      watchedAt: 1234,
    });
  });

  test('voltar ao meio do episodio desmarca: rever e assistir de novo', async () => {
    rows.set(EP, {
      episodeId: EP,
      positionMs: 0,
      durationMs: 1_320_000,
      updatedAt: 1,
      watchedAt: 1,
    });
    const r = await app.inject({
      method: 'PUT',
      url: EP_URL,
      payload: { positionMs: 300_000, durationMs: 1_320_000 },
    });
    expect(r.statusCode).toBe(204);
    expect(rows.get(EP)?.watchedAt).toBeNull();
  });

  test('marcar na mao grava sem posicao, usando a duracao do indice', async () => {
    const r = await app.inject({ method: 'PUT', url: EP_URL, payload: { watched: true } });
    expect(r.statusCode).toBe(204);
    expect(rows.get(EP)).toEqual({
      episodeId: EP,
      positionMs: 0,
      durationMs: 1_320_000,
      updatedAt: 1234,
      watchedAt: 1234,
    });
  });

  test('desmarcar APAGA a linha: e o que "nunca vi isto" significa', async () => {
    rows.set(EP, {
      episodeId: EP,
      positionMs: 0,
      durationMs: 2,
      updatedAt: 1,
      watchedAt: 1,
    });
    const r = await app.inject({ method: 'PUT', url: EP_URL, payload: { watched: false } });
    expect(r.statusCode).toBe(204);
    expect(rows.has(EP)).toBe(false);
  });

  test('watched que nao e booleano devolve 400', async () => {
    const r = await app.inject({ method: 'PUT', url: EP_URL, payload: { watched: 'sim' } });
    expect(r.statusCode).toBe(400);
    expect(rows.size).toBe(0);
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
    rows.set(EP, {
      episodeId: EP,
      positionMs: 5000,
      durationMs: 10_000,
      updatedAt: 9,
      watchedAt: null,
    });
    const r = await app.inject({ method: 'GET', url: '/api/history' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(r.body)).toEqual([
      {
        episodeId: EP,
        channelNumber: 7,
        positionMs: 5000,
        durationMs: 10_000,
        updatedAt: 9,
        watchedAt: null,
      },
    ]);
  });
});

describe('DELETE /api/history', () => {
  test('apaga uma entrada', async () => {
    watched(EP, 5);
    const r = await app.inject({ method: 'DELETE', url: EP_URL });
    expect(r.statusCode).toBe(204);
    expect(rows.has(EP)).toBe(false);
  });

  test('apagar o que ja nao existe tambem e 204: o resultado pedido foi entregue', async () => {
    const r = await app.inject({ method: 'DELETE', url: '/api/history/nunca-visto' });
    expect(r.statusCode).toBe(204);
  });

  test('sem id, limpa o historico inteiro', async () => {
    watched('a.mkv', 10);
    watched('b.mkv', 20);
    const r = await app.inject({ method: 'DELETE', url: '/api/history' });
    expect(r.statusCode).toBe(204);
    expect(rows.size).toBe(0);
  });
});

/**
 * Grava progresso em `id` no instante `updatedAt`, criando o episodio.
 *
 * Cada chamada cai num canal NOVO por padrao: a faixa de retomada mostra um card
 * por serie, e reusar o mesmo canal esconderia todos menos o primeiro. Quem quer
 * testar a deduplicacao passa o canal na mao.
 */
function watched(id: string, updatedAt: number, channelNumber = nextChannel++): void {
  episodes.set(id, episode(id));
  channelOf.set(id, channelNumber);
  rows.set(id, {
    episodeId: id,
    positionMs: 5000,
    durationMs: 1_320_000,
    updatedAt,
    watchedAt: null,
  });
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
      manual: false,
    };
    rows.set(EP, {
      episodeId: EP,
      positionMs: 600_000,
      durationMs: 1_320_000,
      updatedAt: 9,
      watchedAt: null,
    });

    const r = await app.inject({ url: '/api/history/resume' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');

    const lista = r.json<ResumeEntry[]>();
    expect(lista).toHaveLength(1);
    expect(lista[0]).toMatchObject({
      channelNumber: 7,
      channelName: 'Serie',
      posterUrl: '/api/channels/7/poster?v=1',
      backdropUrl: '/api/channels/7/backdrop?v=1',
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
        'playback',
        'season',
        'subtitleTracks',
        'thumbUrl',
        'title',
        'width',
      ].sort(),
    );
  });

  test('serie sem metadata devolve as artes como null, nao como undefined', async () => {
    rows.set(EP, {
      episodeId: EP,
      positionMs: 1,
      durationMs: 2,
      updatedAt: 9,
      watchedAt: null,
    });
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

  test('episodio ja visto nao aparece: "continuar" exclui o que acabou', async () => {
    watched('visto.mkv', 30);
    rows.get('visto.mkv')!.watchedAt = 31;
    watched('parado.mkv', 10);

    const lista = (await app.inject({ url: '/api/history/resume' })).json<ResumeEntry[]>();
    expect(lista.map((e) => e.episode.id)).toEqual(['parado.mkv']);
  });

  test('uma serie ocupa UM card: a maratona de sabado nao engole a faixa', async () => {
    const MESMA = 42;
    watched('ep01.mkv', 10, MESMA);
    watched('ep02.mkv', 20, MESMA);
    watched('ep03.mkv', 30, MESMA);
    watched('outra.mkv', 5);

    const lista = (await app.inject({ url: '/api/history/resume' })).json<ResumeEntry[]>();
    // O card da serie e o episodio MAIS RECENTE dela, e nao o primeiro gravado.
    expect(lista.map((e) => e.episode.id)).toEqual(['ep03.mkv', 'outra.mkv']);
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
