/**
 * Busca de capa e sinopse em provedores publicos.
 *
 * Tres regras moldam este modulo:
 *
 * 1. Sem dependencia nova. O `fetch` global do Node 22 basta, e um cliente HTTP
 *    a mais so aumentaria a imagem para fazer tres GETs.
 * 2. Nenhum provedor e obrigatorio. TVMaze e iTunes nao pedem chave; o TMDB so
 *    entra quando `TMDB_API_KEY` existe. Um servidor sem internet nenhuma
 *    continua servindo canal, so sem capa.
 * 3. Erro de REDE e diferente de "nao achei". O primeiro se tenta de novo
 *    depois; o segundo vira registro no indice para nao bater na mesma porta a
 *    cada `GET /api/channels`. Por isso o resultado da cadeia e um trio
 *    explicito, e nao `T | null`.
 */

import { cleanSearchTerm } from '../library/title-parser.js';

export type ProviderName = 'tmdb' | 'tvmaze' | 'itunes';

export interface ShowMetadata {
  /** URL da imagem no provedor; quem baixa e o servico. null quando sem capa. */
  posterUrl: string | null;
  /**
   * URL da arte 16:9 no provedor. So o TMDB tem uma; TVMaze e iTunes devolvem
   * sempre `null` e a tela cai no padrao listrado, que e um desenho, nao falha.
   */
  backdropUrl: string | null;
  year: number | null;
  /** Sempre texto puro: o `summary` do TVMaze vem com HTML e e limpo aqui. */
  overview: string | null;
  source: ProviderName;
}

export type LookupResult =
  | {
      status: 'found';
      metadata: ShowMetadata;
      /**
       * Algum provedor da cadeia caiu por REDE antes de outro responder.
       *
       * O que veio e util e vale gravar, mas a busca esta INCOMPLETA: o que
       * falta pode estar justamente no provedor que nao respondeu. Quem grava
       * usa isto para nao carimbar "ja procurei" em cima de uma busca que nem
       * chegou a acontecer - um TMDB fora do ar por dez minutos nao pode selar
       * a serie sem arte 16:9 para sempre.
       */
      providerFailed: boolean;
      /**
       * O QUE falhou, quando `providerFailed`. Sem isto, uma chave de TMDB
       * invalida (401 em toda busca) seria invisivel: as capas continuam
       * vindo do TVMaze e nenhum log conta que o provedor forte esta morto.
       */
      failureReason: string | null;
    }
  | { status: 'not-found' }
  /** Rede/servidor falhou: NAO grave nada, tente de novo na proxima rodada. */
  | { status: 'error'; reason: string };

/** Assinatura minima do `fetch`, para os testes trocarem por um duble. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ProviderOptions {
  /** Default: o `fetch` global, resolvido na hora da chamada. */
  fetch?: FetchLike;
  /** Teto por requisicao. Default: 10000. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** Teto do que se guarda de sinopse: o resto e sempre corte de UI. */
const MAX_OVERVIEW_LENGTH = 2_000;

function request(url: string, options: ProviderOptions | undefined): Promise<Response> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Resolvido aqui dentro, e nao em parametro default: `vi.stubGlobal('fetch')`
  // troca `globalThis.fetch` depois do import, e capturar antes perderia o duble.
  const doFetch: FetchLike = options?.fetch ?? ((u, init) => fetch(u, init));
  return doFetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json', 'user-agent': 'widetv' },
  });
}

/**
 * Nome da pasta -> termo de busca.
 *
 * Tira o sufixo de ano entre parenteses ("Batman (1992)", "Cowboy Bebop
 * (1998-1999)"): o acervo usa isso para separar remakes, os provedores nao
 * entendem e devolvem zero resultado.
 *
 * O trabalho pesado mora no parser da biblioteca, que tambem sabe desmontar
 * nome de release. Uma pasta que escape do agrupamento do scanner chega aqui
 * como `Serie.S01.1080p.WEB-DL.x264-GRUPO`, e mandar isso para o TVMaze e o
 * mesmo que nao procurar nada.
 */
export function cleanShowName(raw: string): string {
  return cleanSearchTerm(raw);
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

/**
 * HTML -> texto puro. O `summary` do TVMaze vem embrulhado em `<p>` e com
 * `<b>` no meio, e o contrato promete texto: cliente nenhum (nem o Android)
 * deveria receber marcacao para renderizar.
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&[a-z]+;|&#\d+;/gi, (entity) => ENTITIES[entity.toLowerCase()] ?? entity)
    .replace(/\s+/g, ' ')
    .trim();
}

function toOverview(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = stripHtml(raw).slice(0, MAX_OVERVIEW_LENGTH);
  return text === '' ? null : text;
}

/** "1989-10-14" ou "1989-10-14T07:00:00Z" -> 1989. */
function toYear(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const match = /^(\d{4})/.exec(raw.trim());
  if (match === null) return null;
  const year = Number(match[1]);
  return Number.isFinite(year) ? year : null;
}

function nonEmptyString(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim() !== '' ? raw : null;
}

/**
 * Le o corpo JSON. 404 vira `null` (o provedor respondeu "nao conheco"), e
 * qualquer outro status fora da faixa 2xx vira erro - inclusive 429 e 5xx, que
 * sao temporarios e nao podem ser gravados como "serie inexistente".
 */
async function readJson(response: Response, provider: ProviderName): Promise<unknown | null> {
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`${provider} respondeu ${String(response.status)}`);
  }
  try {
    return (await response.json()) as unknown;
  } catch (error) {
    throw new Error(`${provider} devolveu JSON invalido: ${detail(error)}`);
  }
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * TVMaze, sem chave. `singlesearch` ja devolve o melhor resultado sozinho e
 * responde 404 quando nao conhece o nome.
 */
export async function fetchFromTvmaze(
  name: string,
  options?: ProviderOptions,
): Promise<ShowMetadata | null> {
  const url = `https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(name)}`;
  const body = await readJson(await request(url, options), 'tvmaze');
  if (body === null || typeof body !== 'object') return null;

  const show = body as {
    premiered?: unknown;
    summary?: unknown;
    image?: { original?: unknown; medium?: unknown } | null;
  };

  return {
    posterUrl: nonEmptyString(show.image?.original) ?? nonEmptyString(show.image?.medium),
    backdropUrl: null,
    year: toYear(show.premiered),
    overview: toOverview(show.summary),
    source: 'tvmaze',
  };
}

/**
 * iTunes Search, sem chave. Fallback do TVMaze porque cobre filme e material
 * fora do catalogo de series de TV.
 *
 * `artworkUrl100` e uma miniatura de 100px, mas a URL e um template: trocar o
 * `100x100` por `600x600` devolve a arte grande do mesmo item.
 */
export async function fetchFromItunes(
  name: string,
  options?: ProviderOptions,
): Promise<ShowMetadata | null> {
  for (const media of ['tvShow', 'movie'] as const) {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(name)}&media=${media}&limit=1`;
    const body = await readJson(await request(url, options), 'itunes');
    if (body === null || typeof body !== 'object') continue;

    const first = (body as { results?: unknown[] }).results?.[0];
    if (first === undefined || typeof first !== 'object' || first === null) continue;

    const item = first as {
      artworkUrl100?: unknown;
      releaseDate?: unknown;
      longDescription?: unknown;
      description?: unknown;
    };
    const artwork = nonEmptyString(item.artworkUrl100);

    return {
      posterUrl: artwork === null ? null : artwork.replace('100x100', '600x600'),
      backdropUrl: null,
      year: toYear(item.releaseDate),
      overview: toOverview(item.longDescription) ?? toOverview(item.description),
      source: 'itunes',
    };
  }

  return null;
}

/**
 * TMDB, so com chave. Quando existe vem PRIMEIRO na cadeia: e o unico com
 * sinopse em pt-BR, com poster em resolucao de cartaz e com arte 16:9 - as
 * tres coisas saem da MESMA resposta, sem request extra.
 */
export async function fetchFromTmdb(
  name: string,
  apiKey: string,
  options?: ProviderOptions,
): Promise<ShowMetadata | null> {
  const url =
    'https://api.themoviedb.org/3/search/tv' +
    `?query=${encodeURIComponent(name)}&api_key=${encodeURIComponent(apiKey)}&language=pt-BR`;
  const body = await readJson(await request(url, options), 'tmdb');
  if (body === null || typeof body !== 'object') return null;

  const first = (body as { results?: unknown[] }).results?.[0];
  if (first === undefined || typeof first !== 'object' || first === null) return null;

  const item = first as {
    poster_path?: unknown;
    backdrop_path?: unknown;
    overview?: unknown;
    first_air_date?: unknown;
  };
  const posterPath = nonEmptyString(item.poster_path);
  const backdropPath = nonEmptyString(item.backdrop_path);

  return {
    posterUrl: posterPath === null ? null : `https://image.tmdb.org/t/p/w500${posterPath}`,
    // w1280 e nao original: a arte e fundo de hero, entao a diferenca nao
    // aparece na tela e o download de 460 series pesa bem menos.
    backdropUrl: backdropPath === null ? null : `https://image.tmdb.org/t/p/w1280${backdropPath}`,
    year: toYear(item.first_air_date),
    overview: toOverview(item.overview),
    source: 'tmdb',
  };
}

export interface ChainOptions extends ProviderOptions {
  /** null ou ausente tira o TMDB da cadeia. */
  tmdbApiKey?: string | null;
}

/** Um provedor ja amarrado a sua configuracao. */
export type Provider = (name: string) => Promise<ShowMetadata | null>;

export function buildProviderChain(options?: ChainOptions): Provider[] {
  const chain: Provider[] = [];
  const key = options?.tmdbApiKey;
  if (typeof key === 'string' && key.trim() !== '') {
    chain.push((name) => fetchFromTmdb(name, key.trim(), options));
  }
  chain.push((name) => fetchFromTvmaze(name, options));
  chain.push((name) => fetchFromItunes(name, options));
  return chain;
}

/**
 * Percorre a cadeia e para no primeiro provedor que devolver CAPA.
 *
 * Um provedor que responde sem imagem (acontece: serie obscura com sinopse e
 * sem arte) nao encerra a busca, mas o que ele trouxe fica guardado - se
 * ninguem depois tiver capa, e melhor devolver ano e sinopse do que nada.
 *
 * A ordem entre `error` e `not-found` no fim importa: se QUALQUER provedor
 * falhou por rede, o veredito e `error`, para o show ficar sem linha no indice
 * e ser tentado de novo. Marcar not_found por causa de um DNS fora do ar
 * congelaria o acervo inteiro sem capa ate o TTL vencer.
 */
export async function lookupShowMetadata(
  showName: string,
  options?: ChainOptions,
): Promise<LookupResult> {
  const term = cleanShowName(showName);
  if (term === '') return { status: 'not-found' };

  let fallback: ShowMetadata | null = null;
  let firstError: string | null = null;

  for (const provider of buildProviderChain(options)) {
    try {
      const found = await provider(term);
      if (found === null) continue;
      if (found.posterUrl !== null) {
        return {
          status: 'found',
          metadata: found,
          providerFailed: firstError !== null,
          failureReason: firstError,
        };
      }
      fallback ??= found;
    } catch (error) {
      firstError ??= detail(error);
    }
  }

  if (fallback !== null) {
    return {
      status: 'found',
      metadata: fallback,
      providerFailed: firstError !== null,
      failureReason: firstError,
    };
  }
  if (firstError !== null) return { status: 'error', reason: firstError };
  return { status: 'not-found' };
}

/**
 * A imagem NAO EXISTE mais no provedor (404): permanente, nao vale re-tentar a
 * cada rodada. Diferente de rede fora do ar, que e transitorio.
 */
export class ImageGoneError extends Error {
  constructor(url: string) {
    super(`imagem sumiu do provedor (404): ${url}`);
    this.name = 'ImageGoneError';
  }
}

/**
 * Baixa uma arte (capa ou 16:9). Lanca em qualquer problema. 404 vira
 * `ImageGoneError` (permanente: grave a linha sem a imagem, senao a serie
 * volta para a fila a cada abertura do catalogo, para sempre); o resto e
 * falha de rede - "tente de novo depois", nunca not_found.
 */
export async function downloadImage(
  url: string,
  options?: ProviderOptions,
): Promise<Uint8Array> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch: FetchLike = options?.fetch ?? ((u, init) => fetch(u, init));
  const response = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (response.status === 404) {
    throw new ImageGoneError(url);
  }
  if (!response.ok) {
    throw new Error(`imagem respondeu ${String(response.status)}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new Error('imagem veio vazia');
  }
  return bytes;
}
