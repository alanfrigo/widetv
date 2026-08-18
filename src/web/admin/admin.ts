import type { AdminShow } from '@shared/api-types';

import { fetchAdminShows } from './api';
import { initialAdminState, visibleShows, type AdminUiState } from './state';
import './admin.css';

/**
 * Desenho e rede do painel. A decisao (filtro, selecao) mora em `state.ts`;
 * aqui so ha DOM e fetch.
 */

let state: AdminUiState = initialAdminState();

const list = document.querySelector<HTMLElement>('#adm-list');
const filter = document.querySelector<HTMLInputElement>('#adm-filter');
const count = document.querySelector<HTMLElement>('#adm-count');
const error = document.querySelector<HTMLElement>('#adm-error');

function showError(message: string): void {
  if (error === null) return;
  error.textContent = message;
  error.hidden = false;
}

function row(show: AdminShow): HTMLElement {
  const el = document.createElement('article');
  el.className = 'adm-row';
  el.dataset['showId'] = String(show.id);

  const cover = document.createElement('img');
  cover.className = 'adm-cover';
  cover.alt = '';
  if (show.posterUrl !== null) cover.src = show.posterUrl;

  const name = document.createElement('span');
  name.className = 'adm-name';
  name.textContent = show.name;

  const folder = document.createElement('span');
  folder.className = 'adm-folder';
  folder.textContent = show.folderName;

  const channel = document.createElement('span');
  channel.className = 'adm-channel';
  channel.textContent = String(show.channelNumber);

  const episodes = document.createElement('span');
  episodes.className = 'adm-eps';
  episodes.textContent = `${String(show.episodeCount)} ep.`;

  const badges = document.createElement('span');
  badges.className = 'adm-badges';
  for (const [active, text] of [
    [show.manual, 'manual'],
    [show.hidden, 'oculto'],
    [show.renamed, 'renomeado'],
  ] as const) {
    if (!active) continue;
    const badge = document.createElement('span');
    badge.className = 'adm-badge';
    badge.textContent = text;
    badges.append(badge);
  }

  el.append(cover, channel, name, folder, episodes, badges);
  return el;
}

function render(): void {
  if (list === null) return;
  const visible = visibleShows(state);
  list.replaceChildren(...visible.map(row));
  if (count !== null) {
    count.textContent = `${String(visible.length)} de ${String(state.shows.length)}`;
  }
}

filter?.addEventListener('input', () => {
  state = { ...state, filter: filter.value };
  render();
});

async function load(): Promise<void> {
  try {
    state = { ...state, shows: await fetchAdminShows() };
    render();
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
  }
}

void load();
