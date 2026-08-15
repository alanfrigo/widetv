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

const SCHEMA_VERSION = 3;

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

    close(): void {
      db.close();
    },
  };
}
