import type { EpisodeRef } from '@shared/api-types';

import { episodesLabel, formatRuntime, joinMeta } from './format';

/**
 * Abas de temporada da tela da serie.
 *
 * Duas fontes se encontram aqui: `ChannelSummary.seasons`, que o servidor manda
 * junto do catalogo (e por isso chega ANTES da lista de episodios, evitando que
 * a barra de abas apareca pulando), e os proprios episodios, que sao quem sabe
 * quantos ha em cada temporada e quais ficaram sem nenhuma.
 *
 * Puro, como o resto das decisoes: quem desenha o botao e o `main.ts`.
 */

export interface SeasonTab {
  /** Numero da temporada; null e a aba dos episodios soltos. */
  season: number | null;
  label: string;
  count: number;
}

/**
 * As abas que a tela deve mostrar, em ordem crescente.
 *
 * @returns `[]` quando nao ha temporada nenhuma - a barra some e sobra o aside.
 *          Uma serie inteira sem pastas de temporada nao ganha uma unica aba
 *          "Sem temporada": ela nao filtraria nada, so ocuparia a linha.
 */
export function buildSeasonTabs(
  seasons: readonly number[],
  episodes: readonly EpisodeRef[],
): SeasonTab[] {
  const numbers = new Set<number>();
  for (const season of seasons) {
    if (Number.isFinite(season)) numbers.add(Math.trunc(season));
  }
  // Servidor antigo ainda nao manda `seasons`: os episodios sozinhos bastam
  // para montar a barra, so chegam mais tarde.
  for (const episode of episodes) {
    if (episode.season !== null) numbers.add(episode.season);
  }
  if (numbers.size === 0) return [];

  const tabs: SeasonTab[] = [...numbers]
    .sort((a, b) => a - b)
    .map((season) => ({
      season,
      label: `Temporada ${season}`,
      count: episodes.filter((episode) => episode.season === season).length,
    }));

  const loose = episodes.filter((episode) => episode.season === null).length;
  if (loose > 0) {
    tabs.push({ season: null, label: `Sem temporada · ${loose}`, count: loose });
  }
  return tabs;
}

/**
 * Episodios de uma aba.
 *
 * @param season  numero da temporada, ou null para a aba dos soltos. Quando nao
 *                ha aba nenhuma o chamador passa a lista inteira adiante.
 */
export function episodesOfSeason(
  episodes: readonly EpisodeRef[],
  season: number | null,
): EpisodeRef[] {
  return episodes.filter((episode) => episode.season === season);
}

/**
 * Aba que deve ficar ativa, dado o que o usuario tinha escolhido antes.
 *
 * A escolha sobrevive ao redesenho que acontece quando os episodios chegam:
 * sem isto, a lista voltaria para a temporada 1 no meio da navegacao.
 *
 * @returns null quando nao ha abas.
 */
export function activeSeasonTab(tabs: readonly SeasonTab[], wanted: SeasonTab | null): SeasonTab | null {
  if (tabs.length === 0) return null;
  if (wanted === null) return tabs[0] ?? null;
  return tabs.find((tab) => tab.season === wanted.season) ?? tabs[0] ?? null;
}

/** Texto a direita da barra: `24 episódios · 9h 12min`. */
export function seasonAside(episodes: readonly EpisodeRef[]): string {
  const total = episodes.reduce((sum, episode) => sum + Math.max(0, episode.durationMs), 0);
  return joinMeta([episodesLabel(episodes.length), formatRuntime(total)]);
}
