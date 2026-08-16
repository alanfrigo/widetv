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
  /**
   * Rota da arte 16:9 (`/api/channels/:number/backdrop`), ou null quando o
   * provedor nao tem uma. E o fundo do hero do catalogo e do hero da serie;
   * sem ela a tela cai no padrao listrado, que e um desenho, nao uma falha.
   */
  backdropUrl: string | null;
  /** Ano de estreia segundo o provedor de metadata; null quando desconhecido. */
  year: number | null;
  /** Sinopse em texto puro, ja sem HTML; null quando desconhecida. */
  overview: string | null;
  /**
   * Temporadas presentes no canal, em ordem crescente. `[]` quando a serie nao
   * usa pastas de temporada. Existe para a tela da serie desenhar as abas antes
   * de a lista de episodios chegar - sem isto a barra de temporadas pularia.
   */
  seasons: number[];
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
  /**
   * Rota do quadro 16:9 tirado do proprio arquivo
   * (`/api/stream/:id/thumb`), ou null enquanto ele nao existe.
   *
   * Nenhum provedor de metadata tem imagem por episodio de acervo caseiro, e a
   * lista de episodios do desenho e feita de miniaturas: elas saem do video
   * mesmo, por ffmpeg, em segundo plano. null nao e erro - e "ainda nao gerei",
   * e a tela cai no padrao listrado.
   */
  thumbUrl: string | null;
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
  /**
   * Epoch ms em que o episodio passou a contar como visto; null enquanto nao
   * terminou. Chegar ao fim MARCA em vez de apagar a linha - so assim "ja vi
   * este" sobrevive a proxima abertura da serie.
   */
  watchedAt: number | null;
}

/**
 * Corpo do PUT/POST de progresso.
 *
 * Duas formas, nunca as duas juntas:
 *
 * - `{positionMs, durationMs}` - o player gravando onde parou. Posicao perto do
 *   fim marca como visto e zera a posicao, para a proxima abertura comecar do
 *   comeco; qualquer posicao antes disso desmarca (rever e assistir de novo).
 * - `{watched}` - a pessoa marcando na mao. `true` marca como visto sem ter
 *   assistido; `false` APAGA a linha, que e o que "nunca vi isto" significa.
 */
export interface SaveProgressRequest {
  positionMs?: number;
  durationMs?: number;
  watched?: boolean;
}

/**
 * Uma linha de "Continuar assistindo", ja resolvida pelo servidor.
 *
 * `WatchProgress` sozinho so tem o id do episodio: montar a faixa a partir dele
 * obrigaria o cliente a buscar os episodios de cada canal do historico so para
 * descobrir um titulo. Aqui o servidor entrega a linha pronta.
 */
export interface ResumeEntry {
  channelNumber: number;
  channelName: string;
  posterUrl: string | null;
  backdropUrl: string | null;
  episode: EpisodeRef;
  positionMs: number;
  durationMs: number;
  /** Epoch ms da ultima gravacao; a lista vem ordenada por ele, desc. */
  updatedAt: number;
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
   * Tira um quadro de cada episodio, em segundo plano, para a lista de
   * episodios e as faixas do catalogo. Desligar nao apaga o que ja existe.
   */
  autoThumbs: boolean;
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

/** Resultado da ultima rodada de extracao de quadros. */
export interface ThumbSummary {
  /** Episodios que a rodada olhou. */
  considered: number;
  generated: number;
  /** Ja tinham quadro, ou o arquivo sumiu do volume. */
  skipped: number;
  failed: number;
  durationMs: number;
  finishedAt: number;
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
  /**
   * Extracao de quadros. Tem progresso proprio porque, num acervo grande, e a
   * tarefa mais demorada de todas: um ffmpeg por episodio.
   */
  thumbs: {
    state: LibraryTaskState;
    progress: ScanProgressRef | null;
    last: ThumbSummary | null;
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

export interface ThumbRequest {
  /**
   * Refaz o quadro de todo episodio, inclusive os que ja tem. Default: false,
   * que so preenche o que falta - e a rodada barata do dia a dia.
   */
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
  /**
   * `NowPlaying[]` de TODOS os canais, na ordem do catalogo. E o que alimenta a
   * faixa "No ar agora" - com 84 canais, perguntar um a um seriam 84 requests
   * a cada abertura do catalogo. Nunca cacheado.
   */
  nowAll: '/api/now',
  /** Recebe o id JA percent-encoded (o cliente web faz isso em `streamUrl`). */
  stream: (episodeId: string) => `/api/stream/${episodeId}`,
  episodes: (channelNumber: number) => `/api/channels/${channelNumber}/episodes`,
  /** Capa do canal em JPEG. Mesmo valor que `ChannelSummary.posterUrl` carrega. */
  poster: (channelNumber: number) => `/api/channels/${channelNumber}/poster`,
  /** Arte 16:9 do canal em JPEG. Mesmo valor que `ChannelSummary.backdropUrl`. */
  backdrop: (channelNumber: number) => `/api/channels/${channelNumber}/backdrop`,
  /**
   * Legenda embutida ja convertida para WebVTT. `track` e o `index` de
   * `EpisodeRef.subtitleTracks`. Diferente de `stream`, encoda o id aqui
   * dentro: o id vira UM segmento, com as barras como %2F.
   */
  subtitle: (episodeId: string, track: number) =>
    `/api/stream/${encodeURIComponent(episodeId)}/subtitle/${track}`,
  /**
   * Quadro 16:9 do episodio em JPEG. Mesmo valor que `EpisodeRef.thumbUrl`
   * carrega; encoda o id aqui dentro, como a legenda. 404 enquanto o quadro
   * ainda nao foi gerado - a tela cai no padrao listrado, nao em imagem
   * quebrada.
   */
  thumb: (episodeId: string) => `/api/stream/${encodeURIComponent(episodeId)}/thumb`,
  /** Historico completo (GET) e gravacao por episodio (PUT/POST em `historyOf`). */
  history: '/api/history',
  /** `ResumeEntry[]` ja resolvido: e a faixa "Continuar assistindo". */
  resume: '/api/history/resume',
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
  /**
   * POST dispara a extracao de quadros dos episodios que ainda nao tem
   * (`ThumbRequest`); `{ "reset": true }` refaz todos. 202 aceito, 409 se ja
   * roda.
   */
  libraryThumbs: '/api/library/thumbs',
} as const;
