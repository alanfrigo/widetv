import {
  API,
  type AdminShow,
  type AdminShowPatch,
  type MergeSuggestion,
  type MetadataCandidate,
} from '@shared/api-types';

/**
 * Cliente do painel. 401 nao tenta login aqui: a tela de senha mora na SPA de
 * TV, e duplica-la seria uma segunda porta para manter.
 */

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', ...init });
  if (response.status === 401) {
    window.location.href = '/';
    throw new Error('sessao expirada');
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${url} respondeu ${String(response.status)}`);
  }
  return (await response.json()) as T;
}

const JSON_HEADERS = { 'content-type': 'application/json' };

export function fetchAdminShows(): Promise<AdminShow[]> {
  return json<AdminShow[]>(API.adminShows);
}

export function fetchMergeSuggestions(): Promise<MergeSuggestion[]> {
  return json<MergeSuggestion[]>(API.adminMergeSuggestions);
}

export function patchShow(showId: number, patch: AdminShowPatch): Promise<AdminShow> {
  return json<AdminShow>(API.adminShow(showId), {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  });
}

export function mergeShows(targetId: number, sourceIds: number[]): Promise<unknown> {
  return json(API.adminMerge(targetId), {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ sourceIds }),
  });
}

export function unmergeSlug(showId: number, slug: string): Promise<unknown> {
  return json(API.adminUnmerge(showId), {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ slug }),
  });
}

export function searchMetadata(showId: number, term: string): Promise<MetadataCandidate[]> {
  return json<MetadataCandidate[]>(
    `${API.adminMetadataSearch(showId)}?q=${encodeURIComponent(term)}`,
  );
}

export function applyMetadata(showId: number, candidate: MetadataCandidate): Promise<AdminShow> {
  return json<AdminShow>(API.adminMetadata(showId), {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ candidate }),
  });
}

export function clearMetadata(showId: number): Promise<unknown> {
  return json(API.adminMetadata(showId), { method: 'DELETE' });
}
