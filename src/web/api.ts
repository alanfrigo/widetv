import {
  API,
  type ChannelSummary,
  type EpisodeRef,
  type NowPlaying,
  type WatchProgress,
} from '@shared/api-types';

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

/**
 * @param audioIndex `index` da faixa FONTE desejada; null/ausente toca a
 *                   default. A troca de dublagem e um arquivo diferente no
 *                   servidor, nunca uma faixa dentro do mesmo.
 */
export function streamUrl(episodeId: string, audioIndex?: number | null): string {
  const base = API.stream(encodeURIComponent(episodeId));
  return audioIndex == null ? base : `${base}?audio=${String(audioIndex)}`;
}

export type VariantProbe = 'ready' | 'preparing' | 'error';

/**
 * Pergunta se a variante de dublagem ja existe, sem baixar nada. 202 significa
 * "o servidor esta gerando": pergunte de novo daqui a alguns segundos.
 */
export async function probeVariant(episodeId: string, audioIndex: number): Promise<VariantProbe> {
  try {
    const response = await fetch(streamUrl(episodeId, audioIndex), {
      method: 'HEAD',
      credentials: 'same-origin',
    });
    if (response.status === 200) return 'ready';
    if (response.status === 202) return 'preparing';
    return 'error';
  } catch {
    return 'error';
  }
}

export async function fetchHistory(): Promise<WatchProgress[]> {
  return getJson<WatchProgress[]>(API.history);
}

/**
 * Grava onde o usuario parou. Fire-and-forget com `keepalive`: e chamado
 * tambem na saida da pagina, quando um fetch comum seria cancelado junto com
 * o documento. Nunca lanca - perder um tick de progresso nao e erro.
 */
export function saveProgress(episodeId: string, positionMs: number, durationMs: number): void {
  void fetch(API.historyOf(episodeId), {
    method: 'PUT',
    credentials: 'same-origin',
    keepalive: true,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ positionMs, durationMs }),
  }).catch(() => undefined);
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

/**
 * Encerra a sessao. Nunca lanca: o cookie que interessa e o do navegador, e o
 * app volta para a tela de senha mesmo que a rota tenha falhado.
 */
export async function logout(): Promise<void> {
  try {
    await fetch(API.logout, { method: 'POST', credentials: 'same-origin' });
  } catch {
    // Rede caida no logout: a tela de senha aparece do mesmo jeito.
  }
}
