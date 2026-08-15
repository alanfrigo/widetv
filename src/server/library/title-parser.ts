/**
 * Nome de pasta -> titulo legivel, temporada e ano.
 *
 * Existe porque acervo de release nao segue "uma pasta = uma serie":
 * `Rick.and.Morty.S01...`, `Rick.and.Morty.S02...` e `Rick.and.Morty.S03...` sao
 * a MESMA serie em tres pastas. Sem desmontar o nome nao da para junta-las, e o
 * catalogo vira o mesmo desenho repetido tres vezes, cada canal com um pedaco.
 *
 * O modulo e puro de proposito: decide so a partir do texto. Assim cada regra
 * ganha teste tabelado, sem montar arvore em disco - e o scanner fica livre para
 * cuidar so de filesystem.
 */

/** Tira acento para comparar 'setima' com 'setima' acentuado. */
export function deaccent(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Ordinais escritos por extenso. Raros, mas `Terceira Temporada Incompleta`
 * existe no acervo e sem isso a serie inteira perde a numeracao.
 */
export const ORDINAL_WORDS: Record<string, number> = {
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

export interface ParsedFolderTitle {
  /** Titulo limpo e legivel, ex. "Rick and Morty". Nunca vazio. */
  title: string;
  /** Temporada quando a pasta carrega uma, ex. S01 -> 1. null quando nao carrega. */
  season: number | null;
  /** Ano entre parenteses ou solto na posicao de ano, ex. 1992. null quando ausente. */
  year: number | null;
  /** true quando sobrou informacao de release suficiente para confiar no agrupamento. */
  isRelease: boolean;
}

/**
 * Tokens de release. A lista e grande de proposito: cada entrada que falta vira
 * um canal duplicado no catalogo, e cada entrada errada come uma palavra do
 * titulo - por isso o que e ambiguo mora tambem em `AMBIGUOUS_TOKENS`.
 */
const RELEASE_TOKENS = new Set<string>([
  // resolucao
  '480p', '576p', '720p', '1080p', '1440p', '2160p', '4k', '8k', 'uhd', 'fhd', 'hd', 'sd',
  // fonte
  'web-dl', 'webdl', 'webrip', 'web', 'hdtv', 'pdtv', 'bluray', 'blu-ray', 'bdrip', 'brrip',
  'bdremux', 'dvdrip', 'dvd', 'dvdscr', 'remux', 'hdrip', 'cam', 'ts',
  // plataforma
  'nf', 'amzn', 'hmax', 'max', 'dsnp', 'atvp', 'hulu', 'pmtp', 'stan', 'cr', 'it', 'appletv',
  'globoplay', 'crunchyroll',
  // video
  'x264', 'x265', 'h264', 'h265', 'hevc', 'avc', 'xvid', 'divx', '10bit', '8bit', 'hdr',
  'hdr10', 'hdr10+', 'dv', 'dovi', 'sdr',
  // audio
  'dd', 'dd+', 'ddp', 'aac', 'ac3', 'eac3', 'dts', 'dts-hd', 'truehd', 'atmos', 'flac',
  'mp3', 'opus',
  // tags
  'dual', 'dublado', 'dublada', 'legendado', 'legendada', 'leg', 'multi', 'multi-audio',
  'proper', 'repack', 'extended', 'uncut', 'unrated', 'internal', 'limited', 'complete',
  'completa', 'completo', 'remastered', 'imax', 'openmatte',
]);

/**
 * Tokens de release que TAMBEM sao palavra de titulo: "Mad Max", "IT", "CR",
 * "Open Season". So caem quando o vizinho da esquerda tambem e release, porque
 * em nome de release a plataforma vem depois da resolucao e nunca colada no
 * titulo. Sem esse freio, "Mad Max" viraria "Mad".
 */
const AMBIGUOUS_TOKENS = new Set<string>([
  'hd', 'sd', 'uhd', 'fhd', '4k', '8k', 'max', 'it', 'cr', 'nf', 'dv', 'ts', 'cam', 'web',
  'dvd', 'leg', 'multi', 'complete', 'completa', 'completo', 'dual', 'extended', 'limited',
  'internal', 'imax', 'stan', 'opus', 'mp3', 'dd', 'sdr', 'avc',
]);

/**
 * Compostos que carregam separador proprio ("DDP5.1", "H.264", "WEB-DL") e por
 * isso nao sobreviveriam a tokenizacao inteiros. Saem antes, direto do texto
 * cru, e cada corte ja e sinal de release.
 */
const COMPOUND_RELEASE: readonly RegExp[] = [
  /\bweb[\s._-]?dl\b/gi,
  /\bblu[\s._-]?ray\b/gi,
  /\bdts[\s._-]?hd(?:[\s._-]?ma)?\b/gi,
  /\bh[\s._-]?26[45]\b/gi,
  /\b(?:dd|ddp|aac|ac3|eac3|dts|truehd|flac|opus|mp3)\+?[\s._-]?\d[.,]\d\b/gi,
  /(?<=^|[\s._\-[(])[2457][.,][01](?=$|[\s._\-)\]])/g,
  /\bopen[\s._-]?matte\b/gi,
  /\bmulti[\s._-]audio\b/gi,
  /\bdual[\s._-]audio\b/gi,
  /\bhdr10\+/gi,
  /\bdd\+/gi,
];

/** Palavras que anunciam temporada. So viram corte quando vem com numero. */
const SEASON_WORDS = new Set(['temporada', 'temporadas', 'season', 'seasons', 'temp']);

/** "Serie Completa", "Complete Series": corte sem numero, a temporada vem de baixo. */
const COMPLETE_WORDS = new Set(['completa', 'completo', 'completas', 'completos', 'complete']);
const SERIES_WORDS = new Set(['serie', 'series', 'colecao', 'collection']);

const PAREN_YEAR =
  /^\(((?:19|20)\d{2})(?:\s*[-–/]\s*(?:(?:19|20)\d{2}|presente|present))?\)$/i;
const BARE_YEAR = /^((?:19|20)\d{2})$/;

/** Sobra de separador depois que um composto sai do meio do nome. */
const ONLY_PUNCTUATION = /^[-._[\]()]+$/;

/**
 * Ponto colado ("THE.WIRE", "Dr.House.S01") e separador de release; ponto
 * seguido de espaco ("Dr. House") e pontuacao de verdade e fica.
 *
 * A excecao e sigla: ponto entre duas letras isoladas ("S.W.A.T.") tambem fica,
 * senao o nome vira quatro tokens de uma letra e o titulo se perde.
 */
function isSeparatorDot(input: string, offset: number): boolean {
  const next = input[offset + 1];
  if (next === undefined || /\s/.test(next)) return false;

  const prev = input[offset - 1];
  if (prev === undefined) return false;

  const isolated = (char: string, neighbour: string | undefined): boolean =>
    /[a-zà-ÿ]/i.test(char) && (neighbour === undefined || !/[a-zà-ÿ0-9]/i.test(neighbour));

  const acronym =
    isolated(prev, input[offset - 2]) && isolated(next, input[offset + 2]);
  return !acronym;
}

/** `_` sempre vira espaco; `.` so quando esta no papel de separador. */
function normalizeSeparators(raw: string): string {
  return raw
    .replace(/_/g, ' ')
    .replace(/\./g, (dot, offset: number, input: string) =>
      isSeparatorDot(input, offset) ? ' ' : dot,
    )
    .replace(/\s+/g, ' ')
    .trim();
}

/** Token comparavel: sem acento, minusculo e sem a pontuacao das pontas. */
function normalizeToken(token: string): string {
  return deaccent(token)
    .toLowerCase()
    .replace(/^[-._[(]+/, '')
    .replace(/[-._)\]]+$/, '')
    .replace(/[,;:!?]+$/, '');
}

/** Token de release que nao depende de composicao. */
function isSimpleRelease(token: string): boolean {
  if (token === '') return false;
  if (RELEASE_TOKENS.has(token)) return true;
  if (/^\d{3,4}[pi]$/.test(token)) return true;
  if (/^[xh]26[45]$/.test(token)) return true;
  if (/^(?:dd|ddp|aac|ac3|eac3|dts|truehd|flac)\+?\d{0,2}$/.test(token)) return true;
  if (/^\d{1,2}bits?$/.test(token)) return true;
  return false;
}

/**
 * `x264-DUAL` e release porque as duas metades sao; `He-Man` e `Law-Abiding`
 * nao sao, e e exatamente esse o teste que impede o parser de comer meio titulo.
 */
function isReleaseToken(token: string): boolean {
  if (isSimpleRelease(token)) return true;
  if (!token.includes('-')) return false;
  const parts = token.split('-').filter((part) => part !== '');
  return parts.length > 1 && parts.every(isSimpleRelease);
}

interface Stripped {
  text: string;
  removed: boolean;
}

function stripCompounds(raw: string): Stripped {
  let text = raw;
  let removed = false;
  for (const pattern of COMPOUND_RELEASE) {
    const next = text.replace(pattern, ' ');
    if (next !== text) removed = true;
    text = next;
  }
  return { text, removed };
}

interface Cut {
  /** Indice do primeiro token que NAO faz parte do titulo. */
  index: number;
  season: number | null;
}

function toNumber(digits: string): number {
  return Number.parseInt(digits, 10);
}

/**
 * Primeiro token que anuncia temporada. O titulo e tudo que vem antes dele, e a
 * busca comeca em 1 porque uma pasta que COMECA com a temporada nao tem titulo
 * nenhum para oferecer.
 *
 * Faixa (`S01-S03`, `Seasons 1-3`) e colecao completa devolvem season null: a
 * temporada de verdade vem das subpastas ou do nome do arquivo.
 */
function findCut(norm: readonly string[]): Cut | null {
  for (let index = 1; index < norm.length; index += 1) {
    const token = norm[index] ?? '';
    const next = norm[index + 1];

    const episodic = /^s(\d{1,3})e\d{1,3}/.exec(token);
    if (episodic?.[1] !== undefined) return { index, season: toNumber(episodic[1]) };

    if (/^s\d{1,3}[-–]s?\d{1,3}$/.test(token)) return { index, season: null };

    const single = /^s(\d{1,3})$/.exec(token);
    if (single?.[1] !== undefined) return { index, season: toNumber(single[1]) };

    if (SEASON_WORDS.has(token) && next !== undefined) {
      if (/^\d{1,3}[-–]\d{1,3}$/.test(next)) return { index, season: null };
      const only = /^(\d{1,3})$/.exec(next);
      if (only?.[1] !== undefined) return { index, season: toNumber(only[1]) };
    }

    if (next !== undefined && SEASON_WORDS.has(next)) {
      // Formato dominante no acervo brasileiro: "1a Temporada", "3 Temporada".
      const numberFirst = /^(\d{1,3})(?:[aoª°º]|st|nd|rd|th)?$/.exec(token);
      if (numberFirst?.[1] !== undefined) return { index, season: toNumber(numberFirst[1]) };
      const ordinal = ORDINAL_WORDS[token];
      if (ordinal !== undefined) return { index, season: ordinal };
    }

    if (
      next !== undefined &&
      ((COMPLETE_WORDS.has(token) && SERIES_WORDS.has(next)) ||
        (SERIES_WORDS.has(token) && COMPLETE_WORDS.has(next)))
    ) {
      return { index, season: null };
    }
  }
  return null;
}

/**
 * Tira o `-GRUPO` (ou `[GRUPO]`) do fim. Quem chama so faz isso quando o resto
 * ja tem sinal de release: sem esse cuidado "Law-Abiding" perderia metade.
 */
function stripGroupSuffix(tokens: string[], norm: string[]): boolean {
  const last = tokens[tokens.length - 1];
  if (last === undefined) return false;

  if (/^\[[^\]]+\]$/.test(last)) {
    tokens.pop();
    norm.pop();
    return true;
  }

  // Grupo que ficou solto porque o composto da frente saiu antes da
  // tokenizacao: "WEB-DL-SiGLA" chega aqui como " -SiGLA". A pontuacao na
  // frente denuncia que aquilo era rabo de outro token, nunca titulo.
  if (/^[-._]+\S/.test(last)) {
    tokens.pop();
    norm.pop();
    return true;
  }

  const dash = last.lastIndexOf('-');
  if (dash <= 0) return false;
  // Sufixo que ja e token conhecido nao e grupo: e parte do release ("WEB-DL").
  if (isSimpleRelease(normalizeToken(last.slice(dash + 1)))) return false;

  const head = last.slice(0, dash);
  tokens[tokens.length - 1] = head;
  norm[norm.length - 1] = normalizeToken(head);
  return true;
}

/**
 * Corta o rabo de tokens de release. Varre do FIM para o comeco - em nome de
 * release o lixo fica todo depois do titulo, e cortar no primeiro token de
 * release faria "Mad Max Fury Road" virar "Mad".
 */
function stripTrailingRelease(norm: readonly string[]): number {
  let end = norm.length;
  // Nunca esvazia: uma pasta chamada so "1080p" ainda precisa de nome.
  while (end > 1) {
    const token = norm[end - 1] ?? '';
    if (!isReleaseToken(token)) break;
    if (AMBIGUOUS_TOKENS.has(token) && !isReleaseToken(norm[end - 2] ?? '')) break;
    end -= 1;
  }
  return end;
}

/**
 * Ano do titulo. Entre parenteses vale em qualquer posicao ("Doctor Who (2005)
 * Especiais"); solto so vale como ultimo token, que e a posicao de ano em nome
 * de release ("Mad Max Fury Road 2015 2160p").
 *
 * Le apenas o que sobrou do TITULO. Ano que aparece depois da temporada
 * ("Chaves 1a Temporada 1972") e ano de lancamento daquela temporada, e usar
 * isso na chave separaria S01 de S02 da mesma serie.
 */
function extractYear(tokens: string[]): number | null {
  if (tokens.length < 2) return null;

  for (let index = 0; index < tokens.length; index += 1) {
    const match = PAREN_YEAR.exec(tokens[index] ?? '');
    if (match?.[1] !== undefined) {
      tokens.splice(index, 1);
      return toNumber(match[1]);
    }
  }

  const last = BARE_YEAR.exec(tokens[tokens.length - 1] ?? '');
  if (last?.[1] !== undefined) {
    tokens.pop();
    return toNumber(last[1]);
  }
  return null;
}

function count(value: string, char: string): number {
  let total = 0;
  for (const current of value) if (current === char) total += 1;
  return total;
}

/**
 * Pontuacao orfa nas pontas. Parentese BALANCEADO fica: "Batman (Serie
 * Animada)" e o nome inteiro, e cortar o fecha-parenteses deixaria o titulo
 * quebrado no catalogo.
 */
function trimOrphanPunctuation(value: string): string {
  let result = value.trim();
  for (;;) {
    const before = result;
    result = result.replace(/^[\s\-._]+/, '').replace(/[\s\-._]+$/, '');
    if (result.startsWith('(') && count(result, '(') > count(result, ')')) {
      result = result.slice(1);
    }
    if (result.startsWith('[') && count(result, '[') > count(result, ']')) {
      result = result.slice(1);
    }
    if (result.endsWith(')') && count(result, ')') > count(result, '(')) {
      result = result.slice(0, -1);
    }
    if (result.endsWith(']') && count(result, ']') > count(result, '[')) {
      result = result.slice(0, -1);
    }
    if (result === before) return result;
  }
}

export function parseFolderTitle(name: string): ParsedFolderTitle {
  const raw = name.trim();
  if (raw === '') return { title: name, season: null, year: null, isRelease: false };

  const stripped = stripCompounds(raw);
  const tokens = normalizeSeparators(stripped.text)
    .split(' ')
    // Token so de pontuacao e resto do composto que acabou de sair ("[Dual
    // Audio]" deixa os colchetes para tras). Sem corte nenhum antes, o traco
    // solto e do dono do acervo: "Cavaleiros do Zodiaco - Saga de Asgard".
    .filter((token) => token !== '' && !(stripped.removed && ONLY_PUNCTUATION.test(token)));
  const norm = tokens.map(normalizeToken);

  let isRelease = stripped.removed;
  let season: number | null = null;
  let titleTokens: string[];

  const cut = findCut(norm);
  if (cut !== null) {
    // Com temporada no nome o resto e cabecalho de release inteiro: descartado.
    season = cut.season;
    isRelease = true;
    titleTokens = tokens.slice(0, cut.index);
  } else {
    const hasSignal = stripped.removed || norm.some(isReleaseToken);
    if (hasSignal && stripGroupSuffix(tokens, norm)) isRelease = true;
    const end = stripTrailingRelease(norm);
    if (end < tokens.length) isRelease = true;
    titleTokens = tokens.slice(0, end);
  }

  const year = extractYear(titleTokens);
  const title = trimOrphanPunctuation(titleTokens.join(' '));
  // Titulo vazio nao serve para nada: cai para o nome original normalizado.
  const fallback = normalizeSeparators(raw);

  return {
    title: title !== '' ? title : fallback !== '' ? fallback : raw,
    season,
    year,
    isRelease,
  };
}

/**
 * Chave de agrupamento: slug do titulo mais o ano quando houver.
 *
 * Nome sem nenhuma letra ASCII (japones, cirilico) cai para o proprio titulo
 * normalizado - a chave so precisa ser estavel e unica, nao bonita.
 */
export function groupingKey(parsed: ParsedFolderTitle): string {
  const ascii = deaccent(parsed.title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const base = ascii !== '' ? ascii : parsed.title.normalize('NFC').toLowerCase();
  return parsed.year === null ? base : `${base}@${String(parsed.year)}`;
}

/**
 * Nome de pasta -> termo de busca para provedor de metadata.
 *
 * Pasta de release ganha a limpeza inteira. O resto ganha so o corte do sufixo
 * de ano entre parenteses: fora de release, cada palavra a mais no nome foi o
 * dono do acervo que escreveu de proposito, e tirar "Especiais" de "Doctor Who
 * (2005) Especiais" seria adivinhacao.
 */
export function cleanSearchTerm(raw: string): string {
  const parsed = parseFolderTitle(raw);
  if (parsed.isRelease) return parsed.title;
  return raw
    .replace(/\s*\((?:19|20)\d{2}(?:\s*[-–/]\s*(?:(?:19|20)\d{2}|presente|present))?\)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}
