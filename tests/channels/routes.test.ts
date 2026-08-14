import Fastify, { type FastifyInstance } from 'fastify';
import { beforeAll, afterAll, describe, expect, test } from 'vitest';

import type { EpisodeRow, ShowRow } from '../../src/server/library/index-store';
import { registerChannelRoutes } from '../../src/server/channels/routes';
import type { ChannelSource } from '../../src/server/channels/service';
import type { ChannelSummary, EpisodeRef, NowPlaying } from '../../src/shared/api-types';

const EPOCH = Date.parse('2024-01-01T00:00:00Z');
const MIN = 60_000;

const SHOWS: ShowRow[] = [
  { id: 1, slug: 'thundercats', name: 'ThunderCats', channelNumber: 7, absolutePath: '/lib/tc' },
  { id: 2, slug: 'vazia', name: 'Vazia', channelNumber: 9, absolutePath: '/lib/v' },
];

const EPISODES: EpisodeRow[] = [1, 2].map((n) => ({
  id: `tc/ep${n}`,
  showId: 1,
  absolutePath: `/lib/tc/ep${n}.mp4`,
  title: `Episodio ${n}`,
  season: 1,
  episode: n,
  orderIndex: n - 1,
  durationMs: 22 * MIN,
  videoCodec: 'av1',
  audioCodec: 'aac',
  width: 640,
  height: 480,
  faststart: true,
  audioTracks: [{ index: 0, lang: 'por', title: null, codec: 'eac3', isDefault: true }],
  subtitleTracks: [
    { index: 0, lang: 'por', title: null, codec: 'subrip', isDefault: true, forced: false },
  ],
  mtimeMs: 0,
  size: 1,
}));

const SOURCE: ChannelSource = {
  listShows: () => SHOWS,
  getShowByChannel: (n) => SHOWS.find((s) => s.channelNumber === n) ?? null,
  listEpisodes: (showId) => (showId === 1 ? EPISODES : []),
};

let app: FastifyInstance;
let agora = EPOCH;

beforeAll(async () => {
  app = Fastify();
  registerChannelRoutes(app, { source: SOURCE, epochMs: EPOCH, now: () => agora });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('GET /api/channels', () => {
  test('lista os canais com episodio', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/channels' });
    expect(r.statusCode).toBe(200);
    const body = r.json<ChannelSummary[]>();
    expect(body).toEqual([{ number: 7, name: 'ThunderCats', episodeCount: 2 }]);
  });
});

describe('GET /api/channels/:number/now', () => {
  test('devolve o que esta no ar', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/channels/7/now' });
    expect(r.statusCode).toBe(200);
    const body = r.json<NowPlaying>();
    expect(body.channel.number).toBe(7);
    expect(body.episode.durationMs).toBe(22 * MIN);
    expect(body.serverTimeMs).toBe(EPOCH);
  });

  test('acompanha o relogio entre duas chamadas', async () => {
    agora = EPOCH;
    const a = (await app.inject({ url: '/api/channels/7/now' })).json<NowPlaying>();
    agora = EPOCH + 4 * MIN;
    const b = (await app.inject({ url: '/api/channels/7/now' })).json<NowPlaying>();
    agora = EPOCH;
    expect(b.serverTimeMs - a.serverTimeMs).toBe(4 * MIN);
  });

  test('resposta nunca e cacheada: cache aqui congelaria a grade', async () => {
    const r = await app.inject({ url: '/api/channels/7/now' });
    expect(r.headers['cache-control']).toMatch(/no-store/);
  });

  test('canal inexistente devolve 404', async () => {
    const r = await app.inject({ url: '/api/channels/42/now' });
    expect(r.statusCode).toBe(404);
  });

  test('canal sem episodio devolve 404', async () => {
    const r = await app.inject({ url: '/api/channels/9/now' });
    expect(r.statusCode).toBe(404);
  });

  test('numero de canal nao numerico devolve 400', async () => {
    const r = await app.inject({ url: '/api/channels/abc/now' });
    expect(r.statusCode).toBe(400);
  });

  test('numero negativo devolve 400', async () => {
    const r = await app.inject({ url: '/api/channels/-1/now' });
    expect(r.statusCode).toBe(400);
  });
});

describe('GET /api/channels/:number/episodes', () => {
  test('canal 7 devolve os episodios na ordem, com width/height', async () => {
    const r = await app.inject({ url: '/api/channels/7/episodes' });
    expect(r.statusCode).toBe(200);
    const body = r.json<EpisodeRef[]>();
    expect(body.map((e) => e.id)).toEqual(['tc/ep1', 'tc/ep2']);
    expect(body[0]!.width).toBe(640);
    expect(body[0]!.height).toBe(480);
  });

  test('canal inexistente devolve 404', async () => {
    const r = await app.inject({ url: '/api/channels/42/episodes' });
    expect(r.statusCode).toBe(404);
  });

  test('canal 9 (Vazia, sem episodios) devolve 200 com lista vazia', async () => {
    const r = await app.inject({ url: '/api/channels/9/episodes' });
    expect(r.statusCode).toBe(200);
    expect(r.json<EpisodeRef[]>()).toEqual([]);
  });

  test('numero de canal nao numerico devolve 400', async () => {
    const r = await app.inject({ url: '/api/channels/abc/episodes' });
    expect(r.statusCode).toBe(400);
  });

  test('numero negativo devolve 400', async () => {
    const r = await app.inject({ url: '/api/channels/-1/episodes' });
    expect(r.statusCode).toBe(400);
  });

  test('resposta nunca e cacheada', async () => {
    const r = await app.inject({ url: '/api/channels/7/episodes' });
    expect(r.headers['cache-control']).toMatch(/no-store/);
  });
});
