import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

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
  /** Id estavel derivado do nome da pasta (kebab-case, ASCII). */
  slug: string;
  /** Nome da pasta, como esta em disco. */
  name: string;
  absolutePath: string;
  episodes: ScannedEpisode[];
}

export interface ScanOptions {
  /** Extensoes aceitas, minusculas, com ponto. Default: ['.mp4', '.mkv', '.webm', '.m4v'] */
  extensions?: string[];
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
 */
function slugify(name: string): string {
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

/**
 * Ordinais escritos por extenso. Raros, mas `Terceira Temporada Incompleta`
 * existe no acervo e sem isso a serie inteira perde a numeracao.
 */
const ORDINAL_WORDS: Record<string, number> = {
  primeira: 1,
  segunda: 2,
  terceira: 3,
  quarta: 4,
  quinta: 5,
  sexta: 6,
  setima: 7,
  oitava: 8,
  nona: 9,
  decima: 10,
};

const SEASON_ORDINAL_WORD = /^([a-zà-ú]+)\s+(?:temporadas?|seasons?)\b/i;

/** Remove acento para casar `setima` com `sétima`. */
function deaccent(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Numero da temporada quando a pasta e de temporada; senao null. */
function parseSeasonFolder(folderName: string): number | null {
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
    throw new Error(
      `Raiz da biblioteca nao encontrada: ${root} (${reason})`,
      { cause },
    );
  }
  if (!stats.isDirectory()) {
    throw new Error(`Raiz da biblioteca nao e um diretorio: ${root}`);
  }
}

export async function scanLibrary(
  root: string,
  options?: ScanOptions,
): Promise<ScannedShow[]> {
  const extensions = options?.extensions ?? DEFAULT_EXTENSIONS;
  await assertDirectory(root);
  const rootReal = await fs.realpath(root);
  const entries = (await fs.readdir(root, { withFileTypes: true })).filter(
    (entry) => !isIgnoredName(entry.name),
  );
  const scanned = await mapWithConcurrency(
    entries,
    SHOW_CONCURRENCY,
    async (entry): Promise<ScannedShow | null> => {
      const showPath = path.join(root, entry.name);
      const info = await resolveEntry(entry, showPath, rootReal, rootReal);
      if (info?.kind !== 'directory') return null;

      const episodes: ScannedEpisode[] = [];
      await collectEpisodes(
        {
          root,
          rootReal,
          dir: showPath,
          dirReal: info.real,
          season: null,
          extensions,
          ancestors: [rootReal, info.real],
        },
        episodes,
      );
      // Serie sem nenhum episodio valido nao vira canal.
      if (episodes.length === 0) return null;

      return {
        slug: slugify(entry.name),
        name: entry.name,
        absolutePath: showPath,
        episodes,
      };
    },
  );

  const shows = scanned.filter((show): show is ScannedShow => show !== null);
  shows.sort((a, b) => compareNatural(a.name, b.name));
  return disambiguateSlugs(shows);
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
