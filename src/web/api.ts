import {
  API,
  type ChannelSummary,
  type DisplayMode,
  type EpisodeRef,
  type NowPlaying,
} from '@shared/api-types';

import { parseDisplayMode } from './display-mode';

/**
 * Cliente HTTP. Fino de proposito: a unica coisa que ele acrescenta e medir o
 * round-trip do `/now`, porque sem isso nao da para estimar o desvio de relogio
 * entre cliente e servidor.
 */

export class UnauthorizedError extends Error {
  constructor() {
    super('sessao ausente ou expirada');
    this.name = 'UnauthorizedError';
  }
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin' });
  if (response.status === 401) throw new UnauthorizedError();
  if (!response.ok) throw new Error(`${url} respondeu ${response.status}`);
  return (await response.json()) as T;
}

export async function fetchChannels(): Promise<ChannelSummary[]> {
  return getJson<ChannelSummary[]>(API.channels);
}

/**
 * Modo de apresentacao. Nunca lanca e nunca devolve promessa rejeitada: um
 * servidor antigo responde 404 nesta rota, e o app precisa subir igual ao que
 * era. Toda falha - 404, 401, rede caida, JSON quebrado - vira `'crt'`.
 */
export async function fetchConfig(): Promise<DisplayMode> {
  try {
    const body = (await getJson<unknown>(API.config)) as { displayMode?: unknown } | null;
    return parseDisplayMode(body?.displayMode);
  } catch {
    return 'crt';
  }
}

/**
 * Catalogo do canal, na ordem da grade.
 *
 * @returns null quando o canal nao existe (404). Sessao expirada lanca
 *          `UnauthorizedError`, como em `fetchNow`, para o chamador reabrir a
 *          tela de senha em vez de mostrar catalogo vazio.
 */
export async function fetchEpisodes(channelNumber: number): Promise<EpisodeRef[] | null> {
  const url = API.episodes(channelNumber);
  const response = await fetch(url, { credentials: 'same-origin' });

  if (response.status === 401) throw new UnauthorizedError();
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${url} respondeu ${response.status}`);

  return (await response.json()) as EpisodeRef[];
}

export interface TimedNow {
  data: NowPlaying;
  sentAtMs: number;
  receivedAtMs: number;
}

/**
 * Busca o estado do canal medindo o relogio local dos dois lados do request.
 * Os dois carimbos alimentam `estimateSkewMs`.
 */
export async function fetchNow(channelNumber: number): Promise<TimedNow | null> {
  const sentAtMs = Date.now();
  const response = await fetch(API.now(channelNumber), { credentials: 'same-origin' });
  const receivedAtMs = Date.now();

  if (response.status === 401) throw new UnauthorizedError();
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${API.now(channelNumber)} respondeu ${response.status}`);

  return { data: (await response.json()) as NowPlaying, sentAtMs, receivedAtMs };
}

export function streamUrl(episodeId: string): string {
  return API.stream(encodeURIComponent(episodeId));
}

export async function login(password: string): Promise<boolean> {
  const response = await fetch(API.login, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ password }),
  });
  return response.ok;
}

export async function hasSession(): Promise<boolean> {
  const response = await fetch(API.session, { credentials: 'same-origin' });
  return response.ok;
}
