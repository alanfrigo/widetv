import type { AdminShow, MetadataCandidate } from '@shared/api-types';

/**
 * Estado da tela de administracao: decisao pura, sem DOM.
 *
 * Mesmo desenho de `settings.ts`: aqui mora o que a tela mostra e o que ela
 * deixa fazer; quem desenha e quem fala com a rede e o `admin.ts`.
 */

export interface AdminUiState {
  shows: AdminShow[];
  filter: string;
  /** Serie que RECEBE a fusao; null antes de a pessoa escolher. */
  mergeTargetId: number | null;
  mergeSourceIds: number[];
}

export function initialAdminState(): AdminUiState {
  return { shows: [], filter: '', mergeTargetId: null, mergeSourceIds: [] };
}

/** Acento e caixa fora: quem digita "magicos" procura "Magicos". */
function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

export function visibleShows(state: AdminUiState): AdminShow[] {
  const term = normalize(state.filter.trim());
  if (term === '') return state.shows;
  return state.shows.filter(
    (show) => normalize(show.name).includes(term) || normalize(show.folderName).includes(term),
  );
}

/**
 * Marca ou desmarca uma serie como FONTE da fusao.
 *
 * O alvo nunca entra: fundir a serie nela mesma e o unico jeito de o painel
 * apagar episodios sem querer, e a rota recusa - melhor a tela nem oferecer.
 */
export function toggleMergeSource(state: AdminUiState, showId: number): AdminUiState {
  if (showId === state.mergeTargetId) return state;
  const marked = state.mergeSourceIds.includes(showId);
  return {
    ...state,
    mergeSourceIds: marked
      ? state.mergeSourceIds.filter((id) => id !== showId)
      : [...state.mergeSourceIds, showId],
  };
}

export function canMerge(state: AdminUiState): boolean {
  return state.mergeTargetId !== null && state.mergeSourceIds.length > 0;
}

/** Rotulo do candidato na grade. Ano ausente nao deixa parenteses vazio. */
export function candidateLabel(candidate: MetadataCandidate): string {
  const year = candidate.year === null ? '' : ` (${String(candidate.year)})`;
  return `${candidate.title}${year} — ${candidate.source}`;
}
