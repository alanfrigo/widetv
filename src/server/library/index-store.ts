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

  /** Metadata externa da serie; null quando nunca foi buscada. */
  getShowMetadata(showId: number): ShowMetadataRow | null;

  /** Grava (ou regrava) o resultado da busca de metadata. */
  upsertShowMetadata(row: ShowMetadataRow): void;

  /** Cria a serie se nova e atribui o proximo numero de canal livre. Idempotente por slug. */
  upsertShow(input: { slug: string; name: string; absolutePath: string }): ShowRow;

  upsertEpisodes(showId: number, rows: readonly Omit<EpisodeRow, 'showId'>[]): void;

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
}

/** Formato das linhas de `show_metadata` como o SQLite devolve. */
interface ShowMetadataRecord {
  show_id: number;
  poster_file: string | null;
  year: number | null;
  overview: string | null;
  source: string | null;
  fetched_at: number;
  not_found: number;
}

const SCHEMA_VERSION = 7;

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
       mtime_ms = excluded.mtime_ms,
       size = excluded.size`,
  );

  const upsertEpisodesTx = db.transaction(
    (showId: number, rows: readonly Omit<EpisodeRow, 'showId'>[]): void => {
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
  const insertShowMetadata = db.prepare(
    `INSERT INTO show_metadata (show_id, poster_file, year, overview, source, fetched_at, not_found)
     VALUES (@showId, @posterFile, @year, @overview, @source, @fetchedAt, @notFound)
     ON CONFLICT(show_id) DO UPDATE SET
       poster_file = excluded.poster_file,
       year = excluded.year,
       overview = excluded.overview,
       source = excluded.source,
       fetched_at = excluded.fetched_at,
       not_found = excluded.not_found`,
  );

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

    getShowMetadata(showId): ShowMetadataRow | null {
      const record = selectShowMetadata.get(showId) as ShowMetadataRecord | undefined;
      if (record === undefined) return null;
      return {
        showId: record.show_id,
        posterFile: record.poster_file,
        year: record.year,
        overview: record.overview,
        source: record.source,
        fetchedAt: record.fetched_at,
        notFound: record.not_found !== 0,
      };
    },

    upsertShowMetadata(row): void {
      insertShowMetadata.run({
        showId: row.showId,
        posterFile: row.posterFile,
        year: row.year,
        overview: row.overview,
        source: row.source,
        fetchedAt: row.fetchedAt,
        notFound: row.notFound ? 1 : 0,
      });
    },

    upsertShow(input): ShowRow {
      return upsertShowTx(input);
    },

    upsertEpisodes(showId, rows): void {
      upsertEpisodesTx(showId, rows);
    },

    pruneEpisodes(showId, keepIds): number {
      return pruneEpisodesTx(showId, keepIds);
    },

    pruneShows(keepSlugs): number {
      return pruneShowsTx(keepSlugs);
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
