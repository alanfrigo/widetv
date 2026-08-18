import type { ShowAliasRow, ShowOverrideRow, ShowRow } from './index-store';
import { compareEpisodes, type ScannedShow } from './scanner.js';

/**
 * Curadoria humana aplicada a saida do scanner, antes de ela virar indice.
 *
 * O scanner deriva tudo do disco e o `upsertShow` reescreve `name` a cada
 * rodada: sem este passo, renomear e fundir a mao duram ate o rescan da
 * madrugada. Modulo PURO de proposito - nao abre banco nem disco -, entao a
 * regra que decide o catalogo e testavel sem SQLite e sem acervo.
 */

/**
 * Segue a cadeia de alias ate o slug final.
 *
 * A guarda de ciclo nao e paranoia: `addShowAlias` recusa ciclo na escrita,
 * mas um banco gravado por versao anterior (ou editado a mao) nao tem essa
 * garantia, e um laco aqui travaria o scan inteiro.
 */
export function resolveAliasTarget(slug: string, aliases: ReadonlyMap<string, string>): string {
  const seen = new Set<string>([slug]);
  let current = slug;
  for (;;) {
    const next = aliases.get(current);
    if (next === undefined) return current;
    if (seen.has(next)) return current;
    seen.add(next);
    current = next;
  }
}

/**
 * Funde as pastas com alias e aplica o nome escolhido a mao.
 *
 * Alias cujo alvo NAO apareceu nesta varredura e ignorado: a pasta fonte fica
 * como serie propria. Nao ha duplicata nesse caso - o alvo tambem nao esta la -
 * e apagar a fonte deixaria o acervo sem o canal enquanto o volume do alvo
 * estivesse fora.
 */
export function applyShowOverrides(
  shows: readonly ScannedShow[],
  aliases: readonly ShowAliasRow[],
  overrides: readonly ShowOverrideRow[],
): ScannedShow[] {
  const targetBySlug = new Map(aliases.map((row) => [row.slug, row.targetSlug] as const));
  const nameBySlug = new Map(
    overrides.filter((row) => row.name !== null).map((row) => [row.slug, row.name] as const),
  );
  const scannedSlugs = new Set(shows.map((show) => show.slug));

  const bySlug = new Map<string, ScannedShow>();
  const order: string[] = [];

  for (const show of shows) {
    const target = resolveAliasTarget(show.slug, targetBySlug);
    // Alvo fora da varredura: a fonte vale por si mesma nesta rodada.
    const destination = target !== show.slug && scannedSlugs.has(target) ? target : show.slug;

    const existing = bySlug.get(destination);
    if (existing === undefined) {
      bySlug.set(destination, { ...show, slug: destination });
      order.push(destination);
      continue;
    }

    // A serie que EMPRESTA o slug tambem empresta o caminho: `absolutePath` da
    // fonte apontaria para a pasta que deixou de ser canal.
    const base = existing.slug === show.slug ? show : existing;
    bySlug.set(destination, {
      slug: destination,
      name: base.name,
      absolutePath: base.absolutePath,
      episodes: [...existing.episodes, ...show.episodes],
    });
  }

  return order.map((slug) => {
    const show = bySlug.get(slug);
    /* c8 ignore next */
    if (show === undefined) throw new Error(`slug ${slug} sumiu do agrupamento`);
    const episodes = [...show.episodes].sort(compareEpisodes);
    return {
      ...show,
      name: nameBySlug.get(slug) ?? show.name,
      episodes: episodes.map((episode, index) => ({ ...episode, orderIndex: index })),
    };
  });
}

/**
 * Numeros de canal a reaplicar depois do scan.
 *
 * So existe para a serie APAGADA e recriada (pasta que sumiu e voltou): o
 * contador do indice nunca recicla numero, entao ela renasceria num canal
 * qualquer, longe do lugar que a pessoa escolheu.
 */
export function channelNumberFixes(
  shows: readonly ShowRow[],
  overrides: readonly ShowOverrideRow[],
): { showId: number; channelNumber: number }[] {
  const pinnedBySlug = new Map(
    overrides
      .filter((row) => row.channelNumber !== null)
      .map((row) => [row.slug, row.channelNumber] as const),
  );

  const fixes: { showId: number; channelNumber: number }[] = [];
  for (const show of shows) {
    const pinned = pinnedBySlug.get(show.slug);
    if (pinned === undefined || pinned === null) continue;
    if (pinned === show.channelNumber) continue;
    fixes.push({ showId: show.id, channelNumber: pinned });
  }
  return fixes;
}
