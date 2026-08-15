import { describe, expect, test } from 'vitest';
import type { EpisodeRef } from '../../src/shared/api-types';
import {
  activeSeasonTab,
  buildSeasonTabs,
  episodesOfSeason,
  seasonAside,
  type SeasonTab,
} from '../../src/web/seasons';

function ep(season: number | null, episode: number, durationMs = 22 * 60_000): EpisodeRef {
  return {
    id: `${String(season)}-${String(episode)}`,
    title: `Episódio ${String(episode)}`,
    season,
    episode,
    durationMs,
    width: null,
    height: null,
    audioTracks: [],
    subtitleTracks: [],
    thumbUrl: null,
  };
}

describe('montagem das abas', () => {
  test('uma aba por temporada, em ordem crescente', () => {
    const tabs = buildSeasonTabs([2, 1], [ep(1, 1), ep(1, 2), ep(2, 1)]);
    expect(tabs.map((tab) => tab.label)).toEqual(['Temporada 1', 'Temporada 2']);
    expect(tabs.map((tab) => tab.count)).toEqual([2, 1]);
  });

  test('as abas existem antes de os episodios chegarem', () => {
    // E o motivo de `ChannelSummary.seasons` existir: a barra nao pode pular.
    const tabs = buildSeasonTabs([1, 2, 3], []);
    expect(tabs.map((tab) => tab.season)).toEqual([1, 2, 3]);
    expect(tabs.every((tab) => tab.count === 0)).toBe(true);
  });

  test('servidor sem o campo novo ainda monta a barra pelos episodios', () => {
    const tabs = buildSeasonTabs([], [ep(1, 1), ep(3, 1)]);
    expect(tabs.map((tab) => tab.season)).toEqual([1, 3]);
  });

  test('episodio solto ganha a aba extra, com a contagem no rotulo', () => {
    const tabs = buildSeasonTabs([1], [ep(1, 1), ep(null, 1), ep(null, 2)]);
    expect(tabs.map((tab) => tab.label)).toEqual(['Temporada 1', 'Sem temporada · 2']);
    expect(tabs.at(-1)).toMatchObject({ season: null, count: 2 });
  });

  test('a aba dos soltos fica sempre no fim', () => {
    const tabs = buildSeasonTabs([1, 2], [ep(null, 1), ep(2, 1), ep(1, 1)]);
    expect(tabs.at(-1)?.season).toBeNull();
  });

  test('serie sem temporada nenhuma nao mostra barra de abas', () => {
    expect(buildSeasonTabs([], [])).toEqual([]);
    // Todos os episodios soltos: uma unica aba "Sem temporada" nao filtraria
    // nada, so ocuparia a linha.
    expect(buildSeasonTabs([], [ep(null, 1), ep(null, 2)])).toEqual([]);
  });
});

describe('filtro da aba', () => {
  const episodes = [ep(1, 1), ep(1, 2), ep(2, 1), ep(null, 9)];

  test('a aba ativa filtra a lista', () => {
    expect(episodesOfSeason(episodes, 1).map((e) => e.episode)).toEqual([1, 2]);
    expect(episodesOfSeason(episodes, 2).map((e) => e.episode)).toEqual([1]);
  });

  test('a aba dos soltos pega o que nao tem temporada', () => {
    expect(episodesOfSeason(episodes, null).map((e) => e.episode)).toEqual([9]);
  });

  test('temporada que nao existe devolve lista vazia, nao a serie inteira', () => {
    expect(episodesOfSeason(episodes, 7)).toEqual([]);
  });
});

describe('aba ativa', () => {
  const tabs = buildSeasonTabs([1, 2], [ep(1, 1), ep(2, 1)]);

  test('sem escolha anterior, a primeira aba manda', () => {
    expect(activeSeasonTab(tabs, null)?.season).toBe(1);
  });

  test('a escolha sobrevive ao redesenho de quando os episodios chegam', () => {
    const chosen: SeasonTab = { season: 2, label: 'Temporada 2', count: 0 };
    expect(activeSeasonTab(tabs, chosen)?.season).toBe(2);
  });

  test('temporada que sumiu num rescan cai na primeira aba', () => {
    const gone: SeasonTab = { season: 9, label: 'Temporada 9', count: 3 };
    expect(activeSeasonTab(tabs, gone)?.season).toBe(1);
  });

  test('sem abas nao ha aba ativa', () => {
    expect(activeSeasonTab([], null)).toBeNull();
  });
});

describe('aside da barra', () => {
  test('conta episodios e soma a duracao', () => {
    expect(seasonAside([ep(1, 1), ep(1, 2)])).toBe('2 episódios · 44min');
  });

  test('temporada longa vira horas e minutos', () => {
    const episodes = Array.from({ length: 25 }, (_, i) => ep(1, i + 1));
    expect(seasonAside(episodes)).toBe('25 episódios · 9h 10min');
  });

  test('sem duracao medida sobra a contagem, sem separador orfao', () => {
    expect(seasonAside([ep(1, 1, 0)])).toBe('1 episódio');
    expect(seasonAside([])).toBe('0 episódios');
  });
});
