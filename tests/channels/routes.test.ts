import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import { beforeAll, afterAll, describe, expect, test } from 'vitest';

import type {
  EpisodeRow,
  ShowMetadataRow,
  ShowRow,
} from '../../src/server/library/index-store';
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

/** Metadata por showId; os testes de capa mexem neste mapa. */
const METADATA = new Map<number, ShowMetadataRow>();

const SOURCE: ChannelSource = {
  listShows: () => SHOWS,
  getShowByChannel: (n) => SHOWS.find((s) => s.channelNumber === n) ?? null,
  listEpisodes: (showId) => (showId === 1 ? EPISODES : []),
  getShowMetadata: (showId) => METADATA.get(showId) ?? null,
};

let app: FastifyInstance;
let agora = EPOCH;
let dataDir: string;
let disparos = 0;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'widetv-poster-'));
  await mkdir(join(dataDir, 'posters'), { recursive: true });
  // JPEG de mentira: a rota entrega bytes, nao decodifica imagem.
  await writeFile(join(dataDir, 'posters', '1.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

  app = Fastify();
  registerChannelRoutes(app, {
    source: SOURCE,
    epochMs: EPOCH,
    now: () => agora,
    dataDir,
    onMetadataMissing: () => {
      disparos += 1;
    },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe('GET /api/channels', () => {
  test('lista os canais com episodio', async () => {
    METADATA.clear();
    const r = await app.inject({ method: 'GET', url: '/api/channels' });
    expect(r.statusCode).toBe(200);
    const body = r.json<ChannelSummary[]>();
    expect(body).toEqual([
      {
        number: 7,
        name: 'ThunderCats',
        episodeCount: 2,
        posterUrl: null,
        year: null,
        overview: null,
      },
    ]);
  });

  test('serie sem metadata dispara o enriquecimento, sem a resposta esperar por ele', async () => {
    METADATA.clear();
    disparos = 0;
    const r = await app.inject({ method: 'GET', url: '/api/channels' });
    expect(r.statusCode).toBe(200);
    expect(disparos).toBe(1);
  });

  test('com todo mundo ja buscado, nao dispara nada', async () => {
    METADATA.clear();
    for (const show of SHOWS) {
      METADATA.set(show.id, {
        showId: show.id,
        posterFile: `${show.id}.jpg`,
        year: 1985,
        overview: 'Sinopse.',
        source: 'tvmaze',
        fetchedAt: EPOCH,
        notFound: false,
      });
    }
    disparos = 0;
    const r = await app.inject({ method: 'GET', url: '/api/channels' });
    expect(disparos).toBe(0);
    expect(r.json<ChannelSummary[]>()[0]!.posterUrl).toBe('/api/channels/7/poster');
    METADATA.clear();
  });
});

describe('GET /api/channels/:number/poster', () => {
  test('serve a capa em jpeg quando o arquivo existe', async () => {
    METADATA.set(1, {
      showId: 1,
      posterFile: '1.jpg',
      year: 1985,
      overview: null,
      source: 'tvmaze',
      fetchedAt: EPOCH,
      notFound: false,
    });

    const r = await app.inject({ url: '/api/channels/7/poster' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('image/jpeg');
    expect(r.headers['cache-control']).toBe('private, max-age=86400');
    expect(r.rawPayload.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    METADATA.clear();
  });

  test('canal sem metadata devolve 404', async () => {
    METADATA.clear();
    const r = await app.inject({ url: '/api/channels/7/poster' });
    expect(r.statusCode).toBe(404);
  });

  test('metadata sem arquivo de capa devolve 404', async () => {
    METADATA.set(1, {
      showId: 1,
      posterFile: null,
      year: null,
      overview: null,
      source: null,
      fetchedAt: EPOCH,
      notFound: true,
    });
    const r = await app.inject({ url: '/api/channels/7/poster' });
    expect(r.statusCode).toBe(404);
    METADATA.clear();
  });

  test('linha no indice com arquivo sumido do volume devolve 404, nao 500', async () => {
    METADATA.set(2, {
      showId: 2,
      posterFile: '2.jpg',
      year: null,
      overview: null,
      source: 'tvmaze',
      fetchedAt: EPOCH,
      notFound: false,
    });
    const r = await app.inject({ url: '/api/channels/9/poster' });
    expect(r.statusCode).toBe(404);
    METADATA.clear();
  });

  test('canal inexistente devolve 404', async () => {
    const r = await app.inject({ url: '/api/channels/42/poster' });
    expect(r.statusCode).toBe(404);
  });

  test('numero de canal nao numerico devolve 400', async () => {
    const r = await app.inject({ url: '/api/channels/abc/poster' });
    expect(r.statusCode).toBe(400);
  });

  test('numero negativo devolve 400', async () => {
    const r = await app.inject({ url: '/api/channels/-1/poster' });
    expect(r.statusCode).toBe(400);
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
