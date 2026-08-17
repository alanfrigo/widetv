import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { registerChannelRoutes } from '../../src/server/channels/routes';
import type { ChannelSource } from '../../src/server/channels/service';
import { openStore, type EpisodeInput, type Store } from '../../src/server/library/index-store';
import type { ChannelSummary, NowPlaying } from '../../src/shared/api-types';

/**
 * O que este teste protege: `GET /api/channels` nao pode voltar a fazer
 * trabalho POR SERIE que dependa de carregar episodio.
 *
 * O acervo de verdade tem ~460 series e ~14 mil episodios, e o catalogo abre
 * disparando esta rota junto com `/api/now` e `/api/history/resume`. Contar
 * episodios com `listEpisodes(id).length` materializava as 14 mil linhas (com
 * JSON.parse de trilhas em cada uma) para usar so o `length` - e o gatilho de
 * metadata varria o acervo de novo, serie a serie.
 *
 * A medida e CONTAGEM DE CHAMADAS a fonte, nao relogio: cada metodo da fonte e
 * uma consulta preparada, e tempo de parede em CI e instavel demais para virar
 * assercao.
 */

const SHOWS = 500;
const EPISODIOS_POR_SHOW = 30;
const EPOCH = Date.parse('2024-01-01T00:00:00Z');
const MIN = 60_000;

/** Toda chave da fonte, para o contador nao esquecer nenhuma sem avisar. */
type Calls = Record<keyof ChannelSource, number>;

interface Spy {
  source: ChannelSource;
  calls: Calls;
  reset(): void;
}

/** Envelope que so conta: delega tudo ao Store de verdade. */
function spyOn(store: Store): Spy {
  const zero = (): Calls => ({
    listShows: 0,
    listVisibleShows: 0,
    getShowByChannel: 0,
    listEpisodes: 0,
    countEpisodesByShow: 0,
    listSeasons: 0,
    listSeasonsByShow: 0,
    getShowMetadata: 0,
    hasShowsWithoutMetadata: 0,
    indexVersion: 0,
  });

  const spy: Spy = {
    calls: zero(),
    reset: (): void => {
      spy.calls = zero();
    },
    source: {
      listShows: () => {
        spy.calls.listShows += 1;
        return store.listShows();
      },
      listVisibleShows: () => {
        spy.calls.listVisibleShows += 1;
        return store.listVisibleShows();
      },
      getShowByChannel: (n) => {
        spy.calls.getShowByChannel += 1;
        return store.getShowByChannel(n);
      },
      listEpisodes: (showId) => {
        spy.calls.listEpisodes += 1;
        return store.listEpisodes(showId);
      },
      countEpisodesByShow: () => {
        spy.calls.countEpisodesByShow += 1;
        return store.countEpisodesByShow();
      },
      listSeasons: (showId) => {
        spy.calls.listSeasons += 1;
        return store.listSeasons(showId);
      },
      listSeasonsByShow: () => {
        spy.calls.listSeasonsByShow += 1;
        return store.listSeasonsByShow();
      },
      getShowMetadata: (showId) => {
        spy.calls.getShowMetadata += 1;
        return store.getShowMetadata(showId);
      },
      hasShowsWithoutMetadata: () => {
        spy.calls.hasShowsWithoutMetadata += 1;
        return store.hasShowsWithoutMetadata();
      },
      indexVersion: () => {
        spy.calls.indexVersion += 1;
        return store.indexVersion();
      },
    },
  };
  return spy;
}

function episode(slug: string, n: number): EpisodeInput {
  return {
    id: `${slug}/ep${String(n).padStart(2, '0')}.mkv`,
    absolutePath: `/lib/${slug}/ep${String(n)}.mkv`,
    title: `Episodio ${String(n)}`,
    season: n <= 15 ? 1 : 2,
    episode: n,
    orderIndex: n - 1,
    durationMs: 22 * MIN,
    videoCodec: 'h264',
    audioCodec: 'eac3',
    width: 1920,
    height: 1080,
    faststart: true,
    audioTracks: [
      { index: 0, lang: 'por', title: 'Brazilian', codec: 'eac3', isDefault: true },
      { index: 1, lang: 'eng', title: null, codec: 'eac3', isDefault: false },
    ],
    subtitleTracks: [
      { index: 0, lang: 'por', title: null, codec: 'subrip', isDefault: true, forced: false },
    ],
    mtimeMs: 1_700_000_000_000,
    size: 700_000_000,
  };
}

let store: Store;
let spy: Spy;
let app: FastifyInstance;
/** Serie no indice sem episodio nenhum: a listagem tem que filtra-la. */
let vaziaChannelNumber: number;

beforeAll(async () => {
  store = openStore(':memory:');

  for (let i = 0; i < SHOWS; i += 1) {
    const slug = `serie-${String(i).padStart(3, '0')}`;
    const show = store.upsertShow({ slug, name: `Serie ${String(i)}`, absolutePath: `/lib/${slug}` });
    store.upsertEpisodes(
      show.id,
      Array.from({ length: EPISODIOS_POR_SHOW }, (_, n) => episode(slug, n + 1)),
    );
  }
  vaziaChannelNumber = store.upsertShow({
    slug: 'vazia',
    name: 'Vazia',
    absolutePath: '/lib/vazia',
  }).channelNumber;

  spy = spyOn(store);
  app = Fastify();
  registerChannelRoutes(app, {
    source: spy.source,
    epochMs: EPOCH,
    now: () => EPOCH,
    dataDir: '/tmp/widetv-inexistente',
    onMetadataMissing: () => undefined,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  store.close();
});

describe('custo de GET /api/channels', () => {
  test('nao carrega episodio nenhum para montar a listagem', async () => {
    spy.reset();
    const r = await app.inject({ url: '/api/channels' });
    expect(r.statusCode).toBe(200);

    // A assercao central: zero. Antes eram 500 chamadas, 15 mil linhas lidas.
    expect(spy.calls.listEpisodes).toBe(0);
  });

  test('contagem, temporadas e o gatilho de metadata sao UMA consulta cada', async () => {
    spy.reset();
    await app.inject({ url: '/api/channels' });

    // A listagem publica usa listVisibleShows, nunca listShows: a segunda
    // devolveria series ocultas no painel de curadoria.
    expect(spy.calls.listVisibleShows).toBe(1);
    expect(spy.calls.listShows).toBe(0);
    expect(spy.calls.countEpisodesByShow).toBe(1);
    expect(spy.calls.listSeasonsByShow).toBe(1);
    expect(spy.calls.hasShowsWithoutMetadata).toBe(1);
    // Estas nao servem a listagem: quem as usa e a rota de um canal so.
    expect(spy.calls.listSeasons).toBe(0);
    expect(spy.calls.getShowByChannel).toBe(0);
  });

  test('o unico trabalho por serie que sobra e a metadata, uma leitura cada', async () => {
    // Consulta pontual por chave primaria; e o que permite a capa aparecer
    // assim que a busca grava, sem esperar rescan.
    spy.reset();
    await app.inject({ url: '/api/channels' });

    const total = Object.values(spy.calls).reduce((soma, n) => soma + n, 0);
    expect(spy.calls.getShowMetadata).toBe(SHOWS + 1); // +1: a serie vazia
    expect(total).toBe(SHOWS + 1 + 4);
  });

  test('o custo nao anda com o tamanho do acervo alem dessa leitura pontual', async () => {
    spy.reset();
    await app.inject({ url: '/api/channels' });
    const total = Object.values(spy.calls).reduce((soma, n) => soma + n, 0);

    // Antes: 1 (listShows) + N (listEpisodes) + N (getShowMetadata)
    //        + 1 + N (a varredura do gatilho de metadata) = 3N + 2.
    const antes = 3 * (SHOWS + 1) + 2;
    expect(total).toBeLessThan(antes / 2);
  });
});

describe('a listagem continua correta com o acervo grande', () => {
  test('devolve um canal por serie com episodio, ordenado por numero', async () => {
    const body = (await app.inject({ url: '/api/channels' })).json<ChannelSummary[]>();

    expect(body).toHaveLength(SHOWS);
    expect(body.map((c) => c.number)).toEqual([...body.map((c) => c.number)].sort((a, b) => a - b));
    // A serie sem episodio fica de fora, como quando a contagem vinha de listEpisodes.
    expect(body.some((c) => c.number === vaziaChannelNumber)).toBe(false);
  });

  test('episodeCount bate exatamente com listEpisodes().length, canal a canal', async () => {
    const body = (await app.inject({ url: '/api/channels' })).json<ChannelSummary[]>();

    for (const canal of body) {
      const show = store.getShowByChannel(canal.number)!;
      expect(canal.episodeCount).toBe(store.listEpisodes(show.id).length);
    }
  });

  test('seasons bate com listSeasons da mesma serie', async () => {
    const body = (await app.inject({ url: '/api/channels' })).json<ChannelSummary[]>();

    for (const canal of body.slice(0, 20)) {
      const show = store.getShowByChannel(canal.number)!;
      expect(canal.seasons).toEqual(store.listSeasons(show.id));
    }
    expect(body[0]!.seasons).toEqual([1, 2]);
  });

  test('serie podada no rescan some da listagem e da contagem', async () => {
    const alvo = store.getShowByChannel(store.listShows()[0]!.channelNumber)!;
    store.pruneEpisodes(alvo.id, []);

    const body = (await app.inject({ url: '/api/channels' })).json<ChannelSummary[]>();
    expect(body.some((c) => c.number === alvo.channelNumber)).toBe(false);
    expect(body).toHaveLength(SHOWS - 1);

    // E o "no ar" concorda: canal sem episodio nao entra no array.
    const agora = (await app.inject({ url: '/api/now' })).json<NowPlaying[]>();
    expect(agora.some((n) => n.channel.number === alvo.channelNumber)).toBe(false);
    expect(agora).toHaveLength(SHOWS - 1);
  });
});
