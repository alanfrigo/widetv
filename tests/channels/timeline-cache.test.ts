import { describe, expect, test } from 'vitest';

import { createTimelineCache, readGrid, type GridSource } from '../../src/server/channels/timeline-cache';
import type { EpisodeRow } from '../../src/server/library/index-store';

/**
 * O que estes testes protegem: a grade pode vir de memoria, mas nunca pode
 * sobreviver a um scan. Servir a grade velha depois de um rescan e pior do que
 * nao ter cache nenhum - o canal apontaria para arquivo que nao existe mais.
 */

const MIN = 60_000;

function episode(id: string, durationMs: number, season: number | null = 1): EpisodeRow {
  return {
    id,
    showId: 1,
    absolutePath: `/lib/${id}`,
    title: id,
    season,
    episode: 1,
    orderIndex: 0,
    durationMs,
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

interface FakeSource extends GridSource {
  /** Quantas vezes o banco foi realmente tocado. */
  leituras: number;
  episodes: Map<number, EpisodeRow[]>;
  versao: number;
}

function makeSource(episodes: Map<number, EpisodeRow[]>): FakeSource {
  const fake: FakeSource = {
    leituras: 0,
    episodes,
    versao: 1,
    listEpisodes: (showId) => {
      fake.leituras += 1;
      return episodes.get(showId) ?? [];
    },
    listSeasons: (showId) => {
      const seen = new Set<number>();
      for (const row of episodes.get(showId) ?? []) {
        if (row.season !== null) seen.add(row.season);
      }
      return [...seen].sort((a, b) => a - b);
    },
    indexVersion: () => fake.versao,
  };
  return fake;
}

describe('readGrid', () => {
  test('monta episodios, somas prefixas e temporadas', () => {
    const source = makeSource(
      new Map([[1, [episode('a', 20 * MIN), episode('b', 10 * MIN, 2)]]]),
    );
    const grid = readGrid(source, 1)!;

    expect(grid.episodes.map((e) => e.id)).toEqual(['a', 'b']);
    expect([...grid.timeline]).toEqual([20 * MIN, 30 * MIN]);
    expect(grid.seasons).toEqual([1, 2]);
  });

  test('serie sem episodio devolve null em vez de lancar', () => {
    // Canal vazio e estado normal do acervo; `buildTimeline` lancaria.
    expect(readGrid(makeSource(new Map()), 1)).toBeNull();
  });
});

describe('createTimelineCache', () => {
  test('a segunda leitura do mesmo canal nao toca no banco', () => {
    const source = makeSource(new Map([[1, [episode('a', 20 * MIN)]]]));
    const cache = createTimelineCache(source);

    const primeiro = cache.get(1);
    const segundo = cache.get(1);

    expect(source.leituras).toBe(1);
    // Mesma instancia: nada e remontado.
    expect(segundo).toBe(primeiro);
  });

  test('canal vazio tambem fica guardado, para nao reconsultar a cada request', () => {
    const source = makeSource(new Map());
    const cache = createTimelineCache(source);

    expect(cache.get(9)).toBeNull();
    expect(cache.get(9)).toBeNull();
    expect(source.leituras).toBe(1);
  });

  test('versao nova do indice joga a grade fora', () => {
    const episodes = new Map([[1, [episode('a', 20 * MIN)]]]);
    const source = makeSource(episodes);
    const cache = createTimelineCache(source);

    expect(cache.get(1)!.episodes).toHaveLength(1);

    // Um rescan trouxe episodio novo.
    episodes.set(1, [episode('a', 20 * MIN), episode('b', 20 * MIN)]);
    source.versao += 1;

    expect(cache.get(1)!.episodes).toHaveLength(2);
    expect(source.leituras).toBe(2);
  });

  test('serie que sumiu do disco vira canal vazio, nao grade velha', () => {
    const episodes = new Map([[1, [episode('a', 20 * MIN)]]]);
    const source = makeSource(episodes);
    const cache = createTimelineCache(source);

    expect(cache.get(1)).not.toBeNull();

    episodes.delete(1);
    source.versao += 1;

    expect(cache.get(1)).toBeNull();
  });

  test('a invalidacao limpa o mapa inteiro, nao so o canal pedido', () => {
    // Um scan mexe em muitos canais de uma vez; descobrir quais custaria mais
    // que remontar as grades sob demanda.
    const source = makeSource(
      new Map([
        [1, [episode('a', 20 * MIN)]],
        [2, [episode('b', 20 * MIN)]],
      ]),
    );
    const cache = createTimelineCache(source);

    cache.get(1);
    cache.get(2);
    expect(cache.size).toBe(2);

    source.versao += 1;
    cache.get(1);
    expect(cache.size).toBe(1);
  });

  test('sem mudanca de versao o cache nunca expira sozinho', () => {
    const source = makeSource(new Map([[1, [episode('a', 20 * MIN)]]]));
    const cache = createTimelineCache(source);

    for (let i = 0; i < 50; i += 1) cache.get(1);
    expect(source.leituras).toBe(1);
  });
});
