import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';

import type { AudioTrackRef, SubtitleTrackRef } from '@shared/api-types';

import type { ProbeResult } from './probe-types';

export interface ShowRow {
  id: number;
  slug: string;
  name: string;
  channelNumber: number;
  absolutePath: string;
}

export interface EpisodeRow {
  /** relativePath, id estavel. */
  id: string;
  showId: number;
  absolutePath: string;
  title: string;
  season: number | null;
  episode: number | null;
  orderIndex: number;
  durationMs: number;
  videoCodec: string | null;
  audioCodec: string | null;
  width: number | null;
  height: number | null;
  faststart: boolean;
  /** Audios embutidos; `[]` quando o arquivo nao tem ou o indice nao sabe. */
  audioTracks: AudioTrackRef[];
  /** Legendas embutidas; `[]` quando o arquivo nao tem ou o indice nao sabe. */
  subtitleTracks: SubtitleTrackRef[];
  mtimeMs: number;
  size: number;
  /**
   * Nome do arquivo em `<DATA_DIR>/thumbs`, ex. "42.jpg". null enquanto nao ha
   * quadro. So o NOME, pelo mesmo motivo de `poster_file`: DATA_DIR muda entre
   * o host e o container.
   */
  thumbFile: string | null;
  /**
   * Epoch ms da ultima TENTATIVA de tirar o quadro, tenha dado certo ou nao.
   * null = nunca tentei.
   *
   * Existe porque `thumb_file IS NULL` confunde "ainda nao tentei" com "tentei
   * e o arquivo nao deu quadro" - e a fila reoferecia o mesmo episodio para
   * sempre, um ffmpeg por rodada, em cada um deles. Mesma licao de
   * `backdrop_checked_at`.
   */
  thumbCheckedAt: number | null;
}

/**
 * O que o SCAN escreve de um episodio.
 *
 * Fora daqui ficam as colunas que nao sao do scan: o quadro e escrito pela fila
 * de miniaturas, e o `rowid` e do proprio SQLite. Um tipo so para as duas
 * pontas obrigaria o scan a inventar valor para dado que ele nao tem - e a
 * inventa-lo a cada rescan, apagando o quadro de todo episodio do acervo.
 */
export type EpisodeInput = Omit<EpisodeRow, 'showId' | 'thumbFile' | 'thumbCheckedAt'>;

/**
 * Episodio na fila de quadros, com o minimo para o ffmpeg rodar: quem chama nao
 * materializa as trilhas de 15 mil linhas para tirar uma miniatura.
 */
export interface ThumbCandidate {
  /**
   * `rowid` da linha, que e o nome do arquivo (`<rowId>.jpg`). O `id` do
   * episodio e caminho relativo, com barras e acentos, e nao serve de nome de
   * arquivo; o rowid e a mesma escolha que a capa ja faz com `showId`.
   */
  rowId: number;
  /** `EpisodeRow.id`: caminho relativo a raiz da biblioteca. */
  episodeId: string;
  durationMs: number;
  /** Nome da serie, so para a barra de progresso da tela. */
  showName: string;
}

/**
 * Metadata externa da serie (capa, ano, sinopse), buscada uma vez por show.
 *
 * A linha existir ja significa "ja tentei": `notFound` distingue "o provedor
 * nao conhece esta serie" de "achei". Falha de REDE nao grava linha nenhuma -
 * senao um NAS sem internet no primeiro boot marcaria o acervo inteiro como
 * inexistente e so tentaria de novo depois do TTL.
 */
export interface ShowMetadataRow {
  showId: number;
  /** Nome do arquivo em `<DATA_DIR>/posters`, ex. "12.jpg". null quando sem capa. */
  posterFile: string | null;
  /**
   * Nome do arquivo em `<DATA_DIR>/backdrops`, ex. "12.jpg". null quando o
   * provedor nao tem arte 16:9 - so o TMDB tem - ou quando a linha foi gravada
   * antes desta coluna existir.
   */
  backdropFile: string | null;
  /**
   * Epoch ms da ultima vez em que a arte 16:9 foi PROCURADA, tenha sido achada
   * ou nao. null = nunca procurada, que e o estado de toda linha gravada antes
   * da coluna existir.
   *
   * Existe para separar "ainda nao procurei" de "procurei e nao ha": sem isso,
   * uma serie que o provedor conhece mas nao ilustra (comum em animacao antiga)
   * ficaria com `backdropFile` nulo para sempre e voltaria para a fila a cada
   * rebusca, sem nunca progredir.
   */
  backdropCheckedAt: number | null;
  /**
   * De onde veio a arte 16:9: `'tmdb'` (provedor) ou `'frame'` (quadro tirado
   * do proprio video). null quando nao ha arte, ou quando a linha foi gravada
   * antes desta coluna existir.
   *
   * Sem isto uma arte tirada de quadro seria indistinguivel da do provedor, e a
   * busca de metadata nunca a substituiria quando a chave do TMDB aparecesse.
   */
  backdropSource: string | null;
  year: number | null;
  overview: string | null;
  /** Provedor que respondeu, ex. "tvmaze". null quando nao houve resposta util. */
  source: string | null;
  /** Epoch ms da tentativa; e o que o TTL de re-tentativa mede. */
  fetchedAt: number;
  notFound: boolean;
}

/**
 * Copia MP4 de um episodio que o navegador nao toca direto (MKV, audio Dolby
 * como default). O arquivo vive em `<DATA_DIR>/remux`; aqui vai so o NOME,
 * pelo mesmo motivo de `poster_file`: DATA_DIR muda entre host e container.
 */
export interface RemuxRow {
  /** `EpisodeRow.id` do episodio fonte. */
  episodeId: string;
  /** Nome do arquivo em `<DATA_DIR>/remux`, ex. "ab12...ef.mp4". */
  file: string;
  /** mtime do arquivo FONTE no momento do remux; par de invalidacao com `size`. */
  mtimeMs: number;
  size: number;
  /**
   * Faixas de audio do arquivo REMUXADO, nao do fonte: o remux acrescenta a
   * gemea AAC e reordena, e o painel de trilhas seleciona por POSICAO no
   * arquivo que esta tocando.
   */
  audioTracks: AudioTrackRef[];
  createdAt: number;
}

/**
 * Variante de dublagem: MP4 com o video copiado e SO a faixa `audioIndex` do
 * fonte (mais a gemea AAC quando preciso). Gerada sob demanda quando o usuario
 * troca de audio - o `<video>` nao deixa escolher faixa dentro do arquivo.
 */
export interface AudioVariantRow {
  episodeId: string;
  /** `index` relativo da faixa no arquivo FONTE. */
  audioIndex: number;
  /** Nome do arquivo em `<DATA_DIR>/remux`. */
  file: string;
  /** mtime/size do FONTE no momento da geracao; par de invalidacao. */
  mtimeMs: number;
  size: number;
  createdAt: number;
}

/**
 * Onde o usuario parou em cada episodio. Uma linha por episodio, sempre a mais
 * recente: o app e de senha unica, o "usuario" e a casa inteira.
 */
export interface WatchHistoryRow {
  episodeId: string;
  positionMs: number;
  durationMs: number;
  updatedAt: number;
}

/** Linha do historico enriquecida com o canal, para o cliente montar o retorno. */
export interface WatchHistoryEntry extends WatchHistoryRow {
  channelNumber: number;
}

export interface Store {
  listShows(): ShowRow[];
  getShowByChannel(channelNumber: number): ShowRow | null;
  listEpisodes(showId: number): EpisodeRow[];
  getEpisode(id: string): EpisodeRow | null;

  /**
   * Quantos episodios cada serie tem, numa consulta so.
   *
   * Existe porque `GET /api/channels` precisa do numero, e nao das linhas:
   * contar com `listEpisodes(id).length` por serie materializava os ~14 mil
   * episodios do acervo (com JSON.parse de trilhas em cada um) para jogar tudo
   * fora menos o `length`. Serie sem episodio simplesmente nao aparece no mapa.
   */
  countEpisodesByShow(): Map<number, number>;

  /**
   * Temporadas presentes na serie, crescente e sem repeticao. `[]` quando a
   * serie nao usa pastas de temporada (todo episodio com `season` nulo).
   */
  listSeasons(showId: number): number[];

  /**
   * As temporadas de TODAS as series de uma vez. Existe porque
   * `GET /api/channels` monta o resumo de 460 canais: uma consulta por serie
   * ali seriam 460 idas ao banco por request.
   */
  listSeasonsByShow(): Map<number, number[]>;

  /**
   * Contador que anda a cada mudanca na GRADE (series ou episodios), nunca por
   * metadata ou remux. E o que permite cachear timeline por canal em memoria
   * sem servir grade velha depois de um rescan.
   */
  indexVersion(): number;

  /**
   * Anda com `indexVersion` sem ter mexido na grade.
   *
   * Existe para a fila de quadros: ela escreve numa coluna de `episodes` que o
   * cache de timeline carrega junto (`thumbFile`), e sem um empurrao aqui a
   * faixa "No ar agora" so mostraria as miniaturas novas depois do proximo
   * scan. Chamado UMA vez, no fim da rodada - a cada episodio, jogaria o mapa
   * de 460 canais fora 15 mil vezes seguidas, que e exatamente o custo que o
   * cache existe para evitar.
   */
  bumpIndexVersion(): void;

  /** Metadata externa da serie; null quando nunca foi buscada. */
  getShowMetadata(showId: number): ShowMetadataRow | null;

  /**
   * Series sem NENHUMA arte 16:9 - as candidatas a ganhar uma tirada de quadro.
   * Inclui as que ainda nao tem linha de metadata: sem chave do TMDB, nenhuma
   * serie ganha arte do provedor, e esperar por uma linha que nunca vem
   * deixaria o hero do catalogo listrado para sempre.
   */
  listShowsWithoutBackdrop(): ShowRow[];

  /**
   * Grava a arte 16:9 e a origem dela, SEM tocar em capa, ano ou sinopse.
   *
   * Metodo proprio em vez de `upsertShowMetadata` porque quem tira a arte de um
   * quadro nao fez busca nenhuma: montar a linha inteira aqui obrigaria a
   * inventar um `fetchedAt` de uma consulta que nao houve, e a serie sairia da
   * fila do enriquecimento sem nunca ter sido procurada.
   */
  setShowBackdrop(input: { showId: number; file: string; source: string }): void;

  /**
   * Ha alguma serie sem NENHUMA linha de metadata? E o gatilho barato de
   * `GET /api/channels`, que roda a cada abertura do catalogo: uma consulta que
   * para no primeiro achado, em vez de um `getShowMetadata` por serie.
   */
  hasShowsWithoutMetadata(): boolean;

  /** Grava (ou regrava) o resultado da busca de metadata. */
  upsertShowMetadata(row: ShowMetadataRow): void;

  /** Cria a serie se nova e atribui o proximo numero de canal livre. Idempotente por slug. */
  upsertShow(input: { slug: string; name: string; absolutePath: string }): ShowRow;

  upsertEpisodes(showId: number, rows: readonly EpisodeInput[]): void;

  /** Remove episodios da serie que nao estao em `keepIds`. */
  pruneEpisodes(showId: number, keepIds: readonly string[]): number;

  /** Remove series que sumiram do disco. Numeros de canal removidos nao sao reciclados. */
  pruneShows(keepSlugs: readonly string[]): number;

  /** Probe cacheado, valido apenas se mtime e size baterem. */
  getCachedProbe(id: string, mtimeMs: number, size: number): ProbeResult | null;

  /** Remux valido para o estado ATUAL do fonte; null se nao existe ou envelheceu. */
  getRemux(episodeId: string, mtimeMs: number, size: number): RemuxRow | null;

  /** Grava (ou regrava) o remux do episodio. */
  upsertRemux(row: RemuxRow): void;

  /** Nomes de arquivo referenciados; tudo fora desta lista em `remux/` e lixo. */
  listRemuxFiles(): string[];

  /**
   * Episodios que a fila de quadros deve olhar, na ordem do catalogo.
   *
   * `all: false` e a rodada barata do dia a dia: so quem nunca foi TENTADO
   * (`thumb_checked_at IS NULL`). O predicado e o carimbo, e nao
   * `thumb_file IS NULL`, senao todo arquivo que nao rende quadro voltaria para
   * a fila em cada rodada, para sempre. `all: true` e o `reset` do painel.
   *
   * Devolve a lista inteira de uma vez de proposito: a fila roda um ffmpeg por
   * episodio e nao pode segurar uma consulta (nem uma transacao) aberta no
   * banco enquanto isso.
   */
  listThumbCandidates(options: { all: boolean; retryFailed?: boolean }): ThumbCandidate[];

  /**
   * Resultado de UMA tentativa de quadro. `file` null carimba a tentativa sem
   * arquivo - e o que impede a fila de reoferecer o mesmo episodio amanha.
   */
  setEpisodeThumb(input: { episodeId: string; file: string | null; checkedAt: number }): void;

  /** Nomes de arquivo referenciados; tudo fora desta lista em `thumbs/` e lixo. */
  listThumbFiles(): string[];

  /** Variante valida para o estado atual do fonte; null se nao existe ou envelheceu. */
  getAudioVariant(episodeId: string, audioIndex: number, mtimeMs: number, size: number): AudioVariantRow | null;

  upsertAudioVariant(row: AudioVariantRow): void;

  /** Nomes de arquivo das variantes; entram na mesma coleta de `remux/`. */
  listAudioVariantFiles(): string[];

  /** Posicao salva do episodio; null quando nunca foi assistido (ou terminou). */
  getWatchHistory(episodeId: string): WatchHistoryRow | null;

  upsertWatchHistory(row: WatchHistoryRow): void;

  deleteWatchHistory(episodeId: string): void;

  /** Historico com canal, do mais recente para o mais antigo. */
  listWatchHistory(limit: number): WatchHistoryEntry[];

  /** Preferencia gravada pelo usuario; null quando a chave nunca foi escrita. */
  getSetting(key: string): string | null;

  /** Grava (ou regrava) a preferencia. O valor e sempre texto: quem interpreta e o servico. */
  setSetting(key: string, value: string): void;

  /** Apaga a chave, o que devolve a preferencia ao default do `.env`. */
  deleteSetting(key: string): void;

  /** Todas as preferencias de uma vez; e como o servico monta o objeto efetivo. */
  listSettings(): Record<string, string>;

  close(): void;
}

/** Formato das linhas de `shows` como o SQLite devolve. */
interface ShowRecord {
  id: number;
  slug: string;
  name: string;
  channel_number: number;
  absolute_path: string;
}

/** Formato das linhas de `episodes` como o SQLite devolve. */
interface EpisodeRecord {
  id: string;
  show_id: number;
  absolute_path: string;
  title: string;
  season: number | null;
  episode: number | null;
  order_index: number;
  duration_ms: number;
  video_codec: string | null;
  audio_codec: string | null;
  width: number | null;
  height: number | null;
  faststart: number;
  /** JSON de AudioTrackRef[]; NULL em linha gravada antes da versao 2. */
  audio_tracks: string | null;
  /** JSON de SubtitleTrackRef[]; NULL em linha gravada antes da versao 2. */
  subtitle_tracks: string | null;
  mtime_ms: number;
  size: number;
  /** NULL em linha gravada antes da versao 10, e tambem em "sem quadro". */
  thumb_file: string | null;
  /** NULL em linha gravada antes da versao 10, e tambem em "nunca tentei". */
  thumb_checked_at: number | null;
}

/** Formato das linhas de `show_metadata` como o SQLite devolve. */
interface ShowMetadataRecord {
  show_id: number;
  poster_file: string | null;
  /** NULL em linha gravada antes da versao 8. */
  backdrop_file: string | null;
  /** NULL em linha gravada antes da versao 9, e tambem em "nunca procurei". */
  backdrop_checked_at: number | null;
  /** 'tmdb' ou 'frame'; NULL sem arte, ou em linha anterior a versao 10. */
  backdrop_source: string | null;
  year: number | null;
  overview: string | null;
  source: string | null;
  fetched_at: number;
  not_found: number;
}

const SCHEMA_VERSION = 10;

const MIGRATIONS: readonly string[] = [
  // versao 1
  `
  CREATE TABLE IF NOT EXISTS shows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    channel_number INTEGER NOT NULL UNIQUE,
    absolute_path TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS episodes (
    id TEXT PRIMARY KEY,
    show_id INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
    absolute_path TEXT NOT NULL,
    title TEXT NOT NULL,
    season INTEGER,
    episode INTEGER,
    order_index INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    video_codec TEXT,
    audio_codec TEXT,
    width INTEGER,
    height INTEGER,
    faststart INTEGER NOT NULL,
    mtime_ms REAL NOT NULL,
    size INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_episodes_show ON episodes (show_id, order_index);
  `,
  // versao 2: trilhas de audio e legenda, como JSON.
  //
  // Colunas NULAVEIS de proposito. Um indice ja existente ganha as colunas
  // vazias, e NULL e o sinal de "nunca foi probado para trilhas": e assim que
  // `getCachedProbe` sabe que precisa reabrir o arquivo, mesmo com mtime e
  // tamanho identicos. Depois do primeiro rescan toda linha tem pelo menos
  // '[]' e o cache volta a valer normalmente.
  `
  ALTER TABLE episodes ADD COLUMN audio_tracks TEXT;
  ALTER TABLE episodes ADD COLUMN subtitle_tracks TEXT;
  `,
  // versao 3: metadata externa da serie (capa, ano, sinopse).
  //
  // Tabela separada, e nao colunas em `shows`, porque o ciclo de vida e outro:
  // `shows` e reescrita pelo scan, isto e reescrito pela rede. ON DELETE
  // CASCADE para a capa nao sobreviver a serie que sumiu do disco.
  //
  // `poster_file` guarda so o NOME do arquivo, nao o caminho: DATA_DIR muda
  // entre o host e o container, e um caminho absoluto no banco viraria capa
  // quebrada no primeiro deploy.
  `
  CREATE TABLE IF NOT EXISTS show_metadata (
    show_id INTEGER PRIMARY KEY REFERENCES shows(id) ON DELETE CASCADE,
    poster_file TEXT,
    year INTEGER,
    overview TEXT,
    source TEXT,
    fetched_at INTEGER NOT NULL,
    not_found INTEGER NOT NULL DEFAULT 0
  );
  `,
  // versao 4: copias MP4 remuxadas dos episodios que o navegador nao toca.
  //
  // Tabela separada porque o ciclo de vida e outro: `episodes` e reescrita
  // pelo scan, isto e escrito pelo job de remux. CASCADE para a linha nao
  // sobreviver ao episodio - o arquivo orfao em disco quem recolhe e o proprio
  // job, comparando o diretorio com `listRemuxFiles`.
  //
  // mtime_ms e size sao do arquivo FONTE: e o mesmo par que invalida o cache
  // de probe, e um fonte trocado no NAS nao pode continuar servindo o MP4 do
  // arquivo antigo.
  `
  CREATE TABLE IF NOT EXISTS remux (
    episode_id TEXT PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,
    file TEXT NOT NULL,
    mtime_ms REAL NOT NULL,
    size INTEGER NOT NULL,
    audio_tracks TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  // versao 5: variantes de dublagem, geradas sob demanda quando o usuario
  // troca de audio. Chave composta: um MP4 por (episodio, faixa fonte).
  // Mesmo par (mtime, size) do fonte como invalidacao, mesma coleta de orfaos.
  `
  CREATE TABLE IF NOT EXISTS audio_variant (
    episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    audio_index INTEGER NOT NULL,
    file TEXT NOT NULL,
    mtime_ms REAL NOT NULL,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (episode_id, audio_index)
  );
  `,
  // versao 6: onde o usuario parou. Uma linha por episodio (senha unica = um
  // "usuario"). Episodio que sai do indice leva o progresso junto - retomar um
  // arquivo que nao existe mais nao significa nada.
  `
  CREATE TABLE IF NOT EXISTS watch_history (
    episode_id TEXT PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,
    position_ms INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  // versao 7: preferencias escolhidas pelo usuario no painel.
  //
  // Tabela propria em vez de reusar `meta`: `meta` guarda estado INTERNO do
  // indexador (o contador de canais) e quem escreve nela e o scan. Isto aqui e
  // escrito pela pessoa, de outra maquina, e nao pode ser apagado junto num
  // eventual reset do indice - perder o contador de canais e chato, perder a
  // escolha de audio e legenda da casa inteira e pior.
  //
  // `value` e sempre TEXTO, mesmo para booleano e horario: quem interpreta e o
  // servico de settings, e uma linha ilegivel cai no default do `.env` sem
  // impedir o servidor de subir. `updated_at` existe so para inspecao humana
  // ("quando foi que isso mudou?"), nada no codigo decide por ele.
  `
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  // versao 8: arte 16:9 da serie, o fundo do hero do catalogo.
  //
  // Coluna em `show_metadata` e nao tabela nova: e o mesmo ciclo de vida da
  // capa - a mesma resposta do mesmo provedor grava as duas, e a mesma remocao
  // de serie leva as duas embora.
  //
  // Nulavel por dois motivos distintos, e o codigo nao os distingue: so o TMDB
  // tem arte 16:9 (TVMaze e iTunes nunca vao preencher), e toda linha gravada
  // antes desta versao fica com a coluna vazia. Por isso a busca automatica
  // ignora `backdrop_file` nulo: reconsultar por causa dele transformaria cada
  // boot num flood no provedor.
  `
  ALTER TABLE show_metadata ADD COLUMN backdrop_file TEXT;
  `,
  // versao 9: quando a arte 16:9 foi PROCURADA.
  //
  // `backdrop_file` nulo tem dois significados que precisam ser distinguidos:
  // "ainda nao procurei" (toda linha anterior a versao 8) e "procurei e o
  // provedor nao tem". Sem a diferenca, a rebusca do painel reofereceria para
  // sempre as series que o TMDB conhece mas nao ilustra - e, pior, cada rodada
  // regravaria a linha delas.
  //
  // Coluna propria em vez de um sentinela em `backdrop_file` (string vazia, por
  // exemplo) porque o valor tambem vira caminho de arquivo: um nome vazio
  // atravessaria `basename` e viraria leitura de diretorio na rota da arte.
  `
  ALTER TABLE show_metadata ADD COLUMN backdrop_checked_at INTEGER;
  `,
  // versao 10: quadro do episodio e a origem da arte 16:9.
  //
  // Nenhum provedor de metadata tem imagem por episodio de acervo caseiro, e a
  // lista de episodios do desenho e feita de miniaturas: elas saem do proprio
  // video, por ffmpeg, em segundo plano. As duas colunas de `episodes` vivem no
  // MESMO lugar que o resto do episodio (e nao numa tabela a parte, como o
  // remux) porque nao ha ciclo de vida separado: o quadro nasce e morre com a
  // linha, e o CASCADE que ja existe nao teria nada a acrescentar.
  //
  // `thumb_checked_at` e a metade que evita a fila reoferecer o mesmo arquivo
  // para sempre; `thumb_file` sozinho confundiria "nao tentei" com "tentei e
  // nao deu". Mesma licao de `backdrop_checked_at`.
  //
  // `backdrop_source` separa a arte do provedor da arte tirada de um quadro: a
  // primeira SUBSTITUI a segunda quando a chave do TMDB aparece, e o contrario
  // nunca acontece. Sem a coluna, as duas seriam indistinguiveis e a arte
  // improvisada ficaria no lugar da boa para sempre.
  `
  ALTER TABLE episodes ADD COLUMN thumb_file TEXT;
  ALTER TABLE episodes ADD COLUMN thumb_checked_at INTEGER;
  ALTER TABLE show_metadata ADD COLUMN backdrop_source TEXT;
  `,
];

/** Chave do contador monotonico de canais. Nunca decrementa. */
const NEXT_CHANNEL_KEY = 'next_channel_number';

function toShowRow(record: ShowRecord): ShowRow {
  return {
    id: record.id,
    slug: record.slug,
    name: record.name,
    channelNumber: record.channel_number,
    absolutePath: record.absolute_path,
  };
}

/**
 * JSON de trilhas -> array. Nunca lanca: coluna NULL (indice antigo) ou texto
 * corrompido viram `[]`, porque uma linha ilegivel nao pode derrubar a listagem
 * do canal inteiro.
 */
function parseTracks<T>(raw: string | null): T[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function toEpisodeRow(record: EpisodeRecord): EpisodeRow {
  return {
    id: record.id,
    showId: record.show_id,
    absolutePath: record.absolute_path,
    title: record.title,
    season: record.season,
    episode: record.episode,
    orderIndex: record.order_index,
    durationMs: record.duration_ms,
    videoCodec: record.video_codec,
    audioCodec: record.audio_codec,
    width: record.width,
    height: record.height,
    faststart: record.faststart !== 0,
    audioTracks: parseTracks<AudioTrackRef>(record.audio_tracks),
    subtitleTracks: parseTracks<SubtitleTrackRef>(record.subtitle_tracks),
    mtimeMs: record.mtime_ms,
    size: record.size,
    thumbFile: record.thumb_file,
    thumbCheckedAt: record.thumb_checked_at,
  };
}

function migrate(db: Database.Database): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');

  const current = db.prepare('SELECT version FROM schema_version').get() as
    | { version: number }
    | undefined;
  const from = current?.version ?? 0;

  if (from >= SCHEMA_VERSION) {
    return;
  }

  db.transaction(() => {
    for (let version = from; version < SCHEMA_VERSION; version += 1) {
      const sql = MIGRATIONS[version];
      if (sql === undefined) {
        throw new Error(`migracao ausente para a versao ${version + 1}`);
      }
      db.exec(sql);
    }

    if (current === undefined) {
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
    } else {
      db.prepare('UPDATE schema_version SET version = ?').run(SCHEMA_VERSION);
    }
  })();
}

/** true para caminhos que o SQLite trata como banco sem arquivo. */
function isInMemoryPath(dbPath: string): boolean {
  return dbPath === ':memory:' || dbPath === '' || dbPath.startsWith('file::memory:');
}

export function openStore(dbPath: string): Store {
  if (!isInMemoryPath(dbPath)) {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  migrate(db);

  // Tabela temporaria usada como conjunto de ids a preservar nos prunes.
  // Evita montar uma lista gigante de placeholders quando a biblioteca cresce.
  db.exec('CREATE TEMP TABLE IF NOT EXISTS keep_ids (id TEXT PRIMARY KEY)');
  const clearKeepIds = db.prepare('DELETE FROM keep_ids');
  const insertKeepId = db.prepare('INSERT OR IGNORE INTO keep_ids (id) VALUES (?)');

  /**
   * Versao da grade.
   *
   * O contador local cobre as escritas deste processo. `PRAGMA data_version`
   * cobre a outra metade: ele muda quando OUTRA conexao comita, e o `scan.js`
   * avulso (o unico jeito de reindexar dentro do container) e exatamente isso -
   * sem ele, o servidor continuaria servindo a grade antiga ate reiniciar.
   */
  // Preparado uma vez: `indexVersion()` e consultado uma vez por canal em
  // `GET /api/now`, e recompilar o PRAGMA a cada chamada custaria cinco vezes
  // mais que executa-lo.
  const selectDataVersion = db.prepare('PRAGMA data_version');

  function readDataVersion(): number {
    return (selectDataVersion.get() as { data_version: number }).data_version;
  }

  let indexVersionCounter = 0;
  let lastDataVersion = readDataVersion();

  function bumpIndexVersion(): void {
    indexVersionCounter += 1;
  }

  const selectShows = db.prepare(
    'SELECT id, slug, name, channel_number, absolute_path FROM shows ORDER BY channel_number',
  );
  const selectShowBySlug = db.prepare(
    'SELECT id, slug, name, channel_number, absolute_path FROM shows WHERE slug = ?',
  );
  const selectShowByChannel = db.prepare(
    'SELECT id, slug, name, channel_number, absolute_path FROM shows WHERE channel_number = ?',
  );
  const insertShow = db.prepare(
    `INSERT INTO shows (slug, name, channel_number, absolute_path)
     VALUES (@slug, @name, @channelNumber, @absolutePath)`,
  );
  const updateShow = db.prepare('UPDATE shows SET name = @name, absolute_path = @absolutePath WHERE id = @id');
  const selectMeta = db.prepare('SELECT value FROM meta WHERE key = ?');
  const upsertMeta = db.prepare(
    'INSERT INTO meta (key, value) VALUES (@key, @value) ON CONFLICT(key) DO UPDATE SET value = @value',
  );

  /** Consome o proximo numero de canal e avanca o contador. */
  function takeNextChannelNumber(): number {
    const row = selectMeta.get(NEXT_CHANNEL_KEY) as { value: string } | undefined;
    const next = row === undefined ? 1 : Number(row.value);
    upsertMeta.run({ key: NEXT_CHANNEL_KEY, value: String(next + 1) });
    return next;
  }

  const upsertShowTx = db.transaction(
    (input: { slug: string; name: string; absolutePath: string }): ShowRow => {
      const existing = selectShowBySlug.get(input.slug) as ShowRecord | undefined;

      if (existing !== undefined) {
        updateShow.run({ id: existing.id, name: input.name, absolutePath: input.absolutePath });
        return {
          id: existing.id,
          slug: existing.slug,
          name: input.name,
          channelNumber: existing.channel_number,
          absolutePath: input.absolutePath,
        };
      }

      const channelNumber = takeNextChannelNumber();
      const result = insertShow.run({
        slug: input.slug,
        name: input.name,
        channelNumber,
        absolutePath: input.absolutePath,
      });

      return {
        id: Number(result.lastInsertRowid),
        slug: input.slug,
        name: input.name,
        channelNumber,
        absolutePath: input.absolutePath,
      };
    },
  );

  const selectEpisodesByShow = db.prepare(
    'SELECT * FROM episodes WHERE show_id = ? ORDER BY order_index, id',
  );
  const selectEpisodeCounts = db.prepare(
    'SELECT show_id, COUNT(*) AS total FROM episodes GROUP BY show_id',
  );
  const selectSeasonsByShowId = db.prepare(
    `SELECT DISTINCT season FROM episodes
     WHERE show_id = ? AND season IS NOT NULL
     ORDER BY season`,
  );
  const selectSeasonsGrouped = db.prepare(
    `SELECT show_id, season FROM episodes
     WHERE season IS NOT NULL
     GROUP BY show_id, season
     ORDER BY show_id, season`,
  );
  const selectEpisodeById = db.prepare('SELECT * FROM episodes WHERE id = ?');
  const selectCachedProbe = db.prepare(
    // As duas ultimas condicoes sao a invalidacao das linhas antigas: elas tem
    // mtime e size certos, mas nunca souberam de trilha nenhuma.
    `SELECT duration_ms, video_codec, audio_codec, width, height, faststart,
            audio_tracks, subtitle_tracks
     FROM episodes
     WHERE id = @id AND mtime_ms = @mtimeMs AND size = @size
       AND audio_tracks IS NOT NULL AND subtitle_tracks IS NOT NULL`,
  );
  const insertEpisode = db.prepare(
    `INSERT INTO episodes (
       id, show_id, absolute_path, title, season, episode, order_index,
       duration_ms, video_codec, audio_codec, width, height, faststart,
       audio_tracks, subtitle_tracks, mtime_ms, size
     ) VALUES (
       @id, @showId, @absolutePath, @title, @season, @episode, @orderIndex,
       @durationMs, @videoCodec, @audioCodec, @width, @height, @faststart,
       @audioTracks, @subtitleTracks, @mtimeMs, @size
     )
     ON CONFLICT(id) DO UPDATE SET
       show_id = excluded.show_id,
       absolute_path = excluded.absolute_path,
       title = excluded.title,
       season = excluded.season,
       episode = excluded.episode,
       order_index = excluded.order_index,
       duration_ms = excluded.duration_ms,
       video_codec = excluded.video_codec,
       audio_codec = excluded.audio_codec,
       width = excluded.width,
       height = excluded.height,
       faststart = excluded.faststart,
       audio_tracks = excluded.audio_tracks,
       subtitle_tracks = excluded.subtitle_tracks,
       -- O quadro sobrevive a um rescan que reencontrou o MESMO arquivo, e so
       -- a ele. Arquivo trocado no NAS (outro mtime ou outro tamanho) pode ser
       -- outro episodio inteiro, e servir a miniatura antiga seria mostrar uma
       -- cena que nao esta mais ali. Zerar o carimbo junto e o que devolve o
       -- episodio para a fila.
       --
       -- A alternativa - apagar sempre - custaria 15 mil invocacoes de ffmpeg
       -- em toda madrugada, para reproduzir exatamente as mesmas imagens.
       thumb_file = CASE
         WHEN episodes.mtime_ms = excluded.mtime_ms AND episodes.size = excluded.size
         THEN episodes.thumb_file ELSE NULL END,
       thumb_checked_at = CASE
         WHEN episodes.mtime_ms = excluded.mtime_ms AND episodes.size = excluded.size
         THEN episodes.thumb_checked_at ELSE NULL END,
       mtime_ms = excluded.mtime_ms,
       size = excluded.size`,
  );

  const upsertEpisodesTx = db.transaction(
    (showId: number, rows: readonly EpisodeInput[]): void => {
      for (const row of rows) {
        insertEpisode.run({
          id: row.id,
          showId,
          absolutePath: row.absolutePath,
          title: row.title,
          season: row.season,
          episode: row.episode,
          orderIndex: row.orderIndex,
          durationMs: row.durationMs,
          videoCodec: row.videoCodec,
          audioCodec: row.audioCodec,
          width: row.width,
          height: row.height,
          faststart: row.faststart ? 1 : 0,
          // Sempre grava texto, nunca NULL: NULL significa "linha de antes das
          // trilhas" e invalidaria o cache de probe para sempre.
          audioTracks: JSON.stringify(row.audioTracks ?? []),
          subtitleTracks: JSON.stringify(row.subtitleTracks ?? []),
          mtimeMs: row.mtimeMs,
          size: row.size,
        });
      }
    },
  );

  const deleteEpisodesNotKept = db.prepare(
    'DELETE FROM episodes WHERE show_id = ? AND id NOT IN (SELECT id FROM keep_ids)',
  );

  const pruneEpisodesTx = db.transaction((showId: number, keepIds: readonly string[]): number => {
    clearKeepIds.run();
    for (const id of keepIds) {
      insertKeepId.run(id);
    }
    const result = deleteEpisodesNotKept.run(showId);
    clearKeepIds.run();
    return result.changes;
  });

  // As duas consultas da fila de quadros. A ordem e a do catalogo (canal, e
  // depois a grade dentro dele): o acervo e visitado na mesma ordem em que a
  // tela o mostra, entao a primeira serie que a pessoa abre e a primeira a
  // ganhar miniatura.
  const selectThumbPending = db.prepare(
    `SELECT e.rowid AS row_id, e.id, e.duration_ms, s.name AS show_name
     FROM episodes e JOIN shows s ON s.id = e.show_id
     WHERE e.thumb_checked_at IS NULL
     ORDER BY s.channel_number, e.order_index, e.id`,
  );
  const selectThumbAll = db.prepare(
    `SELECT e.rowid AS row_id, e.id, e.duration_ms, s.name AS show_name
     FROM episodes e JOIN shows s ON s.id = e.show_id
     ORDER BY s.channel_number, e.order_index, e.id`,
  );
  // Rodada de boot: alem dos nunca-tentados, reoferece os carimbados SEM
  // arquivo - tentativas que falharam por ambiente (ffmpeg fora do PATH,
  // volume sem permissao) em rodadas de versoes antigas. Uma vez por boot, e
  // so os falhos: recupera o acervo envenenado sem o custo do "refazer tudo".
  const selectThumbRetry = db.prepare(
    `SELECT e.rowid AS row_id, e.id, e.duration_ms, s.name AS show_name
     FROM episodes e JOIN shows s ON s.id = e.show_id
     WHERE e.thumb_checked_at IS NULL OR e.thumb_file IS NULL
     ORDER BY s.channel_number, e.order_index, e.id`,
  );
  const updateEpisodeThumb = db.prepare(
    'UPDATE episodes SET thumb_file = @file, thumb_checked_at = @checkedAt WHERE id = @episodeId',
  );
  const selectThumbFiles = db.prepare(
    'SELECT thumb_file FROM episodes WHERE thumb_file IS NOT NULL',
  );

  const selectRemux = db.prepare(
    'SELECT * FROM remux WHERE episode_id = @episodeId AND mtime_ms = @mtimeMs AND size = @size',
  );
  const insertRemux = db.prepare(
    `INSERT INTO remux (episode_id, file, mtime_ms, size, audio_tracks, created_at)
     VALUES (@episodeId, @file, @mtimeMs, @size, @audioTracks, @createdAt)
     ON CONFLICT(episode_id) DO UPDATE SET
       file = excluded.file,
       mtime_ms = excluded.mtime_ms,
       size = excluded.size,
       audio_tracks = excluded.audio_tracks,
       created_at = excluded.created_at`,
  );
  const selectRemuxFiles = db.prepare('SELECT file FROM remux');

  const selectAudioVariant = db.prepare(
    `SELECT * FROM audio_variant
     WHERE episode_id = @episodeId AND audio_index = @audioIndex
       AND mtime_ms = @mtimeMs AND size = @size`,
  );
  const insertAudioVariant = db.prepare(
    `INSERT INTO audio_variant (episode_id, audio_index, file, mtime_ms, size, created_at)
     VALUES (@episodeId, @audioIndex, @file, @mtimeMs, @size, @createdAt)
     ON CONFLICT(episode_id, audio_index) DO UPDATE SET
       file = excluded.file,
       mtime_ms = excluded.mtime_ms,
       size = excluded.size,
       created_at = excluded.created_at`,
  );
  const selectAudioVariantFiles = db.prepare('SELECT file FROM audio_variant');

  const selectWatchHistory = db.prepare('SELECT * FROM watch_history WHERE episode_id = ?');
  const insertWatchHistory = db.prepare(
    `INSERT INTO watch_history (episode_id, position_ms, duration_ms, updated_at)
     VALUES (@episodeId, @positionMs, @durationMs, @updatedAt)
     ON CONFLICT(episode_id) DO UPDATE SET
       position_ms = excluded.position_ms,
       duration_ms = excluded.duration_ms,
       updated_at = excluded.updated_at`,
  );
  const deleteWatchHistoryStmt = db.prepare('DELETE FROM watch_history WHERE episode_id = ?');
  const selectWatchHistoryList = db.prepare(
    `SELECT h.episode_id, h.position_ms, h.duration_ms, h.updated_at, s.channel_number
     FROM watch_history h
     JOIN episodes e ON e.id = h.episode_id
     JOIN shows s ON s.id = e.show_id
     ORDER BY h.updated_at DESC
     LIMIT ?`,
  );

  const selectSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
  const insertSetting = db.prepare(
    `INSERT INTO settings (key, value, updated_at)
     VALUES (@key, @value, @updatedAt)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`,
  );
  const deleteSettingStmt = db.prepare('DELETE FROM settings WHERE key = ?');
  const selectSettings = db.prepare('SELECT key, value FROM settings');

  const selectShowMetadata = db.prepare('SELECT * FROM show_metadata WHERE show_id = ?');
  // `LIMIT 1` dentro do EXISTS: a resposta e "ha ou nao ha", entao a consulta
  // para na primeira serie sem linha em vez de varrer o acervo inteiro.
  //
  // `fetched_at = 0` conta como sem linha: e o sentinela de "nenhuma busca de
  // verdade aconteceu aqui", usado tanto pelo reset do painel quanto pela linha
  // que a arte de quadro cria para ter onde gravar o nome do arquivo. Sem esta
  // metade, uma serie que ganhou arte antes da capa nunca mais dispararia a
  // busca ao abrir o catalogo.
  const selectMissingMetadata = db.prepare(
    `SELECT EXISTS(
       SELECT 1 FROM shows
       LEFT JOIN show_metadata ON show_metadata.show_id = shows.id
       WHERE show_metadata.show_id IS NULL OR show_metadata.fetched_at = 0
       LIMIT 1
     ) AS falta`,
  );
  const selectShowsWithoutBackdrop = db.prepare(
    `SELECT shows.id, shows.slug, shows.name, shows.channel_number, shows.absolute_path
     FROM shows
     LEFT JOIN show_metadata ON show_metadata.show_id = shows.id
     WHERE show_metadata.backdrop_file IS NULL
     ORDER BY shows.channel_number`,
  );
  const insertShowMetadata = db.prepare(
    `INSERT INTO show_metadata (
       show_id, poster_file, backdrop_file, backdrop_checked_at, backdrop_source,
       year, overview, source, fetched_at, not_found
     )
     VALUES (
       @showId, @posterFile, @backdropFile, @backdropCheckedAt, @backdropSource,
       @year, @overview, @source, @fetchedAt, @notFound
     )
     ON CONFLICT(show_id) DO UPDATE SET
       poster_file = excluded.poster_file,
       backdrop_file = excluded.backdrop_file,
       backdrop_checked_at = excluded.backdrop_checked_at,
       backdrop_source = excluded.backdrop_source,
       year = excluded.year,
       overview = excluded.overview,
       source = excluded.source,
       fetched_at = excluded.fetched_at,
       not_found = excluded.not_found`,
  );
  // Linha nova nasce com `fetched_at = 0` e `not_found = 1`: e "ninguem
  // procurou metadata para esta serie ainda", que e a verdade - quem escreveu
  // aqui foi o ffmpeg, nao o provedor. Os dois sentinelas juntos mantem a serie
  // na fila do enriquecimento (o TTL de not_found vence na hora) em vez de
  // sela-la como resolvida por causa de um fundo de tela.
  const insertBackdropOnly = db.prepare(
    `INSERT INTO show_metadata (
       show_id, poster_file, backdrop_file, backdrop_checked_at, backdrop_source,
       year, overview, source, fetched_at, not_found
     )
     VALUES (@showId, NULL, @file, NULL, @source, NULL, NULL, NULL, 0, 1)
     ON CONFLICT(show_id) DO UPDATE SET
       backdrop_file = excluded.backdrop_file,
       backdrop_source = excluded.backdrop_source
     WHERE show_metadata.backdrop_file IS NULL OR show_metadata.backdrop_source = 'frame'`,
  );
  // O WHERE do UPDATE e a garantia (e nao so o filtro do chamador) de que um
  // quadro de video nunca rebaixa arte de provedor: a lista de shows sem
  // backdrop e lida no comeco de uma rodada LONGA de ffmpeg, e o enricher pode
  // gravar a arte do TMDB no meio dela.

  const deleteShowsNotKept = db.prepare('DELETE FROM shows WHERE slug NOT IN (SELECT id FROM keep_ids)');

  const pruneShowsTx = db.transaction((keepSlugs: readonly string[]): number => {
    clearKeepIds.run();
    for (const slug of keepSlugs) {
      insertKeepId.run(slug);
    }
    const result = deleteShowsNotKept.run();
    clearKeepIds.run();
    return result.changes;
  });

  return {
    listShows(): ShowRow[] {
      return (selectShows.all() as ShowRecord[]).map(toShowRow);
    },

    getShowByChannel(channelNumber): ShowRow | null {
      const record = selectShowByChannel.get(channelNumber) as ShowRecord | undefined;
      return record === undefined ? null : toShowRow(record);
    },

    listEpisodes(showId): EpisodeRow[] {
      return (selectEpisodesByShow.all(showId) as EpisodeRecord[]).map(toEpisodeRow);
    },

    getEpisode(id): EpisodeRow | null {
      const record = selectEpisodeById.get(id) as EpisodeRecord | undefined;
      return record === undefined ? null : toEpisodeRow(record);
    },

    countEpisodesByShow(): Map<number, number> {
      const records = selectEpisodeCounts.all() as { show_id: number; total: number }[];
      return new Map(records.map((record) => [record.show_id, record.total]));
    },

    listSeasons(showId): number[] {
      return (selectSeasonsByShowId.all(showId) as { season: number }[]).map(
        (record) => record.season,
      );
    },

    listSeasonsByShow(): Map<number, number[]> {
      const records = selectSeasonsGrouped.all() as { show_id: number; season: number }[];
      const out = new Map<number, number[]>();
      // A consulta ja vem ordenada por (show_id, season): basta empilhar.
      for (const record of records) {
        const seasons = out.get(record.show_id);
        if (seasons === undefined) {
          out.set(record.show_id, [record.season]);
        } else {
          seasons.push(record.season);
        }
      }
      return out;
    },

    indexVersion(): number {
      const current = readDataVersion();
      if (current !== lastDataVersion) {
        lastDataVersion = current;
        bumpIndexVersion();
      }
      return indexVersionCounter;
    },

    bumpIndexVersion,

    getShowMetadata(showId): ShowMetadataRow | null {
      const record = selectShowMetadata.get(showId) as ShowMetadataRecord | undefined;
      if (record === undefined) return null;
      return {
        showId: record.show_id,
        posterFile: record.poster_file,
        backdropFile: record.backdrop_file,
        backdropCheckedAt: record.backdrop_checked_at,
        backdropSource: record.backdrop_source,
        year: record.year,
        overview: record.overview,
        source: record.source,
        fetchedAt: record.fetched_at,
        notFound: record.not_found !== 0,
      };
    },

    hasShowsWithoutMetadata(): boolean {
      return (selectMissingMetadata.get() as { falta: number }).falta !== 0;
    },

    listShowsWithoutBackdrop(): ShowRow[] {
      return (selectShowsWithoutBackdrop.all() as ShowRecord[]).map(toShowRow);
    },

    setShowBackdrop({ showId, file, source }): void {
      insertBackdropOnly.run({ showId, file, source });
    },

    upsertShowMetadata(row): void {
      insertShowMetadata.run({
        showId: row.showId,
        posterFile: row.posterFile,
        backdropFile: row.backdropFile,
        backdropCheckedAt: row.backdropCheckedAt,
        backdropSource: row.backdropSource,
        year: row.year,
        overview: row.overview,
        source: row.source,
        fetchedAt: row.fetchedAt,
        notFound: row.notFound ? 1 : 0,
      });
    },

    upsertShow(input): ShowRow {
      const row = upsertShowTx(input);
      bumpIndexVersion();
      return row;
    },

    upsertEpisodes(showId, rows): void {
      upsertEpisodesTx(showId, rows);
      bumpIndexVersion();
    },

    pruneEpisodes(showId, keepIds): number {
      const removed = pruneEpisodesTx(showId, keepIds);
      bumpIndexVersion();
      return removed;
    },

    pruneShows(keepSlugs): number {
      const removed = pruneShowsTx(keepSlugs);
      bumpIndexVersion();
      return removed;
    },

    getCachedProbe(id, mtimeMs, size): ProbeResult | null {
      const record = selectCachedProbe.get({ id, mtimeMs, size }) as
        | Pick<
            EpisodeRecord,
            | 'duration_ms'
            | 'video_codec'
            | 'audio_codec'
            | 'width'
            | 'height'
            | 'faststart'
            | 'audio_tracks'
            | 'subtitle_tracks'
          >
        | undefined;

      if (record === undefined) {
        return null;
      }

      return {
        durationMs: record.duration_ms,
        videoCodec: record.video_codec,
        audioCodec: record.audio_codec,
        width: record.width,
        height: record.height,
        faststart: record.faststart !== 0,
        audioTracks: parseTracks<AudioTrackRef>(record.audio_tracks),
        subtitleTracks: parseTracks<SubtitleTrackRef>(record.subtitle_tracks),
      };
    },

    listThumbCandidates({ all, retryFailed }): ThumbCandidate[] {
      const query = all ? selectThumbAll : retryFailed === true ? selectThumbRetry : selectThumbPending;
      const records = query.all() as {
        row_id: number;
        id: string;
        duration_ms: number;
        show_name: string;
      }[];
      return records.map((record) => ({
        rowId: record.row_id,
        episodeId: record.id,
        durationMs: record.duration_ms,
        showName: record.show_name,
      }));
    },

    setEpisodeThumb({ episodeId, file, checkedAt }): void {
      updateEpisodeThumb.run({ episodeId, file, checkedAt });
    },

    listThumbFiles(): string[] {
      return (selectThumbFiles.all() as { thumb_file: string }[]).map(
        (record) => record.thumb_file,
      );
    },

    getRemux(episodeId, mtimeMs, size): RemuxRow | null {
      const record = selectRemux.get({ episodeId, mtimeMs, size }) as
        | {
            episode_id: string;
            file: string;
            mtime_ms: number;
            size: number;
            audio_tracks: string | null;
            created_at: number;
          }
        | undefined;
      if (record === undefined) return null;
      return {
        episodeId: record.episode_id,
        file: record.file,
        mtimeMs: record.mtime_ms,
        size: record.size,
        audioTracks: parseTracks<AudioTrackRef>(record.audio_tracks),
        createdAt: record.created_at,
      };
    },

    upsertRemux(row): void {
      insertRemux.run({
        episodeId: row.episodeId,
        file: row.file,
        mtimeMs: row.mtimeMs,
        size: row.size,
        audioTracks: JSON.stringify(row.audioTracks),
        createdAt: row.createdAt,
      });
    },

    listRemuxFiles(): string[] {
      return (selectRemuxFiles.all() as { file: string }[]).map((record) => record.file);
    },

    getAudioVariant(episodeId, audioIndex, mtimeMs, size): AudioVariantRow | null {
      const record = selectAudioVariant.get({ episodeId, audioIndex, mtimeMs, size }) as
        | {
            episode_id: string;
            audio_index: number;
            file: string;
            mtime_ms: number;
            size: number;
            created_at: number;
          }
        | undefined;
      if (record === undefined) return null;
      return {
        episodeId: record.episode_id,
        audioIndex: record.audio_index,
        file: record.file,
        mtimeMs: record.mtime_ms,
        size: record.size,
        createdAt: record.created_at,
      };
    },

    upsertAudioVariant(row): void {
      insertAudioVariant.run({
        episodeId: row.episodeId,
        audioIndex: row.audioIndex,
        file: row.file,
        mtimeMs: row.mtimeMs,
        size: row.size,
        createdAt: row.createdAt,
      });
    },

    listAudioVariantFiles(): string[] {
      return (selectAudioVariantFiles.all() as { file: string }[]).map((record) => record.file);
    },

    getWatchHistory(episodeId): WatchHistoryRow | null {
      const record = selectWatchHistory.get(episodeId) as
        | { episode_id: string; position_ms: number; duration_ms: number; updated_at: number }
        | undefined;
      if (record === undefined) return null;
      return {
        episodeId: record.episode_id,
        positionMs: record.position_ms,
        durationMs: record.duration_ms,
        updatedAt: record.updated_at,
      };
    },

    upsertWatchHistory(row): void {
      insertWatchHistory.run({
        episodeId: row.episodeId,
        positionMs: row.positionMs,
        durationMs: row.durationMs,
        updatedAt: row.updatedAt,
      });
    },

    deleteWatchHistory(episodeId): void {
      deleteWatchHistoryStmt.run(episodeId);
    },

    listWatchHistory(limit): WatchHistoryEntry[] {
      const records = selectWatchHistoryList.all(limit) as {
        episode_id: string;
        position_ms: number;
        duration_ms: number;
        updated_at: number;
        channel_number: number;
      }[];
      return records.map((record) => ({
        episodeId: record.episode_id,
        positionMs: record.position_ms,
        durationMs: record.duration_ms,
        updatedAt: record.updated_at,
        channelNumber: record.channel_number,
      }));
    },

    getSetting(key): string | null {
      const record = selectSetting.get(key) as { value: string } | undefined;
      return record === undefined ? null : record.value;
    },

    setSetting(key, value): void {
      insertSetting.run({ key, value, updatedAt: Date.now() });
    },

    deleteSetting(key): void {
      deleteSettingStmt.run(key);
    },

    listSettings(): Record<string, string> {
      const records = selectSettings.all() as { key: string; value: string }[];
      const out: Record<string, string> = {};
      for (const record of records) {
        out[record.key] = record.value;
      }
      return out;
    },

    close(): void {
      db.close();
    },
  };
}
