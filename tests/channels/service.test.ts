import { describe, expect, test } from 'vitest';
import type { EpisodeRow, ShowMetadataRow, ShowRow } from '../../src/server/library/index-store';
import {
  type ChannelSource,
  listChannelEpisodes,
  listChannels,
  listNowPlaying,
  resolveNowPlaying,
} from '../../src/server/channels/service';
import { createTimelineCache } from '../../src/server/channels/timeline-cache';

const EPOCH = Date.parse('2024-01-01T00:00:00Z');
const MIN = 60_000;

function show(id: number, channelNumber: number, name: string, slug = name.toLowerCase()): ShowRow {
  return { id, slug, name, channelNumber, absolutePath: `/lib/${name}` };
}

function episode(showId: number, index: number, durationMs: number): EpisodeRow {
  return {
    id: `${showId}/ep${index}`,
    showId,
    absolutePath: `/lib/${showId}/ep${index}.mp4`,
    title: `Episodio ${index}`,
    season: 1,
    episode: index,
    orderIndex: index - 1,
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
    mtimeMs: 0,
    size: 1,
    thumbFile: null,
    thumbCheckedAt: null,
  };
}

/** Temporadas distintas dos episodios, como o SELECT DISTINCT do Store faria. */
function seasonsOf(rows: EpisodeRow[]): number[] {
  const seen = new Set<number>();
  for (const row of rows) {
    if (row.season !== null) seen.add(row.season);
  }
  return [...seen].sort((a, b) => a - b);
}

/** Fonte em memoria com o mesmo contrato do Store. */
function source(
  shows: ShowRow[],
  episodes: Record<number, EpisodeRow[]>,
  metadata: Record<number, ShowMetadataRow> = {},
  hiddenSlugs: string[] = [],
): ChannelSource {
  return {
    listShows: () => shows,
    // Como `Store.listVisibleShows`: o catalogo publico e `listShows` menos o
    // que o painel marcou como oculto.
    listVisibleShows: () => shows.filter((s) => !hiddenSlugs.includes(s.slug)),
    getShowByChannel: (n) => shows.find((s) => s.channelNumber === n) ?? null,
    listEpisodes: (showId) => episodes[showId] ?? [],
    // Como o GROUP BY do Store: serie sem episodio nao aparece no mapa.
    countEpisodesByShow: () =>
      new Map(
        shows
          .map((s) => [s.id, (episodes[s.id] ?? []).length] as const)
          .filter(([, total]) => total > 0),
      ),
    listSeasons: (showId) => seasonsOf(episodes[showId] ?? []),
    listSeasonsByShow: () =>
      new Map(
        shows
          .map((s) => [s.id, seasonsOf(episodes[s.id] ?? [])] as const)
          .filter(([, temporadas]) => temporadas.length > 0),
      ),
    getShowMetadata: (showId) => metadata[showId] ?? null,
    hasShowsWithoutMetadata: () => shows.some((s) => metadata[s.id] === undefined),
    indexVersion: () => 1,
  };
}

function metadataRow(showId: number, over: Partial<ShowMetadataRow> = {}): ShowMetadataRow {
  return {
    showId,
    posterFile: `${showId}.jpg`,
    backdropFile: `${showId}.jpg`,
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

const THUNDER = show(1, 7, 'ThunderCats');
const HEMAN = show(2, 3, 'He-Man');

const SRC = source([THUNDER, HEMAN], {
  1: [episode(1, 1, 22 * MIN), episode(1, 2, 22 * MIN), episode(1, 3, 20 * MIN)],
  2: [episode(2, 1, 10 * MIN)],
});

describe('listChannels', () => {
  test('devolve os canais ordenados por numero', () => {
    expect(listChannels(SRC).map((c) => c.number)).toEqual([3, 7]);
  });

  test('conta os episodios de cada canal', () => {
    const canais = listChannels(SRC);
    expect(canais.find((c) => c.number === 7)?.episodeCount).toBe(3);
  });

  test('serie sem episodio nao vira canal', () => {
    const vazio = source([THUNDER, show(9, 20, 'Vazia')], { 1: [episode(1, 1, MIN)] });
    expect(listChannels(vazio).map((c) => c.number)).toEqual([7]);
  });

  test('serie oculta some do catalogo', () => {
    const comOculta = source(
      [THUNDER, HEMAN],
      { 1: [episode(1, 1, 20 * MIN)], 2: [episode(2, 1, 10 * MIN)] },
      {},
      [HEMAN.slug],
    );
    expect(listChannels(comOculta).map((c) => c.name)).not.toContain('He-Man');
  });

  test('sem metadata, os campos de capa vem null em vez de sumirem', () => {
    // O contrato promete as chaves sempre presentes: um cliente que faz
    // destructuring nao pode receber `undefined` de um acervo recem indexado.
    const canal = listChannels(SRC).find((c) => c.number === 7)!;
    expect(canal.posterUrl).toBeNull();
    expect(canal.backdropUrl).toBeNull();
    expect(canal.year).toBeNull();
    expect(canal.overview).toBeNull();
  });

  test('com metadata, as artes apontam para as rotas do proprio canal', () => {
    const src = source([THUNDER], { 1: [episode(1, 1, MIN)] }, { 1: metadataRow(1) });
    const canal = listChannels(src)[0]!;
    expect(canal.posterUrl).toBe(`/api/channels/7/poster?v=${String(EPOCH)}`);
    expect(canal.backdropUrl).toBe(`/api/channels/7/backdrop?v=${String(EPOCH)}`);
    expect(canal.year).toBe(1985);
    expect(canal.overview).toBe('Sinopse.');
  });

  test('metadata sem arte 16:9 mantem backdropUrl null e nao mexe na capa', () => {
    // TVMaze e iTunes nunca tem arte 16:9: e o caso comum, nao uma falha.
    const src = source(
      [THUNDER],
      { 1: [episode(1, 1, MIN)] },
      { 1: metadataRow(1, { backdropFile: null }) },
    );
    const canal = listChannels(src)[0]!;
    expect(canal.backdropUrl).toBeNull();
    expect(canal.posterUrl).toBe(`/api/channels/7/poster?v=${String(EPOCH)}`);
  });

  test('seasons vem crescente, sem repetir e sem os episodios sem temporada', () => {
    const mista = [
      { ...episode(1, 1, MIN), season: 2 },
      { ...episode(1, 2, MIN), season: 1 },
      { ...episode(1, 3, MIN), season: 2 },
      { ...episode(1, 4, MIN), season: null },
    ];
    const src = source([THUNDER], { 1: mista });
    expect(listChannels(src)[0]!.seasons).toEqual([1, 2]);
  });

  test('serie sem pastas de temporada devolve [] e nao null', () => {
    const src = source([THUNDER], {
      1: [{ ...episode(1, 1, MIN), season: null }, { ...episode(1, 2, MIN), season: null }],
    });
    expect(listChannels(src)[0]!.seasons).toEqual([]);
  });

  test('metadata sem arquivo de capa mantem posterUrl null, mas conserva ano e sinopse', () => {
    const src = source(
      [THUNDER],
      { 1: [episode(1, 1, MIN)] },
      { 1: metadataRow(1, { posterFile: null }) },
    );
    const canal = listChannels(src)[0]!;
    expect(canal.posterUrl).toBeNull();
    expect(canal.year).toBe(1985);
  });

  test('serie marcada como inexistente no provedor nao ganha capa', () => {
    const src = source(
      [THUNDER],
      { 1: [episode(1, 1, MIN)] },
      { 1: metadataRow(1, { posterFile: null, year: null, overview: null, notFound: true }) },
    );
    expect(listChannels(src)[0]!.posterUrl).toBeNull();
  });
});

describe('resolveNowPlaying', () => {
  test('canal inexistente devolve null em vez de lancar', () => {
    expect(resolveNowPlaying(SRC, 99, EPOCH, EPOCH)).toBeNull();
  });

  test('canal sem episodio devolve null', () => {
    const vazio = source([show(9, 20, 'Vazia')], {});
    expect(resolveNowPlaying(vazio, 20, EPOCH, EPOCH)).toBeNull();
  });

  test('carimba o instante recebido como serverTimeMs', () => {
    const now = EPOCH + 5 * MIN;
    expect(resolveNowPlaying(SRC, 7, EPOCH, now)?.serverTimeMs).toBe(now);
  });

  test('offset avanca junto com o relogio dentro do mesmo episodio', () => {
    const a = resolveNowPlaying(SRC, 7, EPOCH, EPOCH)!;
    const b = resolveNowPlaying(SRC, 7, EPOCH, EPOCH + 3 * MIN)!;
    expect(b.offsetMs - a.offsetMs).toBe(3 * MIN);
    expect(b.episode.id).toBe(a.episode.id);
  });

  test('endsAtMs mais offsetMs reconstroem o instante atual', () => {
    const now = EPOCH + 100 * MIN;
    const r = resolveNowPlaying(SRC, 7, EPOCH, now)!;
    expect(r.endsAtMs - (r.episode.durationMs - r.offsetMs)).toBe(now);
  });

  test('next aponta para o episodio seguinte da grade', () => {
    const r = resolveNowPlaying(SRC, 7, EPOCH, EPOCH)!;
    const episodios = SRC.listEpisodes(1);
    const atual = episodios.findIndex((e) => e.id === r.episode.id);
    expect(r.next.id).toBe(episodios[(atual + 1) % episodios.length]!.id);
  });

  test('serie de um episodio so aponta para ela mesma', () => {
    const r = resolveNowPlaying(SRC, 3, EPOCH, EPOCH + 3 * MIN)!;
    expect(r.next.id).toBe(r.episode.id);
  });

  test('a grade da a volta: um ciclo inteiro depois cai no mesmo ponto', () => {
    const ciclo = 64 * MIN; // 22 + 22 + 20
    const a = resolveNowPlaying(SRC, 7, EPOCH, EPOCH + 5 * MIN)!;
    const b = resolveNowPlaying(SRC, 7, EPOCH, EPOCH + 5 * MIN + ciclo)!;
    expect(b.episode.id).toBe(a.episode.id);
    expect(b.offsetMs).toBe(a.offsetMs);
  });

  test('inclui os dados do canal na resposta', () => {
    const r = resolveNowPlaying(SRC, 7, EPOCH, EPOCH)!;
    expect(r.channel).toEqual({
      number: 7,
      name: 'ThunderCats',
      episodeCount: 3,
      posterUrl: null,
      backdropUrl: null,
      year: null,
      overview: null,
      seasons: [1],
    });
  });

  test('o canal do "no ar" carrega as mesmas artes da listagem', () => {
    const src = source([THUNDER], { 1: [episode(1, 1, 20 * MIN)] }, { 1: metadataRow(1) });
    const r = resolveNowPlaying(src, 7, EPOCH, EPOCH)!;
    expect(r.channel.posterUrl).toBe(`/api/channels/7/poster?v=${String(EPOCH)}`);
    expect(r.channel.backdropUrl).toBe(`/api/channels/7/backdrop?v=${String(EPOCH)}`);
    expect(r.channel.year).toBe(1985);
  });

  test('o canal do "no ar" tem as mesmas temporadas da listagem', () => {
    // As duas respostas alimentam a mesma tela: uma divergencia aqui faria a
    // barra de temporadas pular ao trocar de canal.
    const r = resolveNowPlaying(SRC, 7, EPOCH, EPOCH)!;
    expect(r.channel.seasons).toEqual(listChannels(SRC).find((c) => c.number === 7)!.seasons);
  });

  test('canais diferentes nao comecam todos no episodio 1 ao mesmo tempo', () => {
    // Duas series identicas em conteudo, so o slug muda: a defasagem tem que
    // vir do canal, nao do acervo.
    const a = show(1, 1, 'Serie A', 'serie-a');
    const b = show(2, 2, 'Serie B', 'serie-b');
    const eps = [episode(1, 1, 20 * MIN), episode(1, 2, 20 * MIN), episode(1, 3, 20 * MIN)];
    const src = source([a, b], { 1: eps, 2: eps.map((e) => ({ ...e, showId: 2 })) });

    const ra = resolveNowPlaying(src, 1, EPOCH, EPOCH)!;
    const rb = resolveNowPlaying(src, 2, EPOCH, EPOCH)!;
    expect(ra.offsetMs === rb.offsetMs && ra.episode.episode === rb.episode.episode).toBe(false);
  });

  test('a defasagem de um canal e estavel entre chamadas', () => {
    const primeiro = resolveNowPlaying(SRC, 7, EPOCH, EPOCH + 7 * MIN)!;
    const segundo = resolveNowPlaying(SRC, 7, EPOCH, EPOCH + 7 * MIN)!;
    expect(segundo).toEqual(primeiro);
  });

  test('episodio exposto so tem os campos do contrato publico', () => {
    const r = resolveNowPlaying(SRC, 7, EPOCH, EPOCH)!;
    expect(Object.keys(r.episode).sort()).toEqual(
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

  test('expoe width/height do episodio', () => {
    const r = resolveNowPlaying(SRC, 7, EPOCH, EPOCH)!;
    expect(r.episode.width).toBe(640);
    expect(r.episode.height).toBe(480);
  });

  test('thumbUrl sai da coluna, sem tocar no disco', () => {
    const semQuadro = episode(1, 1, 10 * MIN);
    const comQuadro = { ...episode(1, 2, 10 * MIN), thumbFile: '42.jpg' };
    const src = source([show(1, 7, 'ThunderCats')], { 1: [semQuadro, comQuadro] });

    const refs = listChannelEpisodes(src, 7)!;
    // null nao e erro: e "a fila ainda nao chegou neste episodio", e a tela cai
    // no padrao listrado.
    expect(refs[0]?.thumbUrl).toBeNull();
    // O id vira UM segmento, com as barras percent-encodadas - igual a legenda.
    expect(refs[1]?.thumbUrl).toBe('/api/stream/1%2Fep2/thumb');
  });

  test('expoe as trilhas de audio e legenda do episodio', () => {
    const r = resolveNowPlaying(SRC, 7, EPOCH, EPOCH)!;
    expect(r.episode.audioTracks.map((t) => t.lang)).toEqual(['por', 'eng']);
    expect(r.episode.subtitleTracks[0]).toEqual({
      index: 0,
      lang: 'por',
      title: null,
      codec: 'subrip',
      isDefault: true,
      forced: true,
    });
  });
});

describe('listNowPlaying', () => {
  test('devolve os canais na MESMA ordem de listChannels', () => {
    // As duas respostas alimentam a mesma tela: uma divergencia emparelharia o
    // canal errado com o episodio errado.
    expect(listNowPlaying(SRC, EPOCH, EPOCH).map((n) => n.channel.number)).toEqual(
      listChannels(SRC).map((c) => c.number),
    );
  });

  test('ordena mesmo quando a fonte devolve as series fora de ordem', () => {
    const foraDeOrdem = source([THUNDER, HEMAN], {
      1: [episode(1, 1, 20 * MIN)],
      2: [episode(2, 1, 10 * MIN)],
    });
    expect(listNowPlaying(foraDeOrdem, EPOCH, EPOCH).map((n) => n.channel.number)).toEqual([3, 7]);
  });

  test('canal sem episodio some do array em vez de virar null', () => {
    const comVazio = source([THUNDER, show(9, 20, 'Vazia')], { 1: [episode(1, 1, 20 * MIN)] });
    const agora = listNowPlaying(comVazio, EPOCH, EPOCH);
    expect(agora.map((n) => n.channel.number)).toEqual([7]);
  });

  test('cada item e identico ao que resolveNowPlaying daria para o mesmo instante', () => {
    // Divergir aqui faria a faixa "No ar agora" mostrar um episodio e o player
    // abrir outro.
    const now = EPOCH + 137 * MIN;
    for (const item of listNowPlaying(SRC, EPOCH, now)) {
      expect(item).toEqual(resolveNowPlaying(SRC, item.channel.number, EPOCH, now));
    }
  });

  test('acervo vazio devolve [] em vez de lancar', () => {
    expect(listNowPlaying(source([], {}), EPOCH, EPOCH)).toEqual([]);
  });

  test('com cache o resultado e o mesmo de sem cache', () => {
    const now = EPOCH + 91 * MIN;
    const cache = createTimelineCache(SRC);
    expect(listNowPlaying(SRC, EPOCH, now, cache)).toEqual(listNowPlaying(SRC, EPOCH, now));
  });
});

describe('listChannelEpisodes', () => {
  test('canal inexistente devolve null', () => {
    expect(listChannelEpisodes(SRC, 99)).toBeNull();
  });

  test('serie sem episodios devolve lista vazia', () => {
    const vazio = source([show(9, 20, 'Vazia')], {});
    expect(listChannelEpisodes(vazio, 20)).toEqual([]);
  });

  test('devolve os episodios na ordem da grade', () => {
    const episodios = listChannelEpisodes(SRC, 7)!;
    expect(episodios.map((e) => e.id)).toEqual(SRC.listEpisodes(1).map((e) => e.id));
  });

  test('itens tem so as chaves do contrato publico', () => {
    const episodios = listChannelEpisodes(SRC, 7)!;
    for (const ep of episodios) {
      expect(Object.keys(ep).sort()).toEqual(
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
    }
  });

  test('indice velho sem trilhas vira [] no contrato, nunca undefined', () => {
    const semTrilha = source([THUNDER], {
      1: [{ ...episode(1, 1, MIN), audioTracks: [], subtitleTracks: [] }],
    });
    const episodios = listChannelEpisodes(semTrilha, 7)!;
    expect(episodios[0]!.audioTracks).toEqual([]);
    expect(episodios[0]!.subtitleTracks).toEqual([]);
  });

  test('width/height null sao propagados', () => {
    const semDimensao = source([THUNDER], {
      1: [{ ...episode(1, 1, MIN), width: null, height: null }],
    });
    const episodios = listChannelEpisodes(semDimensao, 7)!;
    expect(episodios[0]!.width).toBeNull();
    expect(episodios[0]!.height).toBeNull();
  });
});

