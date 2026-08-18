import type { ShowRow } from './index-store';
import { groupingKey, parseFolderTitle } from './title-parser.js';

/**
 * Candidatos a fusao MANUAL.
 *
 * Diferente de `dedupe.ts`, que funde sozinho e por isso so aceita prova
 * verificavel sem olhar o disco, aqui nada acontece sem um clique: o custo de
 * um palpite errado e a pessoa ignorar a linha. Ainda assim a regra do ano
 * vale - "Doctor Who (1963)" e "(2005)" sao duas series de proposito, e
 * oferece-las juntas todo dia treinaria a pessoa a ignorar a lista.
 */

export interface SuggestedMerge {
  reason: 'nome-identico' | 'slug-parecido';
  /** Alvo sugerido primeiro: o de mais episodios. */
  showIds: number[];
}

/** O sufixo que `disambiguateSlugs` cria: '-<6 hex>' e, em empate, '-<n>'. */
const DIGEST_SUFFIX = /^(?<base>.+)-[0-9a-f]{6}(?:-\d+)?$/;

function slugBase(slug: string): string {
  return DIGEST_SUFFIX.exec(slug)?.groups?.['base'] ?? slug;
}

function groupBy(
  shows: readonly ShowRow[],
  keyOf: (show: ShowRow) => string,
): Map<string, ShowRow[]> {
  const groups = new Map<string, ShowRow[]>();
  for (const show of shows) {
    const key = keyOf(show);
    const current = groups.get(key);
    if (current === undefined) groups.set(key, [show]);
    else current.push(show);
  }
  return groups;
}

export function suggestMerges(
  shows: readonly ShowRow[],
  episodeCounts: ReadonlyMap<number, number>,
): SuggestedMerge[] {
  const suggestions: SuggestedMerge[] = [];
  // Serie ja sugerida por nome nao volta pela chave do slug: uma linha por par
  // e o que mantem a lista lida, e o motivo mais forte manda.
  const used = new Set<number>();

  const emit = (groups: Map<string, ShowRow[]>, reason: SuggestedMerge['reason']): void => {
    for (const group of groups.values()) {
      const free = group.filter((show) => !used.has(show.id));
      if (free.length < 2) continue;
      const sorted = [...free].sort(
        (a, b) => (episodeCounts.get(b.id) ?? 0) - (episodeCounts.get(a.id) ?? 0) || a.id - b.id,
      );
      for (const show of sorted) used.add(show.id);
      suggestions.push({ reason, showIds: sorted.map((show) => show.id) });
    }
  };

  // `groupingKey` ja carrega o ano quando ele existe ("serie@1963"), entao a
  // separacao de remakes sai de graca.
  emit(groupBy(shows, (show) => groupingKey(parseFolderTitle(show.name))), 'nome-identico');
  emit(groupBy(shows, (show) => slugBase(show.slug)), 'slug-parecido');

  return suggestions;
}
