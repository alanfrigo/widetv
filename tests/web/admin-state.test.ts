import { describe, expect, test } from 'vitest';

import type { AdminShow } from '../../src/shared/api-types';
import {
  candidateLabel,
  canMerge,
  initialAdminState,
  toggleMergeSource,
  visibleShows,
  type AdminUiState,
} from '../../src/web/admin/state';

function show(id: number, name: string, folderName = name): AdminShow {
  return {
    id,
    slug: name.toLowerCase(),
    name,
    folderName,
    channelNumber: id,
    episodeCount: 1,
    seasons: [1],
    hidden: false,
    renamed: false,
    year: null,
    overview: null,
    source: null,
    manual: false,
    posterUrl: null,
    backdropUrl: null,
    mergedSlugs: [],
  };
}

describe('visibleShows', () => {
  test('filtra por nome e por pasta, sem acento e sem caixa', () => {
    const state = {
      ...initialAdminState(),
      shows: [show(1, 'Os Simpsons'), show(2, 'Padrinhos Mágicos', 'Padrinhos.Magicos.S01')],
    };

    expect(visibleShows({ ...state, filter: 'simpson' }).map((s) => s.id)).toEqual([1]);
    expect(visibleShows({ ...state, filter: 'magicos' }).map((s) => s.id)).toEqual([2]);
    expect(visibleShows({ ...state, filter: '  ' }).map((s) => s.id)).toEqual([1, 2]);
  });
});

describe('selecao de fusao', () => {
  test('marca e desmarca fonte, e o alvo nunca entra como fonte', () => {
    // Anotacao explicita: sem ela o literal `mergeTargetId: 1` estreita o tipo
    // para `number`, e a reatribuicao abaixo (que devolve `number | null`) nao
    // bate mais com o tipo inferido.
    let state: AdminUiState = {
      ...initialAdminState(),
      shows: [show(1, 'A'), show(2, 'B')],
      mergeTargetId: 1,
    };

    state = toggleMergeSource(state, 2);
    expect(state.mergeSourceIds).toEqual([2]);
    expect(canMerge(state)).toBe(true);

    state = toggleMergeSource(state, 1);
    expect(state.mergeSourceIds).toEqual([2]);

    state = toggleMergeSource(state, 2);
    expect(state.mergeSourceIds).toEqual([]);
    expect(canMerge(state)).toBe(false);
  });
});

describe('candidateLabel', () => {
  test('junta titulo, ano e provedor, e aguenta ano ausente', () => {
    expect(
      candidateLabel({
        source: 'tmdb',
        externalId: '1',
        title: 'Os Simpsons',
        year: 1989,
        overview: null,
        posterUrl: null,
        backdropUrl: null,
      }),
    ).toBe('Os Simpsons (1989) — tmdb');

    expect(
      candidateLabel({
        source: 'tvmaze',
        externalId: '2',
        title: 'Serie',
        year: null,
        overview: null,
        posterUrl: null,
        backdropUrl: null,
      }),
    ).toBe('Serie — tvmaze');
  });
});
