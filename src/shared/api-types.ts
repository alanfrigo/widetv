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

/** Onde o usuario parou num episodio. Uma entrada por episodio, a mais recente. */
export interface WatchProgress {
  episodeId: string;
  channelNumber: number;
  positionMs: number;
  durationMs: number;
  /** Epoch ms da ultima gravacao. */
  updatedAt: number;
}

/** Corpo do PUT/POST de progresso. Posicao perto do fim APAGA a entrada. */
export interface SaveProgressRequest {
  positionMs: number;
  durationMs: number;
}

export interface LoginRequest {
  password: string;
}

export interface ApiError {
  error: string;
}

/* --- configuracoes -------------------------------------------------------- */

/**
 * Preferencias do servidor, editaveis pelo painel de configuracoes.
 *
 * Moram no servidor, e nao no `localStorage` do navegador, porque a casa toda
 * usa a mesma senha e as mesmas telas: escolher "audio em portugues" na TV da
 * sala tem que valer no tablet tambem. As que tambem existem no `.env` usam o
 * valor do ambiente como DEFAULT - gravar aqui sobrepoe, apagar volta ao env.
 */
export interface AppSettings {
  /**
   * Idioma de dublagem preferido, ja canonico em ISO 639-2/B ('por', 'eng').
   * null = sem preferencia, vale a faixa default do arquivo.
   */
  audioLang: string | null;
  /** Idioma de legenda preferido, canonico. null = legendas desativadas. */
  subtitleLang: string | null;
  /** Liga a legenda sozinha quando o episodio tem o idioma preferido. */
  subtitlesAuto: boolean;
  /** `HH:MM` LOCAL do rescan diario; null = desligado. */
  rescanTime: string | null;
  /** Converte para MP4, em segundo plano, o que o navegador nao toca direto. */
  autoRemux: boolean;
  /**
   * Junta pastas de release da mesma serie num canal so:
   * `Rick.and.Morty.S01.1080p...` + `Rick.and.Morty.S02.1080p...` viram
   * "Rick and Morty" com duas temporadas. Desligar volta a uma pasta = um canal.
   */
  smartGrouping: boolean;
  /** So leitura: o servidor tem `TMDB_API_KEY`. Muda a qualidade das capas. */
  tmdbConfigured: boolean;
}

/** Corpo do PATCH. Campo ausente fica como esta; `tmdbConfigured` e so leitura. */
export type SettingsPatch = Partial<Omit<AppSettings, 'tmdbConfigured'>>;

/* --- manutencao da biblioteca --------------------------------------------- */

export type LibraryTaskState = 'idle' | 'running';

export interface ScanProgressRef {
  done: number;
  total: number;
  /** Serie sendo medida agora. */
  show: string;
}

/** Resultado da ultima varredura desta instancia. */
export interface ScanSummary {
  shows: number;
  episodes: number;
  probed: number;
  cached: number;
  removedShows: number;
  removedEpisodes: number;
  /** Quantos arquivos falharam; a lista completa fica no log do servidor. */
  failed: number;
  durationMs: number;
  finishedAt: number;
  /** Mensagem quando a rodada morreu no meio; null quando terminou inteira. */
  error: string | null;
}

export interface MetadataSummary {
  considered: number;
  found: number;
  posters: number;
  notFound: number;
  failed: number;
  finishedAt: number;
}

/**
 * Estado das tarefas de fundo. E o que a tela de configuracoes consulta em
 * intervalo curto enquanto um scan roda: o scan pode levar minutos e a tela
 * precisa mostrar que ha algo acontecendo.
 */
export interface LibraryStatus {
  scan: {
    state: LibraryTaskState;
    /** null quando parado ou antes do primeiro progresso. */
    progress: ScanProgressRef | null;
    /** Epoch ms do inicio da rodada atual; null quando parado. */
    startedAt: number | null;
    /** null quando nenhuma rodada terminou desde que o servidor subiu. */
    last: ScanSummary | null;
  };
  metadata: {
    state: LibraryTaskState;
    last: MetadataSummary | null;
  };
  remux: { state: LibraryTaskState };
}

/**
 * `incremental` reaproveita o probe cacheado por (mtime, tamanho) - e o que o
 * rescan noturno faz. `full` reanalisa todo arquivo: e o botao para quando o
 * indice esta torto e o cache seria justamente o problema.
 */
export type ScanMode = 'incremental' | 'full';

export interface ScanRequest {
  mode?: ScanMode;
}

export interface MetadataRefreshRequest {
  /** Apaga a metadata ja gravada antes de buscar. Default: false. */
  reset?: boolean;
}

/** Resposta de quem dispara tarefa de fundo: 202 quando aceitou, 409 se ja rodava. */
export interface TaskAccepted {
  started: boolean;
  /** Motivo quando `started` e false, ex. "scan ja esta em andamento". */
  reason?: string;
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
  /** Historico completo (GET) e gravacao por episodio (PUT/POST em `historyOf`). */
  history: '/api/history',
  historyOf: (episodeId: string) => `/api/history/${encodeURIComponent(episodeId)}`,
  /** Preferencias do servidor: GET devolve `AppSettings`, PATCH recebe `SettingsPatch`. */
  settings: '/api/settings',
  /** Estado das tarefas de fundo (`LibraryStatus`). Nunca cacheado. */
  libraryStatus: '/api/library/status',
  /** POST dispara uma varredura (`ScanRequest`); 202 aceito, 409 se ja roda. */
  libraryScan: '/api/library/scan',
  /**
   * POST reabre a busca de capa/sinopse. Sem corpo tenta so as series sem
   * metadata; `{ "reset": true }` apaga o que ja existe e busca tudo de novo -
   * e o que resolve capa errada depois de renomear pasta.
   */
  libraryMetadata: '/api/library/metadata',
} as const;
