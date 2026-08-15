/**
 * Contrato HTTP entre o servidor e qualquer cliente (web hoje, Android depois).
 * Nada aqui pode depender de detalhe de implementacao do servidor.
 */

export interface ChannelSummary {
  /** Numero sintonizavel, estavel entre rescans. */
  number: number;
  name: string;
  episodeCount: number;
  /**
   * Rota da capa (`/api/channels/:number/poster`), ou null quando o servidor
   * ainda nao tem capa para este show. E rota propria, nao URL do provedor: a
   * imagem e baixada uma vez e servida daqui, atras do mesmo guard de sessao.
   */
  posterUrl: string | null;
  /** Ano de estreia segundo o provedor de metadata; null quando desconhecido. */
  year: number | null;
  /** Sinopse em texto puro, ja sem HTML; null quando desconhecida. */
  overview: string | null;
}

/** Faixa de audio embutida. `index` e relativo entre audios (0-based). */
export interface AudioTrackRef {
  index: number;
  /** tag language do container (ISO 639-2), ex. "por". null quando nao marcada. */
  lang: string | null;
  /** tag title, ex. "Brazilian". null quando nao marcada. */
  title: string | null;
  /** ex. "eac3". null quando o probe nao descobriu. */
  codec: string | null;
  isDefault: boolean;
}

/** Legenda embutida. `index` relativo entre legendas (0-based), casa com `-map 0:s:N`. */
export interface SubtitleTrackRef {
  index: number;
  lang: string | null;
  title: string | null;
  /** ex. "subrip". null quando o probe nao descobriu. */
  codec: string | null;
  isDefault: boolean;
  forced: boolean;
}

export interface EpisodeRef {
  id: string;
  title: string;
  /** null quando a serie nao usa pastas de temporada. */
  season: number | null;
  /** null quando o numero do episodio nao pode ser extraido do nome. */
  episode: number | null;
  durationMs: number;
  /** null quando o probe nao descobriu. */
  width: number | null;
  /** null quando o probe nao descobriu. Cliente deriva o badge, ex.: >=2160 "4K". */
  height: number | null;
  /** Sempre presente; `[]` quando o indice nao conhece as trilhas. */
  audioTracks: AudioTrackRef[];
  /** Sempre presente; `[]` quando o indice nao conhece as trilhas. */
  subtitleTracks: SubtitleTrackRef[];
}

/**
 * Estado do canal no instante `serverTimeMs`. O cliente usa `serverTimeMs`
 * para calcular o desvio do proprio relogio e projetar `offsetMs` adiante.
 */
export interface NowPlaying {
  channel: ChannelSummary;
  episode: EpisodeRef;
  /** Posicao dentro de `episode`, em ms, valida no instante `serverTimeMs`. */
  offsetMs: number;
  /** Relogio do servidor (epoch ms) no momento do calculo. */
  serverTimeMs: number;
  /** Epoch ms em que `episode` termina e `next` comeca. */
  endsAtMs: number;
  /** Proximo episodio da grade; volta ao inicio quando a serie termina. */
  next: EpisodeRef;
}

export interface LoginRequest {
  password: string;
}

export interface ApiError {
  error: string;
}

export const API = {
  login: '/api/auth/login',
  logout: '/api/auth/logout',
  session: '/api/auth/session',
  channels: '/api/channels',
  now: (channelNumber: number) => `/api/channels/${channelNumber}/now`,
  /** Recebe o id JA percent-encoded (o cliente web faz isso em `streamUrl`). */
  stream: (episodeId: string) => `/api/stream/${episodeId}`,
  episodes: (channelNumber: number) => `/api/channels/${channelNumber}/episodes`,
  /** Capa do canal em JPEG. Mesmo valor que `ChannelSummary.posterUrl` carrega. */
  poster: (channelNumber: number) => `/api/channels/${channelNumber}/poster`,
  /**
   * Legenda embutida ja convertida para WebVTT. `track` e o `index` de
   * `EpisodeRef.subtitleTracks`. Diferente de `stream`, encoda o id aqui
   * dentro: o id vira UM segmento, com as barras como %2F.
   */
  subtitle: (episodeId: string, track: number) =>
    `/api/stream/${encodeURIComponent(episodeId)}/subtitle/${track}`,
} as const;
