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
  const visto = new Set<string>([slug]);
  let atual = slug;
  for (;;) {
    const proximo = aliases.get(atual);
    if (proximo === undefined) return atual;
    if (visto.has(proximo)) return atual;
    visto.add(proximo);
    atual = proximo;
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
  const mapa = new Map(aliases.map((row) => [row.slug, row.targetSlug] as const));
  const nomes = new Map(
    overrides.filter((row) => row.name !== null).map((row) => [row.slug, row.name] as const),
  );
  const presentes = new Set(shows.map((show) => show.slug));

  const porSlug = new Map<string, ScannedShow>();
  const ordem: string[] = [];

  for (const show of shows) {
    const alvo = resolveAliasTarget(show.slug, mapa);
    // Alvo fora da varredura: a fonte vale por si mesma nesta rodada.
    const destino = alvo !== show.slug && presentes.has(alvo) ? alvo : show.slug;

    const existente = porSlug.get(destino);
    if (existente === undefined) {
      porSlug.set(destino, { ...show, slug: destino });
      ordem.push(destino);
      continue;
    }

    // A serie que EMPRESTA o slug tambem empresta o caminho: `absolutePath` da
    // fonte apontaria para a pasta que deixou de ser canal.
    const base = existente.slug === show.slug ? show : existente;
    porSlug.set(destino, {
      slug: destino,
      name: base.name,
      absolutePath: base.absolutePath,
      episodes: [...existente.episodes, ...show.episodes],
    });
  }

  return ordem.map((slug) => {
    const show = porSlug.get(slug);
    /* c8 ignore next */
    if (show === undefined) throw new Error(`slug ${slug} sumiu do agrupamento`);
    const episodes = [...show.episodes].sort(compareEpisodes);
    return {
      ...show,
      name: nomes.get(slug) ?? show.name,
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
  const fixos = new Map(
    overrides
      .filter((row) => row.channelNumber !== null)
      .map((row) => [row.slug, row.channelNumber] as const),
  );

  const fixes: { showId: number; channelNumber: number }[] = [];
  for (const show of shows) {
    const alvo = fixos.get(show.slug);
    if (alvo === undefined || alvo === null) continue;
    if (alvo === show.channelNumber) continue;
    fixes.push({ showId: show.id, channelNumber: alvo });
  }
  return fixes;
}
