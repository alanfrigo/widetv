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
  thumbFile: null,
  thumbCheckedAt: null,
}));

/** Metadata por showId; os testes de arte mexem neste mapa. */
const METADATA = new Map<number, ShowMetadataRow>();

/** Sobe a cada mudanca simulada no indice, como o contador do Store. */
let versaoDoIndice = 1;

const SOURCE: ChannelSource = {
  // Nenhum teste aqui exercita curadoria: nada oculto, entao o catalogo
  // publico e o acervo inteiro.
  listVisibleShows: () => SHOWS,
  getShowByChannel: (n) => SHOWS.find((s) => s.channelNumber === n) ?? null,
  listEpisodes: (showId) => (showId === 1 ? EPISODES : []),
  // Como o GROUP BY do Store: o canal 9 ("Vazia") nao aparece no mapa.
  countEpisodesByShow: () => new Map([[1, EPISODES.length]]),
  listSeasons: (showId) => (showId === 1 ? [1] : []),
  listSeasonsByShow: () => new Map([[1, [1]]]),
  getShowMetadata: (showId) => METADATA.get(showId) ?? null,
  hasShowsWithoutMetadata: () => SHOWS.some((s) => !METADATA.has(s.id)),
  indexVersion: () => versaoDoIndice,
};

/** Linha de metadata completa; o teste sobrescreve o que importa. */
function metadataRow(showId: number, over: Partial<ShowMetadataRow> = {}): ShowMetadataRow {
  return {
    showId,
    posterFile: `${String(showId)}.jpg`,
    backdropFile: `${String(showId)}.jpg`,
    backdropCheckedAt: null,
    backdropSource: null,
    year: 1985,
    overview: 'Sinopse.',
    source: 'tvmaze',
    fetchedAt: EPOCH,
    notFound: false,
    manual: false,
    ...over,
  };
}

let app: FastifyInstance;
let agora = EPOCH;
let dataDir: string;
let disparos = 0;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'widetv-poster-'));
  await mkdir(join(dataDir, 'posters'), { recursive: true });
  await mkdir(join(dataDir, 'backdrops'), { recursive: true });
  // JPEG de mentira: a rota entrega bytes, nao decodifica imagem.
  await writeFile(join(dataDir, 'posters', '1.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  await writeFile(join(dataDir, 'backdrops', '1.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

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
        backdropUrl: null,
        year: null,
        overview: null,
        seasons: [1],
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
      METADATA.set(show.id, metadataRow(show.id));
    }
    disparos = 0;
    const r = await app.inject({ method: 'GET', url: '/api/channels' });
    expect(disparos).toBe(0);
    const canal = r.json<ChannelSummary[]>()[0]!;
    expect(canal.posterUrl).toBe(`/api/channels/7/poster?v=${String(EPOCH)}`);
    expect(canal.backdropUrl).toBe(`/api/channels/7/backdrop?v=${String(EPOCH)}`);
    METADATA.clear();
  });
});

describe('GET /api/channels/:number/poster', () => {
  test('serve a capa em jpeg quando o arquivo existe', async () => {
    METADATA.set(1, metadataRow(1, { posterFile: '1.jpg', overview: null }));

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
    METADATA.set(
      1,
      metadataRow(1, {
        posterFile: null,
        backdropFile: null,
        backdropCheckedAt: null,
        backdropSource: null,
        year: null,
        overview: null,
        source: null,
        notFound: true,
      }),
    );
    const r = await app.inject({ url: '/api/channels/7/poster' });
    expect(r.statusCode).toBe(404);
    METADATA.clear();
  });

  test('linha no indice com arquivo sumido do volume devolve 404, nao 500', async () => {
    METADATA.set(2, metadataRow(2, { year: null, overview: null }));
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

describe('GET /api/channels/:number/backdrop', () => {
  test('serve a arte 16:9 em jpeg quando o arquivo existe', async () => {
    METADATA.set(1, metadataRow(1, { backdropFile: '1.jpg' }));

    const r = await app.inject({ url: '/api/channels/7/backdrop' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('image/jpeg');
    expect(r.headers['cache-control']).toBe('private, max-age=86400');
    expect(r.rawPayload.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    METADATA.clear();
  });

  test('canal sem metadata devolve 404 "canal sem arte"', async () => {
    METADATA.clear();
    const r = await app.inject({ url: '/api/channels/7/backdrop' });
    expect(r.statusCode).toBe(404);
    expect(r.json<{ error: string }>().error).toBe('canal sem arte');
  });

  test('serie com capa mas sem arte 16:9 devolve 404 sem afetar a capa', async () => {
    // O caso comum: TVMaze e iTunes nao tem arte 16:9.
    METADATA.set(1, metadataRow(1, { backdropFile: null }));
    expect((await app.inject({ url: '/api/channels/7/backdrop' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/channels/7/poster' })).statusCode).toBe(200);
    METADATA.clear();
  });

  test('linha no indice com arquivo sumido do volume devolve 404, nao 500', async () => {
    METADATA.set(2, metadataRow(2));
    const r = await app.inject({ url: '/api/channels/9/backdrop' });
    expect(r.statusCode).toBe(404);
    METADATA.clear();
  });

  test('canal inexistente devolve 404', async () => {
    const r = await app.inject({ url: '/api/channels/42/backdrop' });
    expect(r.statusCode).toBe(404);
    expect(r.json<{ error: string }>().error).toBe('canal inexistente');
  });

  test('numero de canal nao numerico devolve 400', async () => {
    const r = await app.inject({ url: '/api/channels/abc/backdrop' });
    expect(r.statusCode).toBe(400);
  });
});

describe('GET /api/now', () => {
  test('devolve um item por canal, na mesma ordem de /api/channels', async () => {
    METADATA.clear();
    const canais = (await app.inject({ url: '/api/channels' })).json<ChannelSummary[]>();
    const agora = (await app.inject({ url: '/api/now' })).json<NowPlaying[]>();

    expect(agora.map((n) => n.channel.number)).toEqual(canais.map((c) => c.number));
  });

  test('canal sem episodio some do array em vez de virar null', async () => {
    const agora = (await app.inject({ url: '/api/now' })).json<NowPlaying[]>();
    // O canal 9 ("Vazia") existe no indice e nao tem episodio.
    expect(agora.map((n) => n.channel.number)).not.toContain(9);
    expect(agora.every((n) => n !== null)).toBe(true);
  });

  test('no mesmo instante, bate episodio por episodio com /api/channels/:n/now', async () => {
    // Se a conta divergir, a faixa "No ar agora" mostra um episodio e o player
    // abre outro.
    agora = EPOCH + 37 * MIN;
    const lista = (await app.inject({ url: '/api/now' })).json<NowPlaying[]>();
    for (const item of lista) {
      const um = (
        await app.inject({ url: `/api/channels/${String(item.channel.number)}/now` })
      ).json<NowPlaying>();
      expect(um.episode.id).toBe(item.episode.id);
      expect(um.offsetMs).toBe(item.offsetMs);
      expect(um.next.id).toBe(item.next.id);
    }
    agora = EPOCH;
  });

  test('resposta nunca e cacheada', async () => {
    const r = await app.inject({ url: '/api/now' });
    expect(r.headers['cache-control']).toMatch(/no-store/);
  });

  test('acompanha o relogio mesmo servindo a grade do cache', async () => {
    agora = EPOCH;
    const a = (await app.inject({ url: '/api/now' })).json<NowPlaying[]>();
    agora = EPOCH + 5 * MIN;
    const b = (await app.inject({ url: '/api/now' })).json<NowPlaying[]>();
    agora = EPOCH;
    expect(b[0]!.offsetMs - a[0]!.offsetMs).toBe(5 * MIN);
  });

  test('a capa entra na resposta assim que a busca grava, sem esperar rescan', async () => {
    // A metadata chega pela rede DEPOIS do scan: cachea-la junto com a grade
    // seguraria a capa ate o proximo rescan.
    METADATA.clear();
    expect((await app.inject({ url: '/api/now' })).json<NowPlaying[]>()[0]!.channel.posterUrl).toBeNull();

    METADATA.set(1, metadataRow(1));
    const depois = (await app.inject({ url: '/api/now' })).json<NowPlaying[]>();
    expect(depois[0]!.channel.posterUrl).toBe(`/api/channels/7/poster?v=${String(EPOCH)}`);
    expect(depois[0]!.channel.backdropUrl).toBe(`/api/channels/7/backdrop?v=${String(EPOCH)}`);
    METADATA.clear();
  });

  test('grade nova depois de um rescan: o cache nao segura a lista antiga', async () => {
    const antes = (await app.inject({ url: '/api/now' })).json<NowPlaying[]>();
    expect(antes[0]!.channel.episodeCount).toBe(2);

    EPISODES.push({ ...EPISODES[0]!, id: 'tc/ep3', title: 'Episodio 3', episode: 3, orderIndex: 2 });
    versaoDoIndice += 1;

    const depois = (await app.inject({ url: '/api/now' })).json<NowPlaying[]>();
    expect(depois[0]!.channel.episodeCount).toBe(3);

    EPISODES.pop();
    versaoDoIndice += 1;
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
