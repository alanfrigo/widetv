import { createHash } from 'node:crypto';
import path from 'node:path';

import type { ShowRow, Store } from './index-store';
import { parseSeasonFolder, slugify, titleFromEpisodes } from './scanner.js';
import { parseFolderTitle } from './title-parser.js';

/**
 * Limpeza de canais duplicados que scanners antigos deixaram no indice.
 *
 * O prune do fim do scan ja remove essas linhas - mas SO em rodada perfeita:
 * uma raiz sem permissao (EACCES), um volume desmontado ou um probe que lanca
 * matam o scan ANTES do prune, e o par duplicado sobrevive indefinidamente,
 * rescan diario apos rescan diario. Por isso esta limpeza roda no COMECO do
 * scan, antes de tocar o disco: ela nao depende de nada dar certo depois.
 *
 * Duas assinaturas, ambas verificaveis sem olhar o disco:
 *
 * 1. Gemeos de digest: 'the-simpsons' e 'the-simpsons-a1b2c3' com o MESMO
 *    nome. E o rastro de `disambiguateSlugs` quando o agrupamento falhava em
 *    fundir a serie (ano na pasta principal, temporada solta) - dois canais
 *    identicos no catalogo. O sufixo e recalculavel a partir do nome, entao a
 *    verificacao e exata: nenhum slug legitimo que por acaso termine em traco
 *    e seis hex cai aqui por engano.
 *
 * 2. Canal fantasma de temporada: serie chamada "Temporada 37" cujos ARQUIVOS
 *    dizem a que serie pertencem ("The.Simpsons.S37E01..."). E o rastro do
 *    scanner de antes da derivacao de titulo. So funde quando a maioria dos
 *    episodios vota no mesmo titulo E a serie alvo ja existe no indice.
 *
 * O sobrevivente e sempre o de slug LIMPO (ou a serie alvo do voto), e nao o
 * de menor numero de canal: o slug limpo e o que o proximo scan emite, e
 * preservar qualquer outro recriaria a duplicata na rodada seguinte.
 */
export function mergeDuplicateShows(store: Store): number {
  const shows = store.listShows();
  const bySlug = new Map(shows.map((show) => [show.slug, show] as const));

  // Ids ja fundidos nesta passada: um alvo que deixou de existir nao pode
  // receber episodios. Cadeia real e improvavel, mas mover linhas para um
  // show_id apagado quebraria a FK - o que sobrar sai na proxima rodada.
  const gone = new Set<number>();

  let merged = 0;
  for (const show of shows) {
    if (gone.has(show.id)) continue;
    const target = digestTwinTarget(show, bySlug) ?? seasonGhostTarget(show, bySlug, store);
    if (target === null || gone.has(target.id)) continue;

    store.mergeShows(show.id, target.id);
    bySlug.delete(show.slug);
    gone.add(show.id);
    merged += 1;
  }
  return merged;
}

/** Sufixo que `disambiguateSlugs` cria: '-<6 hex>' e, em empate, '-<n>'. */
const DIGEST_SUFFIX = /^(?<base>.+)-(?<digest>[0-9a-f]{6})(?:-\d+)?$/;

/** O mesmo digest de `disambiguateSlugs`: sha1 do nome NFC, 6 primeiros hex. */
function digestOf(name: string): string {
  return createHash('sha1').update(name.normalize('NFC')).digest('hex').slice(0, 6);
}

/**
 * Alvo do gemeo de digest: a serie de slug limpo com o MESMO nome. O digest
 * recalculado do nome tem que bater com o do sufixo - e a prova de que o slug
 * saiu de `disambiguateSlugs`, e nao de uma pasta que termina em hex.
 *
 * Nome identico ainda nao basta: "Doctor Who (1963)" e "Doctor Who (2005)"
 * tambem viram dois canais chamados "Doctor Who" com digest no segundo, e sao
 * series DIFERENTES de proposito. A ultima palavra e de `wouldMerge`, que
 * refaz sobre os caminhos em disco a mesma decisao que o scanner faria - a
 * limpeza nunca pode fundir o que o proximo scan vai separar de novo, senao o
 * catalogo entra num cabo de guerra de canal apagado e recriado a cada rodada.
 */
function digestTwinTarget(
  show: ShowRow,
  bySlug: ReadonlyMap<string, ShowRow>,
): ShowRow | null {
  const match = DIGEST_SUFFIX.exec(show.slug);
  const base = match?.groups?.['base'];
  const digest = match?.groups?.['digest'];
  if (base === undefined || digest === undefined) return null;
  if (digest !== digestOf(show.name)) return null;

  const target = bySlug.get(base);
  if (target === undefined || target.id === show.id) return null;
  if (target.name !== show.name) return null;
  if (!wouldMerge(folderParse(show.absolutePath), folderParse(target.absolutePath))) return null;
  return target;
}

interface FolderSignal {
  year: number | null;
  isRelease: boolean;
}

/**
 * Reconstitui, a partir do caminho gravado, o parse que o scanner fez da
 * pasta. Pasta que e SO temporada ("Temporada 37") conta como release sem ano:
 * e assim que o scanner a trata depois de derivar o titulo dos arquivos.
 */
function folderParse(absolutePath: string): FolderSignal {
  const name = path.basename(absolutePath);
  const parsed = parseFolderTitle(name);
  if (parsed.season === null && parseSeasonFolder(name) !== null) {
    return { year: null, isRelease: true };
  }
  return { year: parsed.year, isRelease: parsed.isRelease };
}

/**
 * A mesma regra de fusao do scanner (`buildGroups`/`mergeLoneYear`), aplicada
 * ao par: precisa de sinal de release em algum lado, e o ano so desempata -
 * dois anos DIFERENTES sao duas series, e nada os junta.
 */
function wouldMerge(a: FolderSignal, b: FolderSignal): boolean {
  if (!a.isRelease && !b.isRelease) return false;
  return a.year === null || b.year === null || a.year === b.year;
}

/**
 * Alvo do canal fantasma: a serie que os nomes de arquivo apontam. As mesmas
 * duas condicoes do scanner para "pasta que e SO temporada" (nenhum titulo no
 * nome, numero de temporada presente), e o mesmo voto de maioria de
 * `titleFromEpisodes` - so que sobre as linhas ja indexadas.
 */
function seasonGhostTarget(
  show: ShowRow,
  bySlug: ReadonlyMap<string, ShowRow>,
  store: Store,
): ShowRow | null {
  if (parseFolderTitle(show.name).season !== null) return null;
  if (parseSeasonFolder(show.name) === null) return null;

  const derived = titleFromEpisodes(store.listEpisodes(show.id));
  if (derived === null) return null;

  const target = bySlug.get(slugify(derived.title));
  if (target === undefined || target.id === show.id) return null;
  return target;
}
