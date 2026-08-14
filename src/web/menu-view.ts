import type { ChannelSummary, EpisodeRef } from '@shared/api-types';

import type { MenuState } from './menu';
import { formatDurationMin, resolutionBadge } from './menu-format';
import { formatChannelNumber, formatEpisodeLabel } from './osd';

/**
 * Desenho do menu widescreen.
 *
 * So DOM: toda decisao ja veio pronta em `MenuState`. Redesenha a lista inteira
 * a cada evento - com algumas centenas de linhas isso e barato, e um render
 * burro que sempre reflete o estado vale mais do que diff incremental que
 * dessincroniza.
 */

export interface MenuData {
  channels: ChannelSummary[];
  /** null enquanto a lista nao chegou; [] quando nao deu para carregar. */
  episodes: EpisodeRef[] | null;
}

export interface MenuRoot {
  title: HTMLElement;
  list: HTMLElement;
  hints: HTMLElement;
}

const CHANNEL_HINTS = '↑↓ navegar · ENTER assistir ao vivo · → episódios · ESC fechar';
const EPISODE_HINTS = '↑↓ navegar · ENTER assistir do início · ← voltar · ESC fechar';

function span(className: string, text: string): HTMLSpanElement {
  const element = document.createElement('span');
  element.className = className;
  element.textContent = text;
  return element;
}

/** Linha sem indice: recado no lugar da lista, nao alvo de escolha. */
function notice(text: string): HTMLLIElement {
  const item = document.createElement('li');
  item.className = 'app-menu__notice';
  item.textContent = text;
  return item;
}

function row(index: number, selected: boolean, parts: HTMLElement[]): HTMLLIElement {
  const item = document.createElement('li');
  item.className = selected ? 'app-menu__item is-selected' : 'app-menu__item';
  // O indice viaja no DOM para o listener unico do <ul> saber em que linha o
  // clique caiu, sem um listener por linha.
  item.dataset.index = String(index);
  item.append(...parts);
  return item;
}

function channelRow(channel: ChannelSummary, index: number, selected: boolean): HTMLLIElement {
  const count = channel.episodeCount === 1 ? '1 EPISÓDIO' : `${channel.episodeCount} EPISÓDIOS`;
  return row(index, selected, [
    span('app-menu__num', formatChannelNumber(channel.number)),
    span('app-menu__name', channel.name.toUpperCase()),
    span('app-menu__meta', count),
  ]);
}

function episodeRow(episode: EpisodeRef, index: number, selected: boolean): HTMLLIElement {
  const parts = [
    span('app-menu__num', formatEpisodeLabel(episode)),
    span('app-menu__name', episode.title),
    span('app-menu__meta', formatDurationMin(episode.durationMs)),
  ];

  const badge = resolutionBadge(episode.width, episode.height);
  // Sem selo quando o probe nao mediu: melhor coluna vazia do que chute.
  if (badge !== null) parts.push(span('app-menu__badge', badge));

  return row(index, selected, parts);
}

function renderChannels(root: MenuRoot, state: MenuState, data: MenuData): void {
  root.title.textContent = 'CANAIS';
  root.hints.textContent = CHANNEL_HINTS;

  if (data.channels.length === 0) {
    root.list.replaceChildren(notice('SEM CANAIS'));
    return;
  }

  root.list.replaceChildren(
    ...data.channels.map((channel, index) =>
      channelRow(channel, index, index === state.channelCursor),
    ),
  );
}

function renderEpisodes(root: MenuRoot, state: MenuState, data: MenuData, drilled: number): void {
  const channel = data.channels[drilled];
  root.title.textContent = channel === undefined ? 'EPISÓDIOS' : channel.name.toUpperCase();
  root.hints.textContent = EPISODE_HINTS;

  if (data.episodes === null) {
    root.list.replaceChildren(notice('CARREGANDO…'));
    return;
  }
  if (data.episodes.length === 0) {
    root.list.replaceChildren(notice('NÃO FOI POSSÍVEL CARREGAR'));
    return;
  }

  root.list.replaceChildren(
    ...data.episodes.map((episode, index) =>
      episodeRow(episode, index, index === state.episodeCursor),
    ),
  );
}

export function renderMenu(root: MenuRoot, state: MenuState, data: MenuData): void {
  if (state.drilledChannel === null) {
    renderChannels(root, state, data);
  } else {
    renderEpisodes(root, state, data, state.drilledChannel);
  }

  // Depois de estar no documento, senao o navegador nao tem geometria para
  // rolar. `nearest` para a lista nao pular quando a linha ja esta visivel.
  const selected = root.list.querySelector('.is-selected');
  selected?.scrollIntoView({ block: 'nearest' });
}

/**
 * Um listener no <ul> inteiro, nao um por linha: a lista e redesenhada a cada
 * tecla, e listener por linha viraria vazamento a cada render.
 */
export function bindMenuClicks(list: HTMLElement, onPick: (index: number) => void): void {
  list.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const item = target.closest<HTMLElement>('[data-index]');
    if (item === null || !list.contains(item)) return;

    const index = Number(item.dataset.index);
    if (!Number.isInteger(index)) return;
    onPick(index);
  });
}
