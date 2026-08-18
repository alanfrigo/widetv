import type { AdminShow, AdminShowPatch } from '@shared/api-types';

import {
  applyMetadata,
  clearMetadata,
  fetchAdminShows,
  fetchMergeSuggestions,
  mergeShows,
  patchShow,
  searchMetadata,
  unmergeSlug,
} from './api';
import {
  canMerge,
  candidateLabel,
  initialAdminState,
  toggleMergeSource,
  visibleShows,
  type AdminUiState,
} from './state';
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
const mergeButton = document.querySelector<HTMLButtonElement>('#adm-fundir');

function showError(message: string): void {
  if (error === null) return;
  error.textContent = message;
  error.hidden = false;
}

/**
 * Apaga a faixa de erro.
 *
 * Chamada no INICIO de cada mutacao e de cada carga: sem isso a faixa vermelha
 * do erro anterior fica na tela por cima de dez acoes que deram certo, e a
 * pessoa continua lendo um problema que ja passou.
 */
function clearError(): void {
  if (error === null) return;
  error.textContent = '';
  error.hidden = true;
}

/**
 * Roda uma mutacao, recarrega do servidor e mostra erro se falhar.
 *
 * `clearMergeSelection` zera a selecao de fusao (alvo e fontes) depois de a
 * mutacao dar certo, ANTES de recarregar. So faz sentido nos dois caminhos
 * que fundem series: a fonte some do acervo, e um id que nao existe mais nao
 * pode continuar marcado - nem no radio do alvo nem na lista de fontes, ou o
 * proximo clique em "Fundir selecionados" tentaria fundir ids apagados. So
 * limpa em sucesso: se a fusao falhar as series continuam la e a selecao
 * continua valida.
 */
async function runMutation(
  action: () => Promise<unknown>,
  clearMergeSelection = false,
): Promise<void> {
  clearError();
  try {
    await action();
    if (clearMergeSelection) {
      state = { ...state, mergeTargetId: null, mergeSourceIds: [] };
    }
    await load();
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
  }
}

/** Aplica o patch e recarrega: o servidor e a verdade, nao o DOM. */
async function applyPatch(showId: number, patch: AdminShowPatch): Promise<void> {
  await runMutation(() => patchShow(showId, patch));
}

async function mergeSelected(): Promise<void> {
  // Desestrutura antes do `if`: `state` e `let` e pode ser reatribuido por
  // outro handler antes do closure abaixo rodar, entao o TypeScript nao
  // mantem o estreitamento de `state.mergeTargetId` dentro dele - so o de uma
  // constante local sobrevive.
  const { mergeTargetId, mergeSourceIds } = state;
  if (mergeTargetId === null || !canMerge(state)) return;
  await runMutation(() => mergeShows(mergeTargetId, mergeSourceIds), true);
}

/** Painel lateral de capa/sinopse: busca nos provedores e aplica ao clicar. */
async function openMetadataPanel(show: AdminShow): Promise<void> {
  const panel = document.querySelector<HTMLElement>('#adm-panel');
  if (panel === null) return;
  panel.hidden = false;
  panel.replaceChildren();

  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.value = show.name;

  const grid = document.createElement('div');
  grid.className = 'adm-grid';

  // Fechar e obrigatorio: o painel ocupa meia tela e, sem este botao, mudar de
  // ideia deixava a tabela coberta ate recarregar a pagina - so aplicar um
  // candidato o fechava.
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'adm-close';
  closeButton.textContent = 'Fechar';
  closeButton.addEventListener('click', () => {
    panel.hidden = true;
  });

  const resetButton = document.createElement('button');
  resetButton.type = 'button';
  resetButton.textContent = 'Voltar ao automático';
  resetButton.addEventListener('click', () => {
    void runMutation(() => clearMetadata(show.id));
  });

  const search = async (): Promise<void> => {
    clearError();
    grid.replaceChildren();
    try {
      for (const candidate of await searchMetadata(show.id, searchInput.value)) {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'adm-card';

        if (candidate.posterUrl !== null) {
          const poster = document.createElement('img');
          poster.src = candidate.posterUrl;
          poster.alt = '';
          card.append(poster);
        }
        const label = document.createElement('span');
        label.textContent = candidateLabel(candidate);
        const overview = document.createElement('small');
        overview.textContent = candidate.overview ?? '';
        card.append(label, overview);

        card.addEventListener('click', () => {
          void applyMetadata(show.id, candidate)
            .then(() => {
              panel.hidden = true;
              return load();
            })
            .catch((err: unknown) => {
              showError(err instanceof Error ? err.message : String(err));
            });
        });
        grid.append(card);
      }
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
    }
  };

  searchInput.addEventListener('change', () => {
    void search();
  });
  panel.append(closeButton, searchInput, resetButton);

  // Desfazer fusao: uma linha por pasta que foi fundida nesta serie. O efeito
  // real vem do scan que a rota dispara, entao a lista so muda na recarga.
  for (const slug of show.mergedSlugs) {
    const unmergeButton = document.createElement('button');
    unmergeButton.type = 'button';
    unmergeButton.textContent = `Soltar ${slug}`;
    unmergeButton.addEventListener('click', () => {
      void runMutation(() => unmergeSlug(show.id, slug));
    });
    panel.append(unmergeButton);
  }

  panel.append(grid);
  await search();
}

function row(show: AdminShow): HTMLElement {
  const el = document.createElement('article');
  el.className = 'adm-row';
  el.dataset['showId'] = String(show.id);

  const cover = document.createElement('img');
  cover.className = 'adm-cover';
  cover.alt = '';
  if (show.posterUrl !== null) cover.src = show.posterUrl;

  const nameInput = document.createElement('input');
  nameInput.className = 'adm-name-input';
  nameInput.value = show.name;
  nameInput.addEventListener('change', () => {
    void applyPatch(show.id, { name: nameInput.value });
  });

  const folder = document.createElement('span');
  folder.className = 'adm-folder';
  folder.textContent = show.folderName;

  const channelInput = document.createElement('input');
  channelInput.type = 'number';
  channelInput.min = '1';
  channelInput.className = 'adm-channel-input';
  channelInput.value = String(show.channelNumber);
  channelInput.addEventListener('change', () => {
    const channelNumber = Number(channelInput.value);
    if (!Number.isInteger(channelNumber) || channelNumber < 1) {
      channelInput.value = String(show.channelNumber);
      return;
    }
    void applyPatch(show.id, { channelNumber });
  });

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

  const hideButton = document.createElement('button');
  hideButton.type = 'button';
  hideButton.textContent = show.hidden ? 'Mostrar' : 'Ocultar';
  hideButton.addEventListener('click', () => {
    void applyPatch(show.id, { hidden: !show.hidden });
  });

  const artButton = document.createElement('button');
  artButton.type = 'button';
  artButton.textContent = 'Capa/Sinopse';
  artButton.addEventListener('click', () => {
    void openMetadataPanel(show);
  });

  const sourceCheckbox = document.createElement('input');
  sourceCheckbox.type = 'checkbox';
  sourceCheckbox.className = 'adm-source';
  sourceCheckbox.checked = state.mergeSourceIds.includes(show.id);
  sourceCheckbox.addEventListener('change', () => {
    state = toggleMergeSource(state, show.id);
    render();
  });

  const targetRadio = document.createElement('input');
  targetRadio.type = 'radio';
  targetRadio.name = 'adm-target';
  targetRadio.className = 'adm-target';
  targetRadio.checked = state.mergeTargetId === show.id;
  targetRadio.addEventListener('change', () => {
    state = {
      ...state,
      mergeTargetId: show.id,
      // Quem virou alvo sai da lista de fontes: fundir a serie nela mesma e o
      // unico jeito de este painel apagar episodio sem querer.
      mergeSourceIds: state.mergeSourceIds.filter((id) => id !== show.id),
    };
    render();
  });

  el.append(
    targetRadio,
    sourceCheckbox,
    cover,
    channelInput,
    nameInput,
    folder,
    episodes,
    badges,
    hideButton,
    artButton,
  );
  return el;
}

function render(): void {
  if (list === null) return;
  const visible = visibleShows(state);
  list.replaceChildren(...visible.map(row));
  if (count !== null) {
    count.textContent = `${String(visible.length)} de ${String(state.shows.length)}`;
  }
  if (mergeButton !== null) mergeButton.disabled = !canMerge(state);
}

filter?.addEventListener('input', () => {
  state = { ...state, filter: filter.value };
  render();
});

mergeButton?.addEventListener('click', () => {
  void mergeSelected();
});

/** Sugestoes de duplicados. Nada aqui funde sozinho: e uma lista de atalhos. */
async function loadSuggestions(): Promise<void> {
  const suggestionsEl = document.querySelector<HTMLElement>('#adm-suggestions');
  if (suggestionsEl === null) return;
  try {
    const suggestions = await fetchMergeSuggestions();
    const namesById = new Map(state.shows.map((show) => [show.id, show.name] as const));
    suggestionsEl.replaceChildren(
      ...suggestions.map((suggestion) => {
        const suggestionRow = document.createElement('div');
        suggestionRow.className = 'adm-suggestion';
        suggestionRow.textContent = suggestion.showIds
          .map((id) => namesById.get(id) ?? String(id))
          .join('  +  ');

        const mergeSuggestionButton = document.createElement('button');
        mergeSuggestionButton.type = 'button';
        mergeSuggestionButton.textContent = 'Fundir no primeiro';
        mergeSuggestionButton.addEventListener('click', () => {
          const [first, ...sources] = suggestion.showIds;
          if (first === undefined || sources.length === 0) return;
          // Mesma limpeza de `mergeSelected`: esta fusao pode incluir ids que
          // a pessoa tambem marcou na linha, e eles somem do acervo aqui.
          void runMutation(() => mergeShows(first, sources), true);
        });
        suggestionRow.append(mergeSuggestionButton);
        return suggestionRow;
      }),
    );
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
  }
}

async function load(): Promise<void> {
  clearError();
  try {
    state = { ...state, shows: await fetchAdminShows() };
    render();
    void loadSuggestions();
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
  }
}

void load();
