import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  ORDINAL_WORDS,
  deaccent,
  groupingKey,
  parseFolderTitle,
  type ParsedFolderTitle,
} from './title-parser.js';

export interface ScannedEpisode {
  absolutePath: string;
  /** Caminho relativo a raiz, com separador '/'. Id estavel do arquivo. */
  relativePath: string;
  /** Nome do arquivo sem extensao, usado como titulo de exibicao. */
  title: string;
  /** Numero da temporada quando derivavel da pasta ou do nome; senao null. */
  season: number | null;
  /** Numero do episodio quando derivavel do nome; senao null. */
  episode: number | null;
  /** Posicao 0-based na grade da serie, apos ordenacao. */
  orderIndex: number;
}

export interface ScannedShow {
  /** Id estavel derivado do nome (kebab-case, ASCII). */
  slug: string;
  /**
   * Nome de exibicao. Com `smartGrouping`, e o titulo limpo do grupo; sem ele,
   * o nome da pasta como esta em disco.
   */
  name: string;
  /** Pasta da serie; com agrupamento, a primeira do grupo em ordem natural. */
  absolutePath: string;
  episodes: ScannedEpisode[];
}

export interface ScanOptions {
  /** Extensoes aceitas, minusculas, com ponto. Default: ['.mp4', '.mkv', '.webm', '.m4v'] */
  extensions?: string[];
  /**
   * Junta pastas de release da mesma serie num show so. Default: true.
   */
  smartGrouping?: boolean;
}

const DEFAULT_EXTENSIONS = ['.mp4', '.mkv', '.webm', '.m4v'];

/** Lixo de NAS e de sistema operacional, nunca e conteudo. */
const IGNORED_NAMES = new Set(['@eadir', '#recycle', '#snapshot', 'lost+found']);

/** Oculto ou lixo conhecido, para arquivo e para pasta. */
function isIgnoredName(name: string): boolean {
  return name.startsWith('.') || IGNORED_NAMES.has(name.toLowerCase());
}

const naturalCollator = new Intl.Collator('pt-BR', {
  numeric: true,
  sensitivity: 'base',
});

/**
 * Natural sort case-insensitive: `ep2` antes de `ep10`, `Temporada 2` antes de
 * `Temporada 10`. Empate de caixa/acento cai para comparacao bruta, para a
 * ordem nao depender da ordem que o filesystem devolveu.
 */
function compareNatural(a: string, b: string): number {
  const byCollator = naturalCollator.compare(a, b);
  if (byCollator !== 0) return byCollator;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Converte o nome da pasta em id ASCII kebab-case. Nome sem nenhuma letra ASCII
 * (japones, cirilico, so simbolos) cai para um hash estavel do proprio nome, e
 * nunca devolve string vazia: o slug e chave da serie no resto do sistema.
 *
 * Exportado porque a limpeza de canais duplicados (dedupe.ts) precisa gerar o
 * MESMO slug para casar um titulo derivado com uma serie ja indexada.
 */
export function slugify(name: string): string {
  const ascii = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (ascii !== '') return ascii;

  const digest = createHash('sha1')
    .update(name.normalize('NFC'))
    .digest('hex')
    .slice(0, 10);
  return `serie-${digest}`;
}

/**
 * Pasta de temporada com a palavra na frente: `Temporada 3`, `Season 03`,
 * `S01`, `T1`, qualquer caixa, com ou sem zero a esquerda.
 */
const SEASON_WORD_FIRST = /^(?:temporadas?|seasons?|temp|s|t)[\s._-]*(\d{1,3})(?:\D|$)/i;

/**
 * Pasta de temporada com o numero na frente: `1a Temporada`, `10a Season`,
 * `1 Temporada`, `1a.Temporada.1959-1960`, `2a Temporada Legendada`.
 *
 * Esse e o formato dominante em acervo brasileiro, e e o inverso do anterior:
 * sem ele a maioria das series com temporada fica sem numero.
 */
const SEASON_NUMBER_FIRST = /^(\d{1,3})\s*[aoº°ªst]{0,2}[\s._-]*(?:temporadas?|seasons?)\b/i;

const SEASON_ORDINAL_WORD = /^([a-zà-ú]+)\s+(?:temporadas?|seasons?)\b/i;

/**
 * Numero da temporada quando a pasta e de temporada; senao null.
 *
 * Exportado porque a limpeza de canais duplicados (dedupe.ts) usa a mesma
 * assinatura para reconhecer um canal fantasma chamado "Temporada 37".
 */
export function parseSeasonFolder(folderName: string): number | null {
  const numberFirst = SEASON_NUMBER_FIRST.exec(folderName);
  if (numberFirst?.[1]) return Number.parseInt(numberFirst[1], 10);

  const wordFirst = SEASON_WORD_FIRST.exec(folderName);
  if (wordFirst?.[1]) return Number.parseInt(wordFirst[1], 10);

  const ordinal = SEASON_ORDINAL_WORD.exec(folderName);
  if (ordinal?.[1]) {
    return ORDINAL_WORDS[deaccent(ordinal[1]).toLowerCase()] ?? null;
  }

  return null;
}

interface ParsedName {
  season: number | null;
  episode: number | null;
}

/**
 * Melhor esforco sobre o nome do arquivo. Sem match confiavel devolve null nos
 * dois campos: nunca inventar numero, `orderIndex` ja da a posicao.
 */
function parseEpisodeName(title: string): ParsedName {
  const seasonEpisode = /\bs(\d{1,3})[\s._-]*e(\d{1,3})\b/i.exec(title);
  if (seasonEpisode?.[1] && seasonEpisode[2]) {
    return {
      season: Number.parseInt(seasonEpisode[1], 10),
      episode: Number.parseInt(seasonEpisode[2], 10),
    };
  }

  // Temporada limitada a 2 digitos para nao confundir com resolucao (720x480).
  const cross = /\b(\d{1,2})\s*x\s*(\d{1,3})\b/i.exec(title);
  if (cross?.[1] && cross[2]) {
    return {
      season: Number.parseInt(cross[1], 10),
      episode: Number.parseInt(cross[2], 10),
    };
  }

  // ' - 02 - ': o numero fica cercado por tracos, entre titulo e subtitulo.
  const dashed = /\s-\s*(\d{1,3})\s*-\s/.exec(title);
  if (dashed?.[1]) {
    return { season: null, episode: Number.parseInt(dashed[1], 10) };
  }

  // 'Ep 02', 'ep.2', 'Episodio 12', 'Episode 12'.
  const labelled = /\bep(?:\.|is[oó]dio|isode)?[\s._-]*(\d{1,3})\b/i.exec(title);
  if (labelled?.[1]) {
    return { season: null, episode: Number.parseInt(labelled[1], 10) };
  }

  // '[02]': numero sozinho entre colchetes, nao '[1080p]'.
  const bracketed = /\[\s*(\d{1,3})\s*\]/.exec(title);
  if (bracketed?.[1]) {
    return { season: null, episode: Number.parseInt(bracketed[1], 10) };
  }

  return { season: null, episode: null };
}

/** Caminho relativo a raiz sempre com '/', para servir de id estavel. */
function toRelativePath(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).split(path.sep).join('/');
}

interface CollectContext {
  root: string;
  /** Raiz com symlinks ja resolvidos; fronteira do que pode ser percorrido. */
  rootReal: string;
  dir: string;
  /** `dir` com symlinks resolvidos, para detectar ciclo e fuga da raiz. */
  dirReal: string;
  /** Temporada herdada da pasta mais proxima que casou com `SEASON_FOLDER`. */
  season: number | null;
  extensions: readonly string[];
  /** Caminhos reais das pastas na pilha de recursao; corta ciclo de symlink. */
  ancestors: readonly string[];
}

/** `candidate` esta dentro de `rootReal` (ou e a propria raiz)? */
function isInside(candidate: string, rootReal: string): boolean {
  return candidate === rootReal || candidate.startsWith(rootReal + path.sep);
}

type EntryKind = 'file' | 'directory';

interface ResolvedEntry {
  kind: EntryKind;
  /** Caminho real, ja garantido dentro da raiz. */
  real: string;
}

/**
 * Descobre se a entrada e arquivo ou pasta, resolvendo symlink. Devolve null
 * para link quebrado ou link que aponta para fora da raiz - a biblioteca nao
 * pode virar porta de saida para o resto do disco.
 */
async function resolveEntry(
  entry: Dirent,
  entryPath: string,
  parentReal: string,
  rootReal: string,
): Promise<ResolvedEntry | null> {
  // Caminho comum: nao e symlink, o caminho real sai do pai sem syscall extra.
  if (entry.isFile()) return { kind: 'file', real: path.join(parentReal, entry.name) };
  if (entry.isDirectory()) {
    return { kind: 'directory', real: path.join(parentReal, entry.name) };
  }
  if (!entry.isSymbolicLink()) return null;

  try {
    const real = await fs.realpath(entryPath);
    if (!isInside(real, rootReal)) return null;
    const stats = await fs.stat(entryPath);
    if (stats.isFile()) return { kind: 'file', real };
    if (stats.isDirectory()) return { kind: 'directory', real };
    return null;
  } catch {
    // Link quebrado ou sem permissao: nao e episodio.
    return null;
  }
}

/**
 * Percorre a pasta acumulando episodios em `out`, na ordem final da grade:
 * arquivos soltos primeiro, depois as subpastas, ambos em natural sort.
 */
async function collectEpisodes(
  context: CollectContext,
  out: ScannedEpisode[],
): Promise<void> {
  const all = await fs.readdir(context.dir, { withFileTypes: true });
  const entries = all.filter((entry) => !isIgnoredName(entry.name));
  entries.sort((a, b) => compareNatural(a.name, b.name));

  const resolved: { entry: Dirent; resolved: ResolvedEntry }[] = [];
  for (const entry of entries) {
    const entryPath = path.join(context.dir, entry.name);
    const info = await resolveEntry(entry, entryPath, context.dirReal, context.rootReal);
    if (info) resolved.push({ entry, resolved: info });
  }

  for (const { entry, resolved: info } of resolved) {
    if (info.kind !== 'file') continue;
    const extension = path.extname(entry.name).toLowerCase();
    if (!context.extensions.includes(extension)) continue;
    const absolutePath = path.join(context.dir, entry.name);
    const title = path.basename(entry.name, path.extname(entry.name));
    const parsed = parseEpisodeName(title);
    out.push({
      absolutePath,
      relativePath: toRelativePath(context.root, absolutePath),
      title,
      // A pasta de temporada manda; o nome so preenche quando ela nao diz nada.
      season: context.season ?? parsed.season,
      episode: parsed.episode,
      orderIndex: out.length,
    });
  }

  for (const { entry, resolved: info } of resolved) {
    if (info.kind !== 'directory') continue;
    // Symlink que volta para uma pasta ja aberta faria recursao infinita.
    if (context.ancestors.includes(info.real)) continue;
    await collectEpisodes(
      {
        root: context.root,
        rootReal: context.rootReal,
        dir: path.join(context.dir, entry.name),
        dirReal: info.real,
        // Subpasta sem numero (ex.: 'Bonus') mantem a temporada que veio de cima.
        season: parseSeasonFolder(entry.name) ?? context.season,
        extensions: context.extensions,
        ancestors: [...context.ancestors, info.real],
      },
      out,
    );
  }
}

/**
 * Quantas series sao percorridas ao mesmo tempo. Serial ingenuo trava em
 * biblioteca grande; ilimitado estoura o limite de file descriptors do NAS.
 */
const SHOW_CONCURRENCY = 8;

/** Roda `fn` sobre `items` com no maximo `limit` em voo, preservando a ordem. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor++;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await fn(item, index);
    }
  };

  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    worker,
  );
  await Promise.all(workers);
  return results;
}

/** A raiz precisa existir e ser diretorio; a mensagem sempre carrega o caminho. */
async function assertDirectory(root: string): Promise<void> {
  let stats;
  try {
    stats = await fs.stat(root);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    // Permissao negada NAO e "nao encontrada": dizer o nome errado do problema
    // manda o operador conferir o caminho quando o defeito e a ACL do dataset.
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      throw new Error(
        `Sem permissao para ler a raiz da biblioteca: ${root} (${reason})`,
        { cause },
      );
    }
    throw new Error(
      `Raiz da biblioteca nao encontrada: ${root} (${reason})`,
      { cause },
    );
  }
  if (!stats.isDirectory()) {
    throw new Error(`Raiz da biblioteca nao e um diretorio: ${root}`);
  }
}

/** Pasta de primeiro nivel que rendeu episodio, antes do agrupamento. */
interface ShowFolder {
  /** Nome cru da pasta, como esta em disco. */
  name: string;
  absolutePath: string;
  parsed: ParsedFolderTitle;
  episodes: ScannedEpisode[];
  /**
   * true quando a "pasta" e um ARQUIVO de video solto na raiz. Um grupo nunca
   * elege um arquivo como representante enquanto houver pasta de verdade: o
   * `absolutePath` da serie deve apontar para um diretorio quando existir um.
   */
  looseFile?: boolean;
}

/**
 * Arquivo de video SOLTO na raiz, sem pasta nenhuma ("The.Simpsons.S37E01...
 * .mkv" jogado direto na biblioteca). Ignora-lo faria o episodio sumir do
 * catalogo sem aviso; vira-lo canal proprio criaria um canal por arquivo. O
 * titulo mora no proprio nome: derivado de la, o arquivo entra no agrupamento
 * como qualquer pasta de release - e funde-se a serie quando ela existe.
 *
 * Nome sem serie nenhuma ("home video.mp4") continua invisivel: nao ha de onde
 * tirar um canal. Fora do smartGrouping nada muda: o modo antigo e uma pasta
 * por serie, e arquivo solto nunca foi canal la.
 */
function looseRootFile(
  root: string,
  absolutePath: string,
  name: string,
  extensions: readonly string[],
  smartGrouping: boolean,
): ShowFolder | null {
  if (!smartGrouping) return null;
  const extension = path.extname(name).toLowerCase();
  if (!extensions.includes(extension)) return null;

  const title = path.basename(name, path.extname(name));
  const parsedName = parseEpisodeName(title);
  const episode: ScannedEpisode = {
    absolutePath,
    relativePath: toRelativePath(root, absolutePath),
    title,
    season: parsedName.season,
    episode: parsedName.episode,
    orderIndex: 0,
  };
  const derived = titleFromEpisodes([{ title }]);
  if (derived === null) return null;
  return { name, absolutePath, parsed: derived, episodes: [episode], looseFile: true };
}

export async function scanLibrary(
  root: string,
  options?: ScanOptions,
): Promise<ScannedShow[]> {
  const extensions = options?.extensions ?? DEFAULT_EXTENSIONS;
  const smartGrouping = options?.smartGrouping ?? true;
  await assertDirectory(root);
  const rootReal = await fs.realpath(root);
  const entries = (await fs.readdir(root, { withFileTypes: true })).filter(
    (entry) => !isIgnoredName(entry.name),
  );
  // Ordena ANTES de percorrer: o representante do grupo (caminho e desempate de
  // titulo) sai da primeira pasta em ordem natural, e isso nao pode depender da
  // ordem em que o filesystem devolveu as entradas.
  entries.sort((a, b) => compareNatural(a.name, b.name));

  const scanned = await mapWithConcurrency(
    entries,
    SHOW_CONCURRENCY,
    async (entry): Promise<ShowFolder | null> => {
      const showPath = path.join(root, entry.name);
      const info = await resolveEntry(entry, showPath, rootReal, rootReal);
      if (info === null) return null;
      // Episodio solto como ARQUIVO direto na raiz: nao ha pasta para virar
      // canal, mas o arquivo existe e sumir com ele seria pior. Vira uma
      // pseudo-pasta batizada pelo proprio nome e entra no agrupamento normal.
      if (info.kind === 'file') {
        return looseRootFile(root, showPath, entry.name, extensions, smartGrouping);
      }

      let parsed = parseFolderTitle(entry.name);
      // Pasta que e SO temporada ("Temporada 37", "S05") solta na raiz: o
      // parser nao tira titulo nenhum dela (a busca do corte comeca no token
      // 1), entao `parsed.season` sai null - mas o numero existe e vale como
      // base dos episodios, igual a uma subpasta de temporada.
      const loneSeason =
        smartGrouping && parsed.season === null ? parseSeasonFolder(entry.name) : null;

      const episodes: ScannedEpisode[] = [];
      await collectEpisodes(
        {
          root,
          rootReal,
          dir: showPath,
          dirReal: info.real,
          // `Serie.S02.1080p...` carrega a temporada no proprio nome da pasta e
          // vale como base, igual a uma subpasta `Temporada 2`. Fora do
          // agrupamento isso fica null: o modo antigo nao pode mudar sozinho.
          season: smartGrouping ? (parsed.season ?? loneSeason) : null,
          extensions,
          ancestors: [rootReal, info.real],
        },
        episodes,
      );
      // Serie sem nenhum episodio valido nao vira canal.
      if (episodes.length === 0) return null;

      // A temporada solta nao tem titulo para oferecer, e sem titulo ela
      // viraria um canal proprio ("temporada-37" nunca casa com "the-simpsons"
      // no agrupamento). O titulo esta onde ele realmente mora: no nome dos
      // arquivos ("The.Simpsons.S37E01..."). Derivado de la, a pasta entra no
      // grupo da serie como qualquer pasta de release.
      if (loneSeason !== null) {
        const derived = titleFromEpisodes(episodes);
        if (derived !== null) {
          parsed = { title: derived.title, year: derived.year, season: loneSeason, isRelease: true };
        }
      }

      return { name: entry.name, absolutePath: showPath, parsed, episodes };
    },
  );

  const folders = scanned.filter((folder): folder is ShowFolder => folder !== null);
  const shows = smartGrouping ? groupFolders(folders) : folders.map(toRawShow);
  shows.sort((a, b) => compareNatural(a.name, b.name));
  return disambiguateSlugs(shows);
}

/**
 * Titulo da serie derivado dos NOMES DE ARQUIVO ("The.Simpsons.S37E01...").
 * Voto de maioria absoluta entre os episodios: um arquivo fora do padrao nao
 * pode rebatizar a pasta inteira, e empate nao decide nada.
 *
 * So precisa dos titulos, e e exportado por isso: a limpeza de canais
 * duplicados (dedupe.ts) faz o mesmo voto sobre linhas ja indexadas.
 * @returns null quando os arquivos nao carregam serie nenhuma ("01.mp4").
 */
export function titleFromEpisodes(
  episodes: readonly { title: string }[],
): ParsedFolderTitle | null {
  const votes = new Map<string, { count: number; parsed: ParsedFolderTitle }>();
  for (const episode of episodes) {
    const parsed = parseFolderTitle(episode.title);
    // So um nome que PERDEU pedaco no parse (temporada/release cortados) prova
    // que carrega um titulo de serie; "01" cru nao prova nada.
    if (!parsed.isRelease || parsed.title === episode.title) continue;
    const key = groupingKey(parsed);
    const vote = votes.get(key);
    if (vote === undefined) votes.set(key, { count: 1, parsed });
    else vote.count += 1;
  }

  let best: { count: number; parsed: ParsedFolderTitle } | null = null;
  for (const vote of votes.values()) {
    if (best === null || vote.count > best.count) best = vote;
  }
  return best !== null && best.count * 2 > episodes.length ? best.parsed : null;
}

/** Modo antigo: uma pasta e uma serie, e a ordem da grade e a da caminhada. */
function toRawShow(folder: ShowFolder): ScannedShow {
  return {
    slug: slugify(folder.name),
    name: folder.name,
    absolutePath: folder.absolutePath,
    episodes: folder.episodes,
  };
}

/**
 * Junta as pastas do mesmo grupo num show so.
 *
 * Reordenar os episodios depois da uniao nao e cosmetico: a grade ao vivo e o
 * catalogo leem `orderIndex`, e a ordem em que as pastas foram lidas nao tem
 * relacao nenhuma com a ordem das temporadas - sem isso a S02 estrearia antes
 * da S01 dependendo do filesystem.
 */
function groupFolders(folders: readonly ShowFolder[]): ScannedShow[] {
  const shows: ScannedShow[] = [];
  for (const group of buildGroups(folders)) {
    // Arquivo solto na raiz nunca representa o grupo enquanto houver pasta de
    // verdade: o caminho da serie deve apontar para um diretorio quando existe.
    const first = group.find((folder) => folder.looseFile !== true) ?? group[0];
    if (first === undefined) continue;

    const name = pickTitle(group, first);
    const episodes = group.flatMap((folder) => folder.episodes);
    episodes.sort(compareEpisodes);
    shows.push({
      slug: slugify(name),
      name,
      absolutePath: first.absolutePath,
      episodes: episodes.map((episode, index) => ({ ...episode, orderIndex: index })),
    });
  }
  return shows;
}

/**
 * Regra conservadora contra fusao falsa.
 *
 * Pastas so entram no mesmo grupo quando a chave bate E pelo menos uma delas
 * tem `isRelease` - ou seja, houve token de release/temporada/grupo removido,
 * que e o unico sinal confiavel de que aquele nome e um pedaco de uma serie
 * maior. Sem nenhum sinal desses, so funde quem tem titulo IDENTICO depois da
 * limpeza ("Tom.e.Jerry" com "Tom e Jerry"), porque a chave e um slug ASCII e
 * colapsa coisas que sao series diferentes de verdade ("Acao" e "Ação").
 *
 * "The Office (US)" e "The Office (UK)" nunca se encontram: sufixo diferente ja
 * gera chave diferente, antes de qualquer decisao de fusao.
 */
function buildGroups(folders: readonly ShowFolder[]): ShowFolder[][] {
  // Indexa pela base SEM ano, com o ano como sub-chave. O ano nao pode morar
  // embutido na chave (groupingKey completo): ele precisa ficar visivel ate a
  // fusao para servir de DESEMPATE em `mergeLoneYear`, e nao de discriminante
  // absoluto que impede "The Simpsons (1989)" de encontrar o titulo derivado
  // dos arquivos (que nunca carrega ano).
  const byBase = new Map<string, Map<number | null, ShowFolder[]>>();
  for (const folder of folders) {
    const base = groupingKey({ ...folder.parsed, year: null });
    let byYear = byBase.get(base);
    if (byYear === undefined) {
      byYear = new Map();
      byBase.set(base, byYear);
    }
    push(byYear, folder.parsed.year, folder);
  }

  // A ordem natural da raiz elege o representante do grupo (caminho e
  // desempate de titulo); a fusao de buckets nao pode embaralha-la.
  const position = new Map(folders.map((folder, index) => [folder, index] as const));

  const groups: ShowFolder[][] = [];
  for (const byYear of byBase.values()) {
    mergeLoneYear(byYear, position);
    for (const bucket of byYear.values()) {
      if (bucket.some((folder) => folder.parsed.isRelease)) {
        groups.push(bucket);
        continue;
      }
      const byTitle = new Map<string, ShowFolder[]>();
      for (const folder of bucket) {
        push(byTitle, folder.parsed.title.normalize('NFC'), folder);
      }
      groups.push(...byTitle.values());
    }
  }
  return groups;
}

/**
 * Funde o bucket SEM ano com o unico bucket COM ano da mesma base.
 *
 * O ano na chave existe para separar "Doctor Who (2005)" de "Doctor Who
 * (1963)". Mas titulo derivado de NOME DE ARQUIVO nunca carrega ano, entao a
 * pasta principal "The Simpsons (1989)" e a temporada solta batizada pelos
 * arquivos nunca se encontrariam - e o catalogo mostraria DOIS canais com o
 * MESMO nome, um slug com digest no segundo. Aqui o ano vira desempate: com um
 * ano so em jogo e sinal de release na uniao (a mesma regra conservadora dos
 * buckets), os dois lados sao a mesma serie.
 *
 * Duas series homonimas de anos DIFERENTES continuam separadas (fundir o sem-
 * ano com qualquer uma delas seria adivinhacao), e sem release nada se move:
 * "Acao" e "Ação (1989)" seguem canais proprios.
 */
function mergeLoneYear(
  byYear: Map<number | null, ShowFolder[]>,
  position: ReadonlyMap<ShowFolder, number>,
): void {
  const yearless = byYear.get(null);
  if (yearless === undefined) return;

  const years = [...byYear.keys()].filter((year): year is number => year !== null);
  if (years.length !== 1 || years[0] === undefined) return;
  const dated = byYear.get(years[0]);
  if (dated === undefined) return;

  if (![...dated, ...yearless].some((folder) => folder.parsed.isRelease)) return;

  dated.push(...yearless);
  dated.sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0));
  byYear.delete(null);
}

function push<Key>(index: Map<Key, ShowFolder[]>, key: Key, folder: ShowFolder): void {
  const bucket = index.get(key);
  if (bucket === undefined) index.set(key, [folder]);
  else bucket.push(folder);
}

/**
 * Titulo mais rico do grupo: quem tem ano primeiro, depois o mais longo. Empate
 * fica com o primeiro em ordem natural, que e como a lista chegou aqui - o nome
 * do canal nao pode depender de quem o disco leu antes.
 */
function pickTitle(group: readonly ShowFolder[], first: ShowFolder): string {
  let best = first.parsed;
  for (const folder of group) {
    const candidate = folder.parsed;
    const richer =
      (candidate.year !== null) !== (best.year !== null)
        ? candidate.year !== null
        : candidate.title.length > best.title.length;
    if (richer) best = candidate;
  }
  return best.title;
}

/** Temporada, depois episodio, e o que nao tem numero nenhum vai para o fim. */
function compareEpisodes(a: ScannedEpisode, b: ScannedEpisode): number {
  const seasonA = a.season ?? Number.POSITIVE_INFINITY;
  const seasonB = b.season ?? Number.POSITIVE_INFINITY;
  if (seasonA !== seasonB) return seasonA - seasonB;

  const episodeA = a.episode ?? Number.POSITIVE_INFINITY;
  const episodeB = b.episode ?? Number.POSITIVE_INFINITY;
  if (episodeA !== episodeB) return episodeA - episodeB;

  return compareNatural(a.relativePath, b.relativePath);
}

/**
 * Garante um slug por serie.
 *
 * "Acao" e "Acao" com cedilha e acento colapsam no mesmo slug depois da
 * normalizacao. Como o slug e a chave idempotente da serie no indice, e o numero
 * do canal e amarrado a ela, uma colisao faria duas series virarem um canal so e
 * a segunda sumiria sem aviso nenhum.
 *
 * A desambiguacao roda sobre a lista JA ordenada por nome: quem aparece primeiro
 * fica com o slug limpo e so os seguintes recebem sufixo. Assim adicionar uma
 * serie nova nao renomeia a chave de quem ja estava indexado.
 */
function disambiguateSlugs(shows: readonly ScannedShow[]): ScannedShow[] {
  const seen = new Set<string>();
  return shows.map((show) => {
    if (!seen.has(show.slug)) {
      seen.add(show.slug);
      return show;
    }
    // Sufixo derivado do nome completo, nao de um contador: dois acervos com as
    // mesmas pastas geram os mesmos slugs, em qualquer ordem de leitura.
    const digest = createHash('sha1').update(show.name.normalize('NFC')).digest('hex').slice(0, 6);
    let slug = `${show.slug}-${digest}`;
    // Empate no digest e improvavel, mas um slug repetido aqui reintroduziria
    // exatamente o bug que esta funcao existe para evitar.
    for (let n = 2; seen.has(slug); n += 1) slug = `${show.slug}-${digest}-${n}`;
    seen.add(slug);
    return { ...show, slug };
  });
}
