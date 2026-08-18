import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import type { EpisodeInput, EpisodeRow, Store } from '../../src/server/library/index-store';
import { openStore } from '../../src/server/library/index-store';

/**
 * Versao de schema que o codigo atual escreve. Fica aqui para os testes de
 * migracao afirmarem "chegou na versao mais nova", e nao um numero solto que
 * envelhece a cada coluna adicionada.
 */
const SCHEMA_VERSION_ATUAL = 13;

/**
 * Desfaz, num banco ja aberto na versao atual, tudo o que veio depois da versao
 * `alvo` - e o jeito de reencenar um indice daquela epoca sem manter um dump
 * SQL congelado por versao.
 */
const DESFAZER_13 =
  'DROP TABLE show_override;' +
  'DROP TABLE show_alias;' +
  'ALTER TABLE show_metadata DROP COLUMN manual;';

const DESFAZER_12 =
  'ALTER TABLE remux DROP COLUMN size_bytes;' +
  'ALTER TABLE remux DROP COLUMN last_access_at;' +
  'ALTER TABLE audio_variant DROP COLUMN size_bytes;' +
  'ALTER TABLE audio_variant DROP COLUMN last_access_at;' +
  DESFAZER_13;

const DESFAZER_11 = 'ALTER TABLE watch_history DROP COLUMN watched_at;' + DESFAZER_12;

const DESFAZER_10 =
  'ALTER TABLE episodes DROP COLUMN thumb_file;' +
  'ALTER TABLE episodes DROP COLUMN thumb_checked_at;' +
  'ALTER TABLE show_metadata DROP COLUMN backdrop_source;' +
  DESFAZER_11;

const DESFAZER_ATE: Record<number, string> = {
  6: 'DROP TABLE settings;' +
    'ALTER TABLE show_metadata DROP COLUMN backdrop_file;' +
    'ALTER TABLE show_metadata DROP COLUMN backdrop_checked_at;' +
    DESFAZER_10,
  7: 'ALTER TABLE show_metadata DROP COLUMN backdrop_file;' +
    'ALTER TABLE show_metadata DROP COLUMN backdrop_checked_at;' +
    DESFAZER_10,
  8: 'ALTER TABLE show_metadata DROP COLUMN backdrop_checked_at;' + DESFAZER_10,
  9: DESFAZER_10,
  10: DESFAZER_11,
  11: DESFAZER_12,
  12: DESFAZER_13,
};

function rebobinar(dbPath: string, alvo: number): void {
  const raw = new Database(dbPath);
  raw.exec(`${DESFAZER_ATE[alvo]!} UPDATE schema_version SET version = ${String(alvo)}`);
  raw.close();
}

const AUDIOS = [
  { index: 0, lang: 'por', title: 'Brazilian', codec: 'eac3', isDefault: true },
  { index: 1, lang: 'eng', title: null, codec: 'eac3', isDefault: false },
];

const LEGENDAS = [
  { index: 0, lang: 'por', title: 'Forcada', codec: 'subrip', isDefault: true, forced: true },
  { index: 1, lang: 'eng', title: null, codec: 'subrip', isDefault: false, forced: false },
];

/** Episodio completo com valores plausiveis; o teste sobrescreve o que importa. */
function makeEpisode(overrides: Partial<EpisodeInput> = {}): EpisodeInput {
  return {
    id: 'serie/ep01.mp4',
    absolutePath: '/lib/serie/ep01.mp4',
    title: 'ep01',
    season: 1,
    episode: 1,
    orderIndex: 0,
    durationMs: 1_320_000,
    videoCodec: 'h264',
    audioCodec: 'aac',
    width: 640,
    height: 480,
    faststart: true,
    audioTracks: AUDIOS.map((t) => ({ ...t })),
    subtitleTracks: LEGENDAS.map((t) => ({ ...t })),
    mtimeMs: 1_700_000_000_000,
    size: 123_456,
    ...overrides,
  };
}

/** Cria uma serie de teste e devolve o id dela. */
function makeShow(store: Store, slug = 'serie'): number {
  return store.upsertShow({ slug, name: slug, absolutePath: `/lib/${slug}` }).id;
}

describe('openStore', () => {
  it('abre um banco em memoria vazio', () => {
    const store = openStore(':memory:');
    expect(store.listShows()).toEqual([]);
    store.close();
  });
});

describe('upsertShow', () => {
  it('cria a primeira serie no canal 1 e a devolve em listShows', () => {
    const store = openStore(':memory:');
    const show = store.upsertShow({
      slug: 'bob-esponja',
      name: 'Bob Esponja',
      absolutePath: '/lib/Bob Esponja',
    });

    expect(show.channelNumber).toBe(1);
    expect(show.slug).toBe('bob-esponja');
    expect(show.name).toBe('Bob Esponja');
    expect(show.absolutePath).toBe('/lib/Bob Esponja');
    expect(typeof show.id).toBe('number');
    expect(store.listShows()).toEqual([show]);

    store.close();
  });

  it('e idempotente por slug: nao duplica e mantem id e canal', () => {
    const store = openStore(':memory:');
    const first = store.upsertShow({
      slug: 'bob-esponja',
      name: 'Bob Esponja',
      absolutePath: '/lib/Bob Esponja',
    });
    const second = store.upsertShow({
      slug: 'bob-esponja',
      name: 'Bob Esponja',
      absolutePath: '/lib/Bob Esponja',
    });

    expect(second).toEqual(first);
    expect(store.listShows()).toHaveLength(1);

    store.close();
  });
});

describe('getShowByChannel', () => {
  it('acha a serie pelo numero do canal e devolve null quando nao existe', () => {
    const store = openStore(':memory:');
    const show = store.upsertShow({ slug: 'a', name: 'A', absolutePath: '/lib/A' });

    expect(store.getShowByChannel(show.channelNumber)).toEqual(show);
    expect(store.getShowByChannel(99)).toBeNull();

    store.close();
  });
});

describe('estabilidade do numero de canal', () => {
  it('rescan com series novas nao muda o numero das series existentes', () => {
    const store = openStore(':memory:');

    // primeiro scan
    const zelda = store.upsertShow({ slug: 'zelda', name: 'Zelda', absolutePath: '/lib/Zelda' });
    const naruto = store.upsertShow({ slug: 'naruto', name: 'Naruto', absolutePath: '/lib/Naruto' });
    expect([zelda.channelNumber, naruto.channelNumber]).toEqual([1, 2]);

    // segundo scan: chegaram duas series novas, uma delas ordenada antes de todas
    const again = [
      store.upsertShow({ slug: 'abelha', name: 'Abelha', absolutePath: '/lib/Abelha' }),
      store.upsertShow({ slug: 'naruto', name: 'Naruto', absolutePath: '/lib/Naruto' }),
      store.upsertShow({ slug: 'zelda', name: 'Zelda', absolutePath: '/lib/Zelda' }),
      store.upsertShow({ slug: 'yugi', name: 'Yugi', absolutePath: '/lib/Yugi' }),
    ];

    const bySlug = new Map(again.map((row) => [row.slug, row.channelNumber]));
    expect(bySlug.get('zelda')).toBe(1);
    expect(bySlug.get('naruto')).toBe(2);
    expect(bySlug.get('abelha')).toBe(3);
    expect(bySlug.get('yugi')).toBe(4);

    store.close();
  });

  it('nao recicla o numero de uma serie removida', () => {
    const store = openStore(':memory:');
    store.upsertShow({ slug: 'a', name: 'A', absolutePath: '/lib/A' });
    const b = store.upsertShow({ slug: 'b', name: 'B', absolutePath: '/lib/B' });
    store.upsertShow({ slug: 'c', name: 'C', absolutePath: '/lib/C' });
    expect(b.channelNumber).toBe(2);

    // 'b' sumiu do disco
    expect(store.pruneShows(['a', 'c'])).toBe(1);
    expect(store.listShows().map((row) => row.slug)).toEqual(['a', 'c']);
    expect(store.getShowByChannel(2)).toBeNull();

    // uma serie nova nao herda o canal 2
    const nova = store.upsertShow({ slug: 'd', name: 'D', absolutePath: '/lib/D' });
    expect(nova.channelNumber).toBe(4);

    // e nem a propria 'b' quando reaparece: recebe numero novo
    const bDeVolta = store.upsertShow({ slug: 'b', name: 'B', absolutePath: '/lib/B' });
    expect(bDeVolta.channelNumber).toBe(5);

    store.close();
  });

  it('nao recicla nem o maior numero de canal quando ele e removido', () => {
    const store = openStore(':memory:');
    store.upsertShow({ slug: 'a', name: 'A', absolutePath: '/lib/A' });
    const ultima = store.upsertShow({ slug: 'b', name: 'B', absolutePath: '/lib/B' });
    expect(ultima.channelNumber).toBe(2);

    expect(store.pruneShows(['a'])).toBe(1);

    // o pool nao anda para tras: o proximo canal e 3, nao 2
    expect(store.upsertShow({ slug: 'c', name: 'C', absolutePath: '/lib/C' }).channelNumber).toBe(3);

    store.close();
  });

  it('pruneShows sem nada para remover devolve 0 e nao consome numeros', () => {
    const store = openStore(':memory:');
    store.upsertShow({ slug: 'a', name: 'A', absolutePath: '/lib/A' });

    expect(store.pruneShows(['a'])).toBe(0);
    expect(store.upsertShow({ slug: 'b', name: 'B', absolutePath: '/lib/B' }).channelNumber).toBe(2);

    store.close();
  });
});

describe('upsertEpisodes', () => {
  it('grava episodios e listEpisodes devolve na ordem de orderIndex, com showId', () => {
    const store = openStore(':memory:');
    const showId = makeShow(store);

    store.upsertEpisodes(showId, [
      makeEpisode({ id: 'serie/ep02.mp4', title: 'ep02', episode: 2, orderIndex: 1 }),
      makeEpisode({ id: 'serie/ep01.mp4', title: 'ep01', episode: 1, orderIndex: 0 }),
    ]);

    const episodes = store.listEpisodes(showId);
    expect(episodes.map((row) => row.id)).toEqual(['serie/ep01.mp4', 'serie/ep02.mp4']);
    expect(episodes[0]).toEqual({ ...makeEpisode(), showId, thumbFile: null, thumbCheckedAt: null });

    store.close();
  });
});

describe('getEpisode', () => {
  it('acha o episodio pelo id estavel e devolve null quando nao existe', () => {
    const store = openStore(':memory:');
    const showId = makeShow(store);
    store.upsertEpisodes(showId, [makeEpisode()]);

    expect(store.getEpisode('serie/ep01.mp4')).toEqual({
      ...makeEpisode(),
      showId,
      // Colunas que o scan nao escreve: linha nova nasce sem quadro e sem
      // carimbo de tentativa.
      thumbFile: null,
      thumbCheckedAt: null,
    });
    expect(store.getEpisode('serie/nao-existe.mp4')).toBeNull();

    store.close();
  });
});

describe('roundtrip de tipos', () => {
  it('devolve faststart como boolean nos dois valores', () => {
    const store = openStore(':memory:');
    const showId = makeShow(store);

    store.upsertEpisodes(showId, [
      makeEpisode({ id: 'serie/rapido.mp4', faststart: true }),
      makeEpisode({ id: 'serie/lento.mkv', faststart: false }),
    ]);

    const rapido = store.getEpisode('serie/rapido.mp4');
    const lento = store.getEpisode('serie/lento.mkv');
    expect(rapido?.faststart).toBe(true);
    expect(lento?.faststart).toBe(false);

    store.close();
  });

  it('devolve as trilhas de audio e legenda como objetos, nao como JSON cru', () => {
    const store = openStore(':memory:');
    const showId = makeShow(store);
    store.upsertEpisodes(showId, [makeEpisode()]);

    const row = store.getEpisode('serie/ep01.mp4');
    expect(row?.audioTracks).toEqual(AUDIOS);
    expect(row?.subtitleTracks).toEqual(LEGENDAS);

    store.close();
  });

  it('trilhas vazias voltam como [] e nao como null', () => {
    const store = openStore(':memory:');
    const showId = makeShow(store);
    store.upsertEpisodes(showId, [
      makeEpisode({ id: 'serie/sem-trilha.mp4', audioTracks: [], subtitleTracks: [] }),
    ]);

    const row = store.getEpisode('serie/sem-trilha.mp4');
    expect(row?.audioTracks).toEqual([]);
    expect(row?.subtitleTracks).toEqual([]);

    store.close();
  });

  it('devolve null (e nao undefined ou 0) nos campos opcionais', () => {
    const store = openStore(':memory:');
    const showId = makeShow(store);

    store.upsertEpisodes(showId, [
      makeEpisode({
        id: 'serie/sem-metadado.webm',
        season: null,
        episode: null,
        videoCodec: null,
        audioCodec: null,
        width: null,
        height: null,
      }),
    ]);

    const row = store.getEpisode('serie/sem-metadado.webm');
    expect(row).not.toBeNull();
    expect(row?.season).toBeNull();
    expect(row?.episode).toBeNull();
    expect(row?.videoCodec).toBeNull();
    expect(row?.audioCodec).toBeNull();
    expect(row?.width).toBeNull();
    expect(row?.height).toBeNull();

    store.close();
  });
});

describe('idempotencia de upsertEpisodes', () => {
  it('reexecutar o mesmo scan nao duplica linhas e atualiza os campos mutaveis', () => {
    const store = openStore(':memory:');
    const showId = makeShow(store);
    const rows = [makeEpisode({ id: 'serie/ep01.mp4', orderIndex: 0 })];

    store.upsertEpisodes(showId, rows);
    store.upsertEpisodes(showId, rows);
    expect(store.listEpisodes(showId)).toHaveLength(1);

    // o arquivo foi reencodado: metadados mudam, id continua o mesmo
    store.upsertEpisodes(showId, [
      makeEpisode({
        id: 'serie/ep01.mp4',
        title: 'ep01 remux',
        orderIndex: 3,
        durationMs: 1_400_000,
        videoCodec: 'hevc',
        faststart: false,
        mtimeMs: 1_800_000_000_000,
        size: 999,
      }),
    ]);

    const episodes = store.listEpisodes(showId);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toEqual({
      ...makeEpisode({
        title: 'ep01 remux',
        orderIndex: 3,
        durationMs: 1_400_000,
        videoCodec: 'hevc',
        faststart: false,
        mtimeMs: 1_800_000_000_000,
        size: 999,
      }),
      showId,
      thumbFile: null,
      thumbCheckedAt: null,
    });

    store.close();
  });
});

describe('pruneEpisodes', () => {
  it('remove so os episodios da serie que sairam do disco e devolve a contagem', () => {
    const store = openStore(':memory:');
    const showId = makeShow(store, 'serie');
    const outroId = makeShow(store, 'outra');

    store.upsertEpisodes(showId, [
      makeEpisode({ id: 'serie/ep01.mp4', orderIndex: 0 }),
      makeEpisode({ id: 'serie/ep02.mp4', orderIndex: 1 }),
      makeEpisode({ id: 'serie/ep03.mp4', orderIndex: 2 }),
    ]);
    store.upsertEpisodes(outroId, [makeEpisode({ id: 'outra/ep01.mp4', orderIndex: 0 })]);

    const removed = store.pruneEpisodes(showId, ['serie/ep01.mp4', 'serie/ep03.mp4']);

    expect(removed).toBe(1);
    expect(store.listEpisodes(showId).map((row) => row.id)).toEqual([
      'serie/ep01.mp4',
      'serie/ep03.mp4',
    ]);
    // a outra serie nao pode ser tocada mesmo com keepIds que nao mencionam ela
    expect(store.listEpisodes(outroId).map((row) => row.id)).toEqual(['outra/ep01.mp4']);
    expect(store.getEpisode('serie/ep02.mp4')).toBeNull();

    store.close();
  });

  it('keepIds vazio limpa a serie inteira', () => {
    const store = openStore(':memory:');
    const showId = makeShow(store);
    store.upsertEpisodes(showId, [
      makeEpisode({ id: 'serie/ep01.mp4', orderIndex: 0 }),
      makeEpisode({ id: 'serie/ep02.mp4', orderIndex: 1 }),
    ]);

    expect(store.pruneEpisodes(showId, [])).toBe(2);
    expect(store.listEpisodes(showId)).toEqual([]);

    store.close();
  });
});

describe('getCachedProbe', () => {
  it('devolve o ProbeResult quando mtime e size batem', () => {
    const store = openStore(':memory:');
    const showId = makeShow(store);
    store.upsertEpisodes(showId, [makeEpisode({ mtimeMs: 111, size: 222 })]);

    expect(store.getCachedProbe('serie/ep01.mp4', 111, 222)).toEqual({
      durationMs: 1_320_000,
      videoCodec: 'h264',
      audioCodec: 'aac',
      width: 640,
      height: 480,
      faststart: true,
      audioTracks: AUDIOS,
      subtitleTracks: LEGENDAS,
    });

    store.close();
  });
});

describe('invalidacao do cache de probe', () => {
  it('invalida quando so o mtime mudou', () => {
    const store = openStore(':memory:');
    const showId = makeShow(store);
    store.upsertEpisodes(showId, [makeEpisode({ mtimeMs: 111, size: 222 })]);

    expect(store.getCachedProbe('serie/ep01.mp4', 111, 222)).not.toBeNull();
    expect(store.getCachedProbe('serie/ep01.mp4', 112, 222)).toBeNull();

    store.close();
  });

  it('invalida quando so o size mudou', () => {
    const store = openStore(':memory:');
    const showId = makeShow(store);
    store.upsertEpisodes(showId, [makeEpisode({ mtimeMs: 111, size: 222 })]);

    expect(store.getCachedProbe('serie/ep01.mp4', 111, 222)).not.toBeNull();
    expect(store.getCachedProbe('serie/ep01.mp4', 111, 223)).toBeNull();

    store.close();
  });

  it('devolve null para id desconhecido', () => {
    const store = openStore(':memory:');
    expect(store.getCachedProbe('serie/nunca-vista.mp4', 111, 222)).toBeNull();
    store.close();
  });

  it('volta a valer depois de um upsert com o mtime e o size novos', () => {
    const store = openStore(':memory:');
    const showId = makeShow(store);
    store.upsertEpisodes(showId, [makeEpisode({ mtimeMs: 111, size: 222 })]);
    store.upsertEpisodes(showId, [
      makeEpisode({ mtimeMs: 999, size: 888, durationMs: 60_000, faststart: false }),
    ]);

    expect(store.getCachedProbe('serie/ep01.mp4', 111, 222)).toBeNull();
    expect(store.getCachedProbe('serie/ep01.mp4', 999, 888)).toEqual({
      durationMs: 60_000,
      videoCodec: 'h264',
      audioCodec: 'aac',
      width: 640,
      height: 480,
      faststart: false,
      audioTracks: AUDIOS,
      subtitleTracks: LEGENDAS,
    });

    store.close();
  });

  it('linha antiga sem trilhas conta como cache miss e e reprobada', () => {
    const base = mkdtempSync(join(tmpdir(), 'index-store-'));
    const dbPath = join(base, 'library.db');

    const store = openStore(dbPath);
    const showId = makeShow(store);
    store.upsertEpisodes(showId, [makeEpisode({ mtimeMs: 111, size: 222 })]);
    store.close();

    // Um indice gravado antes desta feature: as colunas existem (a migracao
    // rodou) mas estao NULL. O arquivo nao mudou, entao mtime e size ainda
    // batem - e mesmo assim o probe tem que rodar de novo.
    const raw = new Database(dbPath);
    raw.exec('UPDATE episodes SET audio_tracks = NULL, subtitle_tracks = NULL');
    raw.close();

    const reaberto = openStore(dbPath);
    expect(reaberto.getCachedProbe('serie/ep01.mp4', 111, 222)).toBeNull();
    // E a leitura normal nao pode explodir por causa do NULL.
    expect(reaberto.getEpisode('serie/ep01.mp4')?.audioTracks).toEqual([]);
    expect(reaberto.getEpisode('serie/ep01.mp4')?.subtitleTracks).toEqual([]);
    reaberto.close();

    rmSync(base, { recursive: true, force: true });
  });
});

describe('dbPath em disco', () => {
  it('cria o diretorio do dbPath quando ele nao existe', () => {
    const base = mkdtempSync(join(tmpdir(), 'index-store-'));
    const dbPath = join(base, 'data', 'nested', 'library.db');
    expect(existsSync(dirname(dbPath))).toBe(false);

    const store = openStore(dbPath);
    store.upsertShow({ slug: 'a', name: 'A', absolutePath: '/lib/A' });
    store.close();

    expect(existsSync(dbPath)).toBe(true);
    rmSync(base, { recursive: true, force: true });
  });

  it('mantem os numeros de canal depois de fechar e reabrir', () => {
    const base = mkdtempSync(join(tmpdir(), 'index-store-'));
    const dbPath = join(base, 'library.db');

    const first = openStore(dbPath);
    first.upsertShow({ slug: 'a', name: 'A', absolutePath: '/lib/A' });
    first.upsertShow({ slug: 'b', name: 'B', absolutePath: '/lib/B' });
    first.pruneShows(['a']);
    first.close();

    const second = openStore(dbPath);
    expect(second.listShows().map((row) => [row.slug, row.channelNumber])).toEqual([['a', 1]]);
    // o contador de canais sobrevive ao restart: 'b' nao volta ao pool
    expect(second.upsertShow({ slug: 'c', name: 'C', absolutePath: '/lib/C' }).channelNumber).toBe(3);
    second.close();

    rmSync(base, { recursive: true, force: true });
  });

  it('nao cria diretorio para :memory:', () => {
    const store = openStore(':memory:');
    store.close();
    expect(existsSync(':memory:')).toBe(false);
  });
});

describe('integridade', () => {
  it('pruneShows leva junto os episodios da serie removida', () => {
    const store = openStore(':memory:');
    const showId = makeShow(store, 'serie');
    const outroId = makeShow(store, 'outra');
    store.upsertEpisodes(showId, [makeEpisode({ id: 'serie/ep01.mp4' })]);
    store.upsertEpisodes(outroId, [makeEpisode({ id: 'outra/ep01.mp4' })]);

    store.pruneShows(['outra']);

    expect(store.getEpisode('serie/ep01.mp4')).toBeNull();
    expect(store.listEpisodes(showId)).toEqual([]);
    expect(store.getEpisode('outra/ep01.mp4')).not.toBeNull();

    store.close();
  });

  it('usa WAL em banco de arquivo', () => {
    const base = mkdtempSync(join(tmpdir(), 'index-store-'));
    const dbPath = join(base, 'library.db');
    const store = openStore(dbPath);
    store.upsertShow({ slug: 'a', name: 'A', absolutePath: '/lib/A' });

    // o arquivo -wal so aparece quando o journal_mode e WAL de fato
    expect(existsSync(`${dbPath}-wal`)).toBe(true);

    store.close();
    rmSync(base, { recursive: true, force: true });
  });
});

describe('transacao de upsertEpisodes', () => {
  it('desfaz o lote inteiro quando uma linha do meio e invalida', () => {
    const store = openStore(':memory:');
    const showId = makeShow(store);

    // title NOT NULL: a segunda linha explode e o lote nao pode ficar pela metade.
    // O cast e proposital, o teste simula um chamador em JavaScript sem tipos.
    const linhaInvalida = {
      ...makeEpisode({ id: 'serie/ep02.mp4', orderIndex: 1 }),
      title: null,
    } as unknown as Omit<EpisodeRow, 'showId'>;

    expect(() =>
      store.upsertEpisodes(showId, [
        makeEpisode({ id: 'serie/ep01.mp4', orderIndex: 0 }),
        linhaInvalida,
        makeEpisode({ id: 'serie/ep03.mp4', orderIndex: 2 }),
      ]),
    ).toThrow();

    expect(store.listEpisodes(showId)).toEqual([]);

    store.close();
  });
});

describe('metadata da serie (schema 3)', () => {
  it('serie sem busca ainda devolve null, nao linha vazia', () => {
    const store = openStore(':memory:');
    const showId = makeShow(store);
    expect(store.getShowMetadata(showId)).toBeNull();
    store.close();
  });

  it('roundtrip completo, com boolean e nulos', () => {
    const store = openStore(':memory:');
    const showId = makeShow(store);

    store.upsertShowMetadata({
      showId,
      posterFile: `${showId}.jpg`,
      backdropFile: `${showId}.jpg`,
      backdropCheckedAt: null,
      backdropSource: null,
      year: 1985,
      overview: 'Sinopse.',
      source: 'tvmaze',
      fetchedAt: 1_700_000_000_000,
      notFound: false,
      manual: false,
    });

    expect(store.getShowMetadata(showId)).toEqual({
      showId,
      posterFile: `${showId}.jpg`,
      backdropFile: `${showId}.jpg`,
      backdropCheckedAt: null,
      backdropSource: null,
      year: 1985,
      overview: 'Sinopse.',
      source: 'tvmaze',
      fetchedAt: 1_700_000_000_000,
      notFound: false,
      manual: false,
    });

    store.close();
  });

  it('linha de "nao encontrado" guarda o instante da tentativa', () => {
    // E o que o TTL de sete dias mede: sem `fetchedAt` nao ha como re-tentar.
    const store = openStore(':memory:');
    const showId = makeShow(store);

    store.upsertShowMetadata({
      showId,
      posterFile: null,
      backdropFile: null,
      backdropCheckedAt: null,
      backdropSource: null,
      year: null,
      overview: null,
      source: null,
      fetchedAt: 42,
      notFound: true,
      manual: false,
    });

    const row = store.getShowMetadata(showId)!;
    expect(row.notFound).toBe(true);
    expect(row.fetchedAt).toBe(42);
    expect(row.posterFile).toBeNull();

    store.close();
  });

  it('upsert sobrescreve a tentativa anterior em vez de duplicar', () => {
    const store = openStore(':memory:');
    const showId = makeShow(store);

    store.upsertShowMetadata({
      showId,
      posterFile: null,
      backdropFile: null,
      backdropCheckedAt: null,
      backdropSource: null,
      year: null,
      overview: null,
      source: null,
      fetchedAt: 1,
      notFound: true,
      manual: false,
    });
    store.upsertShowMetadata({
      showId,
      posterFile: '1.jpg',
      backdropFile: null,
      backdropCheckedAt: null,
      backdropSource: null,
      year: 1985,
      overview: 'Achei depois.',
      source: 'itunes',
      fetchedAt: 2,
      notFound: false,
      manual: false,
    });

    expect(store.getShowMetadata(showId)).toMatchObject({
      posterFile: '1.jpg',
      source: 'itunes',
      notFound: false,
    });

    store.close();
  });

  it('serie removida do disco leva a metadata junto', () => {
    const store = openStore(':memory:');
    const id = makeShow(store, 'serie');
    const outro = makeShow(store, 'outra');
    for (const showId of [id, outro]) {
      store.upsertShowMetadata({
        showId,
        posterFile: `${showId}.jpg`,
        backdropFile: null,
        backdropCheckedAt: null,
        backdropSource: null,
        year: null,
        overview: null,
        source: 'tvmaze',
        fetchedAt: 1,
        notFound: false,
        manual: false,
      });
    }

    store.pruneShows(['outra']);

    expect(store.getShowMetadata(id)).toBeNull();
    expect(store.getShowMetadata(outro)).not.toBeNull();

    store.close();
  });

  it('indice na versao 2 e migrado sem perder episodio', () => {
    const base = mkdtempSync(join(tmpdir(), 'index-store-v2-'));
    const dbPath = join(base, 'library.db');

    // Um banco exatamente como o schema 2 deixava: sem `show_metadata`.
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version (version) VALUES (2);
      CREATE TABLE shows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        channel_number INTEGER NOT NULL UNIQUE,
        absolute_path TEXT NOT NULL
      );
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE episodes (
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
        size INTEGER NOT NULL,
        audio_tracks TEXT,
        subtitle_tracks TEXT
      );
      INSERT INTO shows (slug, name, channel_number, absolute_path)
        VALUES ('serie', 'Serie', 4, '/lib/serie');
      INSERT INTO episodes (
        id, show_id, absolute_path, title, order_index, duration_ms, faststart, mtime_ms, size
      ) VALUES ('serie/ep01.mp4', 1, '/lib/serie/ep01.mp4', 'ep01', 0, 1000, 1, 5, 6);
    `);
    raw.close();

    const store = openStore(dbPath);

    // Migrou sem tocar no que ja existia...
    expect(store.listShows().map((s) => s.channelNumber)).toEqual([4]);
    expect(store.getEpisode('serie/ep01.mp4')?.title).toBe('ep01');
    // ...e a tabela nova existe e responde.
    expect(store.getShowMetadata(1)).toBeNull();
    store.upsertShowMetadata({
      showId: 1,
      posterFile: '1.jpg',
      backdropFile: null,
      backdropCheckedAt: null,
      backdropSource: null,
      year: 1985,
      overview: null,
      source: 'tvmaze',
      fetchedAt: 7,
      notFound: false,
      manual: false,
    });
    expect(store.getShowMetadata(1)?.posterFile).toBe('1.jpg');

    store.close();

    const conferencia = new Database(dbPath);
    const versao = conferencia.prepare('SELECT version FROM schema_version').get() as {
      version: number;
    };
    expect(versao.version).toBe(SCHEMA_VERSION_ATUAL);
    conferencia.close();

    rmSync(base, { recursive: true, force: true });
  });
});

describe('countEpisodesByShow', () => {
  it('conta cada serie separadamente, numa consulta so', () => {
    const store = openStore(':memory:');
    const a = makeShow(store, 'a');
    const b = makeShow(store, 'b');
    store.upsertEpisodes(a, [
      makeEpisode({ id: 'a/ep01.mp4', orderIndex: 0 }),
      makeEpisode({ id: 'a/ep02.mp4', orderIndex: 1 }),
      makeEpisode({ id: 'a/ep03.mp4', orderIndex: 2 }),
    ]);
    store.upsertEpisodes(b, [makeEpisode({ id: 'b/ep01.mp4' })]);

    const contagem = store.countEpisodesByShow();
    expect(contagem.get(a)).toBe(3);
    expect(contagem.get(b)).toBe(1);
    store.close();
  });

  it('serie sem episodio nao aparece no mapa', () => {
    // Quem chama trata a ausencia como zero; o canal e filtrado da listagem.
    const store = openStore(':memory:');
    const vazia = makeShow(store, 'vazia');
    expect(store.countEpisodesByShow().has(vazia)).toBe(false);
    store.close();
  });

  it('bate exatamente com listEpisodes().length, inclusive depois de podar', () => {
    // E o valor que `episodeCount` carregava antes de a contagem virar lote:
    // qualquer divergencia mudaria o contrato publico.
    const store = openStore(':memory:');
    const showId = makeShow(store);
    store.upsertEpisodes(showId, [
      makeEpisode({ id: 'serie/ep01.mp4', orderIndex: 0 }),
      makeEpisode({ id: 'serie/ep02.mp4', orderIndex: 1 }),
      makeEpisode({ id: 'serie/ep03.mp4', orderIndex: 2 }),
    ]);
    expect(store.countEpisodesByShow().get(showId)).toBe(store.listEpisodes(showId).length);

    store.pruneEpisodes(showId, ['serie/ep01.mp4']);
    expect(store.countEpisodesByShow().get(showId)).toBe(store.listEpisodes(showId).length);

    store.pruneEpisodes(showId, []);
    expect(store.countEpisodesByShow().get(showId) ?? 0).toBe(store.listEpisodes(showId).length);
    store.close();
  });

  it('acervo vazio devolve um mapa vazio, nao lanca', () => {
    const store = openStore(':memory:');
    expect(store.countEpisodesByShow().size).toBe(0);
    store.close();
  });
});

describe('hasShowsWithoutMetadata', () => {
  it('acervo vazio nao tem trabalho pendente', () => {
    const store = openStore(':memory:');
    expect(store.hasShowsWithoutMetadata()).toBe(false);
    store.close();
  });

  it('serie sem linha nenhuma conta como pendente', () => {
    const store = openStore(':memory:');
    makeShow(store, 'serie');
    expect(store.hasShowsWithoutMetadata()).toBe(true);
    store.close();
  });

  it('linha de "nao encontrado" JA e resposta: nao conta como pendente', () => {
    // Se contasse, cada abertura do catalogo dispararia uma rodada nova de rede
    // para uma serie que o provedor ja disse nao conhecer.
    const store = openStore(':memory:');
    const showId = makeShow(store, 'obscura');
    store.upsertShowMetadata({
      showId,
      posterFile: null,
      backdropFile: null,
      backdropCheckedAt: null,
      backdropSource: null,
      year: null,
      overview: null,
      source: null,
      fetchedAt: 1,
      notFound: true,
      manual: false,
    });
    expect(store.hasShowsWithoutMetadata()).toBe(false);
    store.close();
  });

  it('basta UMA serie sem linha, entre varias resolvidas', () => {
    const store = openStore(':memory:');
    const resolvida = makeShow(store, 'resolvida');
    store.upsertShowMetadata({
      showId: resolvida,
      posterFile: '1.jpg',
      backdropFile: null,
      backdropCheckedAt: null,
      backdropSource: null,
      year: null,
      overview: null,
      source: 'tvmaze',
      fetchedAt: 1,
      notFound: false,
      manual: false,
    });
    expect(store.hasShowsWithoutMetadata()).toBe(false);

    makeShow(store, 'nova');
    expect(store.hasShowsWithoutMetadata()).toBe(true);
    store.close();
  });
});

describe('temporadas', () => {
  it('devolve as temporadas presentes, crescente e sem repetir', () => {
    const store = openStore(':memory:');
    const showId = makeShow(store);
    store.upsertEpisodes(showId, [
      makeEpisode({ id: 'serie/s02e01.mp4', season: 2, orderIndex: 0 }),
      makeEpisode({ id: 'serie/s01e01.mp4', season: 1, orderIndex: 1 }),
      makeEpisode({ id: 'serie/s02e02.mp4', season: 2, orderIndex: 2 }),
    ]);

    expect(store.listSeasons(showId)).toEqual([1, 2]);
    store.close();
  });

  it('episodio sem temporada nao entra na lista', () => {
    // A aba "Sem temporada" e deduzida pelo cliente quando a lista chega.
    const store = openStore(':memory:');
    const showId = makeShow(store);
    store.upsertEpisodes(showId, [
      makeEpisode({ id: 'serie/solto.mp4', season: null, orderIndex: 0 }),
      makeEpisode({ id: 'serie/s01e01.mp4', season: 1, orderIndex: 1 }),
    ]);

    expect(store.listSeasons(showId)).toEqual([1]);
    store.close();
  });

  it('serie sem pastas de temporada devolve [] e nao null', () => {
    const store = openStore(':memory:');
    const showId = makeShow(store);
    store.upsertEpisodes(showId, [makeEpisode({ season: null })]);

    expect(store.listSeasons(showId)).toEqual([]);
    expect(store.listSeasonsByShow().get(showId)).toBeUndefined();
    store.close();
  });

  it('listSeasonsByShow devolve o mesmo que listSeasons, serie a serie', () => {
    // As duas alimentam o mesmo campo do contrato: `GET /api/channels` usa a
    // consulta em lote e o "no ar" usa a de uma serie so.
    const store = openStore(':memory:');
    const a = makeShow(store, 'a');
    const b = makeShow(store, 'b');
    store.upsertEpisodes(a, [
      makeEpisode({ id: 'a/s03e01.mp4', season: 3, orderIndex: 0 }),
      makeEpisode({ id: 'a/s01e01.mp4', season: 1, orderIndex: 1 }),
    ]);
    store.upsertEpisodes(b, [makeEpisode({ id: 'b/s02e01.mp4', season: 2 })]);

    const emLote = store.listSeasonsByShow();
    expect(emLote.get(a)).toEqual(store.listSeasons(a));
    expect(emLote.get(b)).toEqual(store.listSeasons(b));
    expect(emLote.get(a)).toEqual([1, 3]);
    store.close();
  });

  it('acervo vazio devolve um mapa vazio, nao lanca', () => {
    const store = openStore(':memory:');
    expect(store.listSeasonsByShow().size).toBe(0);
    store.close();
  });
});

describe('indexVersion', () => {
  it('nao anda sozinho: duas leituras seguidas dao o mesmo numero', () => {
    const store = openStore(':memory:');
    expect(store.indexVersion()).toBe(store.indexVersion());
    store.close();
  });

  it('anda a cada escrita que muda a grade', () => {
    const store = openStore(':memory:');
    const inicial = store.indexVersion();

    const showId = makeShow(store);
    const depoisDoShow = store.indexVersion();
    expect(depoisDoShow).toBeGreaterThan(inicial);

    store.upsertEpisodes(showId, [makeEpisode()]);
    const depoisDoEpisodio = store.indexVersion();
    expect(depoisDoEpisodio).toBeGreaterThan(depoisDoShow);

    store.pruneEpisodes(showId, []);
    expect(store.indexVersion()).toBeGreaterThan(depoisDoEpisodio);

    store.close();
  });

  it('nao anda por metadata: a capa chega sem mexer na grade', () => {
    // Se andasse, cada rodada de capa jogaria fora o cache de timeline inteiro.
    const store = openStore(':memory:');
    const showId = makeShow(store);
    store.upsertEpisodes(showId, [makeEpisode()]);

    const antes = store.indexVersion();
    store.upsertShowMetadata({
      showId,
      posterFile: '1.jpg',
      backdropFile: '1.jpg',
      backdropCheckedAt: null,
      backdropSource: null,
      year: 1985,
      overview: null,
      source: 'tmdb',
      fetchedAt: 1,
      notFound: false,
      manual: false,
    });
    store.upsertWatchHistory({
      episodeId: 'serie/ep01.mp4',
      positionMs: 1,
      durationMs: 2,
      updatedAt: 3,
      watchedAt: null,
    });
    expect(store.indexVersion()).toBe(antes);

    store.close();
  });

  it('enxerga o scan que rodou em OUTRO processo', () => {
    // `node dist/server/scan.js` e o unico jeito de reindexar no container: sem
    // isto o servidor serviria a grade antiga ate reiniciar.
    const base = mkdtempSync(join(tmpdir(), 'index-store-versao-'));
    const dbPath = join(base, 'library.db');

    const servidor = openStore(dbPath);
    const showId = makeShow(servidor, 'serie');
    servidor.upsertEpisodes(showId, [makeEpisode()]);
    const antes = servidor.indexVersion();

    const scanAvulso = openStore(dbPath);
    scanAvulso.upsertEpisodes(showId, [makeEpisode({ id: 'serie/ep02.mp4', orderIndex: 1 })]);
    scanAvulso.close();

    expect(servidor.indexVersion()).toBeGreaterThan(antes);
    servidor.close();

    rmSync(base, { recursive: true, force: true });
  });
});

describe('arte 16:9 (schema 8)', () => {
  it('guarda o nome do arquivo e devolve null quando nao ha', () => {
    const store = openStore(':memory:');
    const showId = makeShow(store);

    store.upsertShowMetadata({
      showId,
      posterFile: '1.jpg',
      backdropFile: '1.jpg',
      backdropCheckedAt: null,
      backdropSource: null,
      year: null,
      overview: null,
      source: 'tmdb',
      fetchedAt: 1,
      notFound: false,
      manual: false,
    });
    expect(store.getShowMetadata(showId)?.backdropFile).toBe('1.jpg');

    store.upsertShowMetadata({
      showId,
      posterFile: '1.jpg',
      backdropFile: null,
      backdropCheckedAt: null,
      backdropSource: null,
      year: null,
      overview: null,
      source: 'tvmaze',
      fetchedAt: 2,
      notFound: false,
      manual: false,
    });
    expect(store.getShowMetadata(showId)?.backdropFile).toBeNull();

    store.close();
  });

  it('indice na versao 7 ganha a coluna sem perder dado', () => {
    const base = mkdtempSync(join(tmpdir(), 'index-store-v7-'));
    const dbPath = join(base, 'library.db');

    const sete = openStore(dbPath);
    const showId = makeShow(sete, 'serie');
    sete.upsertEpisodes(sete.listShows()[0]!.id, [makeEpisode()]);
    sete.upsertShowMetadata({
      showId,
      posterFile: '1.jpg',
      backdropFile: null,
      backdropCheckedAt: null,
      backdropSource: null,
      year: 1985,
      overview: 'Sinopse.',
      source: 'tvmaze',
      fetchedAt: 42,
      notFound: false,
      manual: false,
    });
    sete.upsertWatchHistory({
      episodeId: 'serie/ep01.mp4',
      positionMs: 600_000,
      durationMs: 1_320_000,
      updatedAt: 7,
      watchedAt: null,
    });
    sete.setSetting('audio_lang', 'por');
    sete.close();

    // Um banco exatamente como o schema 7 deixava: sem as colunas de arte.
    rebobinar(dbPath, 7);

    const store = openStore(dbPath);

    // Migrou sem tocar no que ja existia...
    expect(store.listShows().map((s) => s.slug)).toEqual(['serie']);
    expect(store.getEpisode('serie/ep01.mp4')?.title).toBe('ep01');
    expect(store.getWatchHistory('serie/ep01.mp4')?.positionMs).toBe(600_000);
    expect(store.getSetting('audio_lang')).toBe('por');
    expect(store.getShowMetadata(showId)).toMatchObject({
      posterFile: '1.jpg',
      year: 1985,
      overview: 'Sinopse.',
      source: 'tvmaze',
      fetchedAt: 42,
    });
    // ...e a coluna nova existe, comecando vazia.
    expect(store.getShowMetadata(showId)?.backdropFile).toBeNull();

    store.upsertShowMetadata({
      showId,
      posterFile: '1.jpg',
      backdropFile: '1.jpg',
      backdropCheckedAt: null,
      backdropSource: null,
      year: 1985,
      overview: 'Sinopse.',
      source: 'tmdb',
      fetchedAt: 43,
      notFound: false,
      manual: false,
    });
    expect(store.getShowMetadata(showId)?.backdropFile).toBe('1.jpg');
    store.close();

    const conferencia = new Database(dbPath);
    const versao = conferencia.prepare('SELECT version FROM schema_version').get() as {
      version: number;
    };
    expect(versao.version).toBe(SCHEMA_VERSION_ATUAL);
    conferencia.close();

    rmSync(base, { recursive: true, force: true });
  });
});

describe('carimbo de busca da arte (schema 9)', () => {
  it('separa "nunca procurei" de "procurei e nao ha"', () => {
    const store = openStore(':memory:');
    const showId = makeShow(store);

    const base = {
      showId,
      posterFile: '1.jpg',
      backdropSource: null,
      year: null,
      overview: null,
      source: 'tmdb',
      fetchedAt: 1,
      notFound: false,
      manual: false,
    };

    store.upsertShowMetadata({ ...base, backdropFile: null, backdropCheckedAt: null });
    expect(store.getShowMetadata(showId)?.backdropCheckedAt).toBeNull();

    // Procurada e nao havia: arquivo continua nulo, mas o carimbo mudou.
    store.upsertShowMetadata({ ...base, backdropFile: null, backdropCheckedAt: 99 });
    const row = store.getShowMetadata(showId)!;
    expect(row.backdropFile).toBeNull();
    expect(row.backdropCheckedAt).toBe(99);

    store.close();
  });

  it('indice na versao 8 ganha a coluna sem perder dado', () => {
    const base = mkdtempSync(join(tmpdir(), 'index-store-v8-'));
    const dbPath = join(base, 'library.db');

    const oito = openStore(dbPath);
    const showId = makeShow(oito, 'serie');
    oito.upsertEpisodes(showId, [makeEpisode()]);
    oito.upsertShowMetadata({
      showId,
      posterFile: '1.jpg',
      backdropFile: '1.jpg',
      backdropCheckedAt: 123,
      backdropSource: null,
      year: 1985,
      overview: 'Sinopse.',
      source: 'tmdb',
      fetchedAt: 42,
      notFound: false,
      manual: false,
    });
    oito.close();

    // Um banco exatamente como o schema 8 deixava: sem `backdrop_checked_at`.
    rebobinar(dbPath, 8);

    const store = openStore(dbPath);

    // Migrou sem tocar em capa, arte, ano nem sinopse...
    expect(store.getEpisode('serie/ep01.mp4')?.title).toBe('ep01');
    expect(store.getShowMetadata(showId)).toMatchObject({
      posterFile: '1.jpg',
      backdropFile: '1.jpg',
      year: 1985,
      overview: 'Sinopse.',
      source: 'tmdb',
      fetchedAt: 42,
    });
    // ...e a coluna nova comeca nula, que e "nunca procurei" - o unico valor
    // honesto para uma linha escrita antes de o carimbo existir.
    expect(store.getShowMetadata(showId)?.backdropCheckedAt).toBeNull();

    store.close();

    const conferencia = new Database(dbPath);
    const versao = conferencia.prepare('SELECT version FROM schema_version').get() as {
      version: number;
    };
    expect(versao.version).toBe(SCHEMA_VERSION_ATUAL);
    conferencia.close();

    rmSync(base, { recursive: true, force: true });
  });
});

describe('remux (schema 4)', () => {
  const TRILHAS_MP4 = [
    { index: 0, lang: 'por', title: 'AAC', codec: 'aac', isDefault: true },
    { index: 1, lang: 'por', title: 'Brazilian', codec: 'eac3', isDefault: false },
  ];

  function makeRemux(over: Partial<Parameters<Store['upsertRemux']>[0]> = {}) {
    return {
      episodeId: 'serie/ep01.mp4',
      file: 'abc.mp4',
      mtimeMs: 1_700_000_000_000,
      size: 123_456,
      audioTracks: TRILHAS_MP4.map((t) => ({ ...t })),
      createdAt: 42,
      ...over,
    };
  }

  it('roundtrip completo, valido apenas com mtime e size do fonte batendo', () => {
    const store = openStore(':memory:');
    store.upsertEpisodes(makeShow(store), [makeEpisode()]);
    store.upsertRemux(makeRemux());

    expect(store.getRemux('serie/ep01.mp4', 1_700_000_000_000, 123_456)).toEqual(makeRemux());
    // Fonte mudou: a copia e de outro arquivo, servi-la trocaria o episodio.
    expect(store.getRemux('serie/ep01.mp4', 1, 123_456)).toBeNull();
    expect(store.getRemux('serie/ep01.mp4', 1_700_000_000_000, 1)).toBeNull();
    store.close();
  });

  it('upsert sobrescreve a linha anterior em vez de duplicar', () => {
    const store = openStore(':memory:');
    store.upsertEpisodes(makeShow(store), [makeEpisode()]);
    store.upsertRemux(makeRemux());
    store.upsertRemux(makeRemux({ file: 'novo.mp4' }));

    expect(store.listRemuxFiles()).toEqual(['novo.mp4']);
    store.close();
  });

  it('episodio removido no prune leva a linha de remux junto', () => {
    const store = openStore(':memory:');
    const showId = makeShow(store);
    store.upsertEpisodes(showId, [makeEpisode()]);
    store.upsertRemux(makeRemux());

    store.pruneEpisodes(showId, []);
    expect(store.listRemuxFiles()).toEqual([]);
    store.close();
  });
});

describe('variantes de dublagem (schema 5)', () => {
  const VARIANTE = {
    episodeId: 'serie/ep01.mp4',
    audioIndex: 1,
    file: 'var1.mp4',
    mtimeMs: 1_700_000_000_000,
    size: 123_456,
    createdAt: 42,
  };

  it('roundtrip por (episodio, faixa), valido so com mtime e size batendo', () => {
    const store = openStore(':memory:');
    store.upsertEpisodes(makeShow(store), [makeEpisode()]);
    store.upsertAudioVariant(VARIANTE);

    expect(store.getAudioVariant('serie/ep01.mp4', 1, 1_700_000_000_000, 123_456)).toEqual(VARIANTE);
    // Outra faixa do mesmo episodio e outra linha.
    expect(store.getAudioVariant('serie/ep01.mp4', 0, 1_700_000_000_000, 123_456)).toBeNull();
    // Fonte mudou: variante e de outro arquivo.
    expect(store.getAudioVariant('serie/ep01.mp4', 1, 1, 123_456)).toBeNull();
    store.close();
  });

  it('arquivos de variante entram na lista da coleta', () => {
    const store = openStore(':memory:');
    store.upsertEpisodes(makeShow(store), [makeEpisode()]);
    store.upsertAudioVariant(VARIANTE);
    store.upsertAudioVariant({ ...VARIANTE, audioIndex: 0, file: 'var0.mp4' });
    expect(store.listAudioVariantFiles().sort()).toEqual(['var0.mp4', 'var1.mp4']);
    store.close();
  });

  it('episodio removido leva as variantes junto', () => {
    const store = openStore(':memory:');
    const showId = makeShow(store);
    store.upsertEpisodes(showId, [makeEpisode()]);
    store.upsertAudioVariant(VARIANTE);
    store.pruneEpisodes(showId, []);
    expect(store.listAudioVariantFiles()).toEqual([]);
    store.close();
  });
});

describe('historico de onde parou (schema 6)', () => {
  const LINHA = {
    episodeId: 'serie/ep01.mp4',
    positionMs: 600_000,
    durationMs: 1_320_000,
    updatedAt: 42,
    watchedAt: null,
  };

  it('roundtrip com upsert sobrescrevendo a posicao anterior', () => {
    const store = openStore(':memory:');
    store.upsertEpisodes(makeShow(store), [makeEpisode()]);
    store.upsertWatchHistory(LINHA);
    store.upsertWatchHistory({ ...LINHA, positionMs: 700_000, updatedAt: 43 });

    expect(store.getWatchHistory('serie/ep01.mp4')?.positionMs).toBe(700_000);
    store.close();
  });

  it('lista vem com o numero do canal, mais recente primeiro', () => {
    const store = openStore(':memory:');
    const showId = makeShow(store);
    store.upsertEpisodes(showId, [
      makeEpisode(),
      makeEpisode({ id: 'serie/ep02.mp4', orderIndex: 1 }),
    ]);
    store.upsertWatchHistory(LINHA);
    store.upsertWatchHistory({ ...LINHA, episodeId: 'serie/ep02.mp4', updatedAt: 99 });

    const lista = store.listWatchHistory(10);
    expect(lista.map((entry) => entry.episodeId)).toEqual(['serie/ep02.mp4', 'serie/ep01.mp4']);
    expect(lista[0]?.channelNumber).toBe(1);
    store.close();
  });

  it('delete apaga e episodio removido do indice leva o progresso junto', () => {
    const store = openStore(':memory:');
    const showId = makeShow(store);
    store.upsertEpisodes(showId, [makeEpisode()]);
    store.upsertWatchHistory(LINHA);

    store.deleteWatchHistory('serie/ep01.mp4');
    expect(store.getWatchHistory('serie/ep01.mp4')).toBeNull();

    store.upsertWatchHistory(LINHA);
    store.pruneEpisodes(showId, []);
    expect(store.listWatchHistory(10)).toEqual([]);
    store.close();
  });
});

describe('preferencias (schema 7)', () => {
  it('chave nunca escrita devolve null, nao string vazia', () => {
    const store = openStore(':memory:');
    expect(store.getSetting('audio_lang')).toBeNull();
    expect(store.listSettings()).toEqual({});
    store.close();
  });

  it('roundtrip com upsert sobrescrevendo o valor anterior', () => {
    const store = openStore(':memory:');
    store.setSetting('audio_lang', 'por');
    store.setSetting('audio_lang', 'eng');

    expect(store.getSetting('audio_lang')).toBe('eng');
    expect(store.listSettings()).toEqual({ audio_lang: 'eng' });
    store.close();
  });

  it('delete apaga so a chave pedida: e o que devolve a preferencia ao .env', () => {
    const store = openStore(':memory:');
    store.setSetting('audio_lang', 'por');
    store.setSetting('auto_remux', 'false');

    store.deleteSetting('audio_lang');

    expect(store.getSetting('audio_lang')).toBeNull();
    expect(store.listSettings()).toEqual({ auto_remux: 'false' });
    // Apagar chave inexistente e no-op, nao erro.
    expect(() => store.deleteSetting('nunca-existiu')).not.toThrow();
    store.close();
  });

  it('nao e apagada junto com o indice: prune de serie nao encosta nela', () => {
    // E o motivo de a tabela ser separada de `meta`: o que o usuario escolheu
    // no painel nao pode sumir num reset do indexador.
    const store = openStore(':memory:');
    const showId = makeShow(store);
    store.upsertEpisodes(showId, [makeEpisode()]);
    store.setSetting('subtitle_lang', 'off');

    store.pruneEpisodes(showId, []);
    store.pruneShows([]);

    expect(store.getSetting('subtitle_lang')).toBe('off');
    store.close();
  });

  it('sobrevive a fechar e reabrir o banco', () => {
    const base = mkdtempSync(join(tmpdir(), 'index-store-settings-'));
    const dbPath = join(base, 'library.db');

    const first = openStore(dbPath);
    first.setSetting('rescan_time', '02:15');
    first.close();

    const second = openStore(dbPath);
    expect(second.getSetting('rescan_time')).toBe('02:15');
    second.close();

    rmSync(base, { recursive: true, force: true });
  });

  it('indice na versao 6 e migrado sem perder dado', () => {
    const base = mkdtempSync(join(tmpdir(), 'index-store-v6-'));
    const dbPath = join(base, 'library.db');

    // Um banco na versao 6: tem tudo, menos `settings`.
    const seis = openStore(dbPath);
    const showId = makeShow(seis, 'serie');
    seis.upsertEpisodes(showId, [makeEpisode()]);
    seis.upsertWatchHistory({
      episodeId: 'serie/ep01.mp4',
      positionMs: 600_000,
      durationMs: 1_320_000,
      updatedAt: 42,
      watchedAt: null,
    });
    seis.close();

    // Desfaz o que veio depois da 6 para reencenar um banco daquela epoca.
    rebobinar(dbPath, 6);

    const store = openStore(dbPath);

    // Migrou sem tocar no que ja existia...
    expect(store.listShows().map((s) => s.slug)).toEqual(['serie']);
    expect(store.getEpisode('serie/ep01.mp4')?.title).toBe('ep01');
    expect(store.getWatchHistory('serie/ep01.mp4')?.positionMs).toBe(600_000);
    // ...e a tabela nova existe e responde.
    expect(store.listSettings()).toEqual({});
    store.setSetting('audio_lang', 'por');
    expect(store.getSetting('audio_lang')).toBe('por');
    store.close();

    const conferencia = new Database(dbPath);
    const versao = conferencia.prepare('SELECT version FROM schema_version').get() as {
      version: number;
    };
    expect(versao.version).toBe(SCHEMA_VERSION_ATUAL);
    conferencia.close();

    rmSync(base, { recursive: true, force: true });
  });
});

describe('quadro do episodio (schema 10)', () => {
  it('carimbo separa "nunca tentei" de "tentei e nao deu"', () => {
    const store = openStore(':memory:');
    const showId = makeShow(store);
    store.upsertEpisodes(showId, [makeEpisode()]);

    // Linha nova: nunca tentada, sem quadro.
    expect(store.getEpisode('serie/ep01.mp4')).toMatchObject({
      thumbFile: null,
      thumbCheckedAt: null,
    });
    expect(store.listThumbCandidates({ all: false }).map((c) => c.episodeId)).toEqual([
      'serie/ep01.mp4',
    ]);

    // Tentou e o arquivo nao rendeu quadro: o carimbo existe, o arquivo nao. E
    // este par que tira o episodio da fila - sem ele, todo arquivo que nao
    // rende quadro voltaria em cada rodada, para sempre.
    store.setEpisodeThumb({ episodeId: 'serie/ep01.mp4', file: null, checkedAt: 500 });
    expect(store.getEpisode('serie/ep01.mp4')).toMatchObject({
      thumbFile: null,
      thumbCheckedAt: 500,
    });
    expect(store.listThumbCandidates({ all: false })).toEqual([]);
    // O reset do painel ignora o carimbo: e o botao de "refaca tudo".
    expect(store.listThumbCandidates({ all: true })).toHaveLength(1);

    store.setEpisodeThumb({ episodeId: 'serie/ep01.mp4', file: '7.jpg', checkedAt: 600 });
    expect(store.getEpisode('serie/ep01.mp4')?.thumbFile).toBe('7.jpg');
    expect(store.listThumbFiles()).toEqual(['7.jpg']);

    store.close();
  });

  it('o candidato carrega rowid, duracao e o nome da serie, e nada mais', () => {
    const store = openStore(':memory:');
    const showId = makeShow(store, 'thundercats');
    store.upsertEpisodes(showId, [
      makeEpisode({ id: 'tc/ep01.mkv', orderIndex: 1, durationMs: 1_320_000 }),
      makeEpisode({ id: 'tc/ep02.mkv', orderIndex: 0, durationMs: 1_000 }),
    ]);

    const fila = store.listThumbCandidates({ all: false });
    // Ordem do catalogo: canal, e depois a grade dentro dele.
    expect(fila.map((c) => c.episodeId)).toEqual(['tc/ep02.mkv', 'tc/ep01.mkv']);
    expect(fila[0]).toEqual({
      rowId: expect.any(Number) as number,
      episodeId: 'tc/ep02.mkv',
      durationMs: 1_000,
      showName: 'thundercats',
    });
    // rowid e a identidade da LINHA: dois episodios, dois nomes de arquivo.
    expect(fila[0]?.rowId).not.toBe(fila[1]?.rowId);

    store.close();
  });

  it('rescan que troca o arquivo apaga o quadro; reencontrar o mesmo nao', () => {
    const store = openStore(':memory:');
    const showId = makeShow(store);
    store.upsertEpisodes(showId, [makeEpisode()]);
    store.setEpisodeThumb({ episodeId: 'serie/ep01.mp4', file: '1.jpg', checkedAt: 500 });

    // Rescan incremental tipico: o mesmo arquivo, o mesmo par (mtime, size).
    // Apagar aqui custaria 15 mil ffmpeg por madrugada para produzir
    // exatamente as mesmas imagens.
    store.upsertEpisodes(showId, [makeEpisode()]);
    expect(store.getEpisode('serie/ep01.mp4')).toMatchObject({
      thumbFile: '1.jpg',
      thumbCheckedAt: 500,
    });

    // Arquivo trocado no NAS: pode ser outro episodio inteiro, e servir a
    // miniatura antiga seria mostrar uma cena que nao esta mais ali.
    store.upsertEpisodes(showId, [makeEpisode({ size: 999, mtimeMs: 2_000 })]);
    expect(store.getEpisode('serie/ep01.mp4')).toMatchObject({
      thumbFile: null,
      thumbCheckedAt: null,
    });
    // E ele volta para a fila, porque o carimbo tambem foi embora.
    expect(store.listThumbCandidates({ all: false })).toHaveLength(1);
    expect(store.listThumbFiles()).toEqual([]);

    store.close();
  });

  it('setShowBackdrop grava a arte sem inventar uma busca de metadata', () => {
    const store = openStore(':memory:');
    const showId = makeShow(store);

    expect(store.listShowsWithoutBackdrop().map((s) => s.id)).toEqual([showId]);

    store.setShowBackdrop({ showId, file: `${String(showId)}.jpg`, source: 'frame' });

    const row = store.getShowMetadata(showId)!;
    expect(row.backdropFile).toBe(`${String(showId)}.jpg`);
    expect(row.backdropSource).toBe('frame');
    // Nada de capa, ano ou sinopse inventados - e a linha continua dizendo que
    // ninguem procurou metadata para esta serie ainda.
    expect(row).toMatchObject({ posterFile: null, year: null, overview: null, fetchedAt: 0 });
    expect(store.hasShowsWithoutMetadata()).toBe(true);
    // Com arte, sai da fila de quem precisa de uma.
    expect(store.listShowsWithoutBackdrop()).toEqual([]);

    // E o provedor, quando responde, grava por cima sem ser atrapalhado.
    store.upsertShowMetadata({
      showId,
      posterFile: '1.jpg',
      backdropFile: '1.jpg',
      backdropCheckedAt: 10,
      backdropSource: 'tmdb',
      year: 1985,
      overview: 'Sinopse.',
      source: 'tmdb',
      fetchedAt: 10,
      notFound: false,
      manual: false,
    });
    expect(store.hasShowsWithoutMetadata()).toBe(false);
    expect(store.getShowMetadata(showId)?.backdropSource).toBe('tmdb');

    store.close();
  });

  it('indice na versao 9 ganha as colunas sem perder dado', () => {
    const base = mkdtempSync(join(tmpdir(), 'index-store-v9-'));
    const dbPath = join(base, 'library.db');

    const nove = openStore(dbPath);
    const showId = makeShow(nove, 'serie');
    nove.upsertEpisodes(showId, [makeEpisode()]);
    nove.upsertWatchHistory({
      episodeId: 'serie/ep01.mp4',
      positionMs: 600_000,
      durationMs: 1_320_000,
      updatedAt: 7,
      watchedAt: null,
    });
    nove.upsertShowMetadata({
      showId,
      posterFile: '1.jpg',
      backdropFile: '1.jpg',
      backdropCheckedAt: 123,
      backdropSource: null,
      year: 1985,
      overview: 'Sinopse.',
      source: 'tmdb',
      fetchedAt: 42,
      notFound: false,
      manual: false,
    });
    nove.setSetting('audio_lang', 'por');
    nove.close();

    // Um banco exatamente como o schema 9 deixava.
    rebobinar(dbPath, 9);

    const store = openStore(dbPath);

    // Migrou sem tocar em episodio, historico, preferencia nem metadata...
    expect(store.getEpisode('serie/ep01.mp4')?.title).toBe('ep01');
    expect(store.getWatchHistory('serie/ep01.mp4')?.positionMs).toBe(600_000);
    expect(store.getSetting('audio_lang')).toBe('por');
    expect(store.getShowMetadata(showId)).toMatchObject({
      posterFile: '1.jpg',
      backdropFile: '1.jpg',
      backdropCheckedAt: 123,
      year: 1985,
      overview: 'Sinopse.',
      source: 'tmdb',
      fetchedAt: 42,
    });

    // ...e as colunas novas comecam vazias. Para o quadro isso e "nunca
    // tentei", entao todo episodio do acervo entra na primeira fila; para a
    // arte e "nao sei de onde veio", que e a verdade de uma linha escrita antes
    // de a coluna existir.
    expect(store.getEpisode('serie/ep01.mp4')).toMatchObject({
      thumbFile: null,
      thumbCheckedAt: null,
    });
    expect(store.getShowMetadata(showId)?.backdropSource).toBeNull();
    expect(store.listThumbCandidates({ all: false })).toHaveLength(1);

    store.close();

    const conferencia = new Database(dbPath);
    const versao = conferencia.prepare('SELECT version FROM schema_version').get() as {
      version: number;
    };
    expect(versao.version).toBe(SCHEMA_VERSION_ATUAL);
    conferencia.close();

    rmSync(base, { recursive: true, force: true });
  });
});

describe('ja vi este episodio (schema 11)', () => {
  const LINHA = {
    episodeId: 'serie/ep01.mp4',
    positionMs: 600_000,
    durationMs: 1_320_000,
    updatedAt: 42,
    watchedAt: null,
  };

  it('a marca sobrevive ao roundtrip e pode ser desfeita', () => {
    const store = openStore(':memory:');
    store.upsertEpisodes(makeShow(store), [makeEpisode()]);

    store.upsertWatchHistory(LINHA);
    expect(store.getWatchHistory('serie/ep01.mp4')?.watchedAt).toBeNull();

    store.upsertWatchHistory({ ...LINHA, positionMs: 0, watchedAt: 99 });
    expect(store.getWatchHistory('serie/ep01.mp4')?.watchedAt).toBe(99);
    expect(store.listWatchHistory(10)[0]?.watchedAt).toBe(99);

    // Rever desmarca; o upsert tem que APAGAR a marca, e nao so ignora-la.
    store.upsertWatchHistory({ ...LINHA, watchedAt: null });
    expect(store.getWatchHistory('serie/ep01.mp4')?.watchedAt).toBeNull();

    store.close();
  });

  it('limpar apaga o historico inteiro sem tocar nos episodios', () => {
    const store = openStore(':memory:');
    const showId = makeShow(store);
    store.upsertEpisodes(showId, [
      makeEpisode(),
      makeEpisode({ id: 'serie/ep02.mp4', orderIndex: 1 }),
    ]);
    store.upsertWatchHistory(LINHA);
    store.upsertWatchHistory({ ...LINHA, episodeId: 'serie/ep02.mp4' });

    store.clearWatchHistory();

    expect(store.listWatchHistory(10)).toEqual([]);
    expect(store.getEpisode('serie/ep01.mp4')).not.toBeNull();
    store.close();
  });

  it('indice na versao 10 ganha a coluna, e o historico velho entra como nao visto', () => {
    const base = mkdtempSync(join(tmpdir(), 'index-store-v10-'));
    const dbPath = join(base, 'library.db');

    const dez = openStore(dbPath);
    const showId = makeShow(dez, 'serie');
    dez.upsertEpisodes(showId, [makeEpisode()]);
    dez.upsertWatchHistory(LINHA);
    dez.close();

    rebobinar(dbPath, 10);

    const store = openStore(dbPath);
    // O que estava gravado continua ali...
    expect(store.getWatchHistory('serie/ep01.mp4')?.positionMs).toBe(600_000);
    // ...e a coluna nova comeca nula, que e a verdade: as linhas que tinham
    // terminado ja haviam sido APAGADAS pela regra antiga, e nao ha o que
    // recuperar.
    expect(store.getWatchHistory('serie/ep01.mp4')?.watchedAt).toBeNull();
    store.close();

    const conferencia = new Database(dbPath);
    const versao = conferencia.prepare('SELECT version FROM schema_version').get() as {
      version: number;
    };
    expect(versao.version).toBe(SCHEMA_VERSION_ATUAL);
    conferencia.close();

    rmSync(base, { recursive: true, force: true });
  });
});

describe('orcamento de disco das copias geradas (schema 12)', () => {
  function comCopias(): { base: string; dbPath: string; store: Store; showId: number } {
    const base = mkdtempSync(join(tmpdir(), 'index-store-cache-'));
    const dbPath = join(base, 'library.db');
    const store = openStore(dbPath);
    const showId = makeShow(store, 'serie');
    store.upsertEpisodes(showId, [makeEpisode()]);
    return { base, dbPath, store, showId };
  }

  it('remux e variante aparecem na MESMA lista: o teto e do diretorio, nao da tabela', () => {
    const { base, store } = comCopias();

    store.upsertRemux({
      episodeId: 'serie/ep01.mp4',
      file: 'aaa.mp4',
      mtimeMs: 1_700_000_000_000,
      size: 123_456,
      audioTracks: [],
      createdAt: 10,
    });
    store.upsertAudioVariant({
      episodeId: 'serie/ep01.mp4',
      audioIndex: 1,
      file: 'bbb.mp4',
      mtimeMs: 1_700_000_000_000,
      size: 123_456,
      createdAt: 20,
    });

    const files = store.listCacheFiles();
    expect(files).toHaveLength(2);
    expect(files.map((row) => row.key).sort()).toEqual([
      'remux:serie/ep01.mp4',
      'variant:serie/ep01.mp4:1',
    ]);
    expect(files.find((row) => row.kind === 'variant')?.audioIndex).toBe(1);

    store.close();
    rmSync(base, { recursive: true, force: true });
  });

  it('sem last_access_at a linha vale pelo created_at, e nao por zero', () => {
    // Se caisse em 0, toda copia anterior a versao 12 seria a "mais fria" do
    // cache e sairia primeiro, mesmo a que acabou de ser gerada.
    const { base, store } = comCopias();

    store.upsertRemux({
      episodeId: 'serie/ep01.mp4',
      file: 'aaa.mp4',
      mtimeMs: 1_700_000_000_000,
      size: 123_456,
      audioTracks: [],
      createdAt: 777,
    });

    expect(store.listCacheFiles()[0]?.lastAccessAt).toBe(777);

    store.close();
    rmSync(base, { recursive: true, force: true });
  });

  it('touch, medicao e remocao acertam a linha certa', () => {
    const { base, store } = comCopias();
    const key = 'remux:serie/ep01.mp4';

    store.upsertRemux({
      episodeId: 'serie/ep01.mp4',
      file: 'aaa.mp4',
      mtimeMs: 1_700_000_000_000,
      size: 123_456,
      audioTracks: [],
      createdAt: 1,
    });

    store.touchCacheFile(key, 999);
    store.setCacheFileBytes(key, 4096);
    expect(store.listCacheFiles()[0]).toMatchObject({ lastAccessAt: 999, bytes: 4096 });
    expect(store.getCacheFileBytes(key)).toBe(4096);
    expect(store.totalCacheBytes()).toBe(4096);

    store.deleteCacheFile(key);
    expect(store.listCacheFiles()).toEqual([]);
    expect(store.getCacheFileBytes(key)).toBe(0);
    expect(store.totalCacheBytes()).toBe(0);

    store.close();
    rmSync(base, { recursive: true, force: true });
  });

  it('id de episodio com ":" no caminho nao confunde a chave da variante', () => {
    // O id e um caminho relativo e pode conter ':'. Uma leitura por split(':')
    // apontaria para a faixa errada - ou para episodio nenhum.
    const base = mkdtempSync(join(tmpdir(), 'index-store-cache-colon-'));
    const dbPath = join(base, 'library.db');
    const store = openStore(dbPath);
    const showId = makeShow(store, 'serie');
    const id = 'serie/S01E01: O Piloto.mkv';
    store.upsertEpisodes(showId, [makeEpisode({ id, absolutePath: `/lib/${id}` })]);

    store.upsertAudioVariant({
      episodeId: id,
      audioIndex: 2,
      file: 'ccc.mp4',
      mtimeMs: 1_700_000_000_000,
      size: 123_456,
      createdAt: 5,
    });

    const key = store.listCacheFiles()[0]?.key ?? '';
    expect(key).toBe(`variant:${id}:2`);
    store.setCacheFileBytes(key, 2048);
    expect(store.getCacheFileBytes(key)).toBe(2048);

    store.close();
    rmSync(base, { recursive: true, force: true });
  });

  it('chave desconhecida nao apaga nada nem lanca', () => {
    const { base, store } = comCopias();

    store.upsertRemux({
      episodeId: 'serie/ep01.mp4',
      file: 'aaa.mp4',
      mtimeMs: 1_700_000_000_000,
      size: 123_456,
      audioTracks: [],
      createdAt: 1,
    });

    for (const ruim of ['', 'remux:', 'variant:sem-indice', 'variant:x:abc', 'outra-coisa']) {
      expect(() => {
        store.deleteCacheFile(ruim);
      }).not.toThrow();
    }
    expect(store.listCacheFiles()).toHaveLength(1);

    store.close();
    rmSync(base, { recursive: true, force: true });
  });

  it('indice na versao 11 ganha as colunas sem perder a copia ja registrada', () => {
    const { base, dbPath, store } = comCopias();

    store.upsertRemux({
      episodeId: 'serie/ep01.mp4',
      file: 'aaa.mp4',
      mtimeMs: 1_700_000_000_000,
      size: 123_456,
      audioTracks: [],
      createdAt: 55,
    });
    store.close();

    rebobinar(dbPath, 11);

    const migrado = openStore(dbPath);
    expect(migrado.getRemux('serie/ep01.mp4', 1_700_000_000_000, 123_456)?.file).toBe('aaa.mp4');
    // Colunas novas vazias: sem uso registrado, o carimbo cai no created_at e o
    // tamanho fica em 0 ate o evictor medir o arquivo.
    expect(migrado.listCacheFiles()[0]).toMatchObject({ lastAccessAt: 55, bytes: 0 });
    migrado.close();

    const conferencia = new Database(dbPath);
    const versao = conferencia.prepare('SELECT version FROM schema_version').get() as {
      version: number;
    };
    expect(versao.version).toBe(SCHEMA_VERSION_ATUAL);
    conferencia.close();

    rmSync(base, { recursive: true, force: true });
  });
});

describe('curadoria do acervo (schema 13)', () => {
  it('indice na versao 12 ganha as tabelas de curadoria sem perder o acervo', () => {
    const base = mkdtempSync(join(tmpdir(), 'index-store-v12-'));
    const dbPath = join(base, 'library.db');

    const doze = openStore(dbPath);
    const showId = makeShow(doze, 'serie');
    doze.upsertEpisodes(showId, [makeEpisode()]);
    doze.upsertShowMetadata({
      showId,
      posterFile: '1.jpg',
      backdropFile: null,
      backdropCheckedAt: null,
      backdropSource: null,
      year: 1985,
      overview: 'Sinopse.',
      source: 'tvmaze',
      fetchedAt: 42,
      notFound: false,
      manual: false,
    });
    doze.setSetting('audio_lang', 'por');
    doze.close();

    // Um banco exatamente como o schema 12 deixava: sem override, sem alias e
    // sem a coluna `manual`. E o estado do acervo de verdade que vai migrar.
    rebobinar(dbPath, 12);

    const store = openStore(dbPath);

    // Migrou sem tocar no que ja existia...
    expect(store.listShows().map((s) => s.slug)).toEqual(['serie']);
    expect(store.getEpisode('serie/ep01.mp4')?.title).toBe('ep01');
    expect(store.getSetting('audio_lang')).toBe('por');
    expect(store.getShowMetadata(showId)).toMatchObject({
      posterFile: '1.jpg',
      year: 1985,
      source: 'tvmaze',
      fetchedAt: 42,
    });
    // ...a coluna nova entra como "escolha automatica", que e a verdade: nada
    // no banco velho foi escolhido a mao.
    expect(store.getShowMetadata(showId)?.manual).toBe(false);

    // As tabelas novas nascem vazias e funcionando.
    expect(store.listShowOverrides()).toEqual([]);
    expect(store.listShowAliases()).toEqual([]);
    store.setShowOverride({ slug: 'serie', name: 'Outro', hidden: true, channelNumber: 9 });
    store.addShowAlias('serie-extra', 'serie');
    expect(store.getShowOverride('serie')).toMatchObject({
      name: 'Outro',
      hidden: true,
      channelNumber: 9,
    });
    expect(store.listShowAliases().map((row) => row.targetSlug)).toEqual(['serie']);
    // A serie oculta sai do catalogo publico, mas continua na lista do painel.
    expect(store.listVisibleShows()).toEqual([]);
    expect(store.listShows()).toHaveLength(1);
    store.close();

    const conferencia = new Database(dbPath);
    const versao = conferencia.prepare('SELECT version FROM schema_version').get() as {
      version: number;
    };
    expect(versao.version).toBe(SCHEMA_VERSION_ATUAL);
    conferencia.close();

    rmSync(base, { recursive: true, force: true });
  });
});

describe('show_override', () => {
  it('sobrevive ao prune que apaga a serie', () => {
    const store = openStore(':memory:');
    store.upsertShow({ slug: 'simpsons', name: 'Simpsons', absolutePath: '/lib/Simpsons' });
    store.setShowOverride({
      slug: 'simpsons',
      name: 'Os Simpsons',
      hidden: false,
      channelNumber: null,
    });

    // O NAS caiu: o scan nao viu a pasta e podou a serie inteira.
    store.pruneShows([]);

    expect(store.getShowOverride('simpsons')?.name).toBe('Os Simpsons');
    store.close();
  });

  it('linha neutra e apagada em vez de gravada', () => {
    const store = openStore(':memory:');
    store.setShowOverride({ slug: 'x', name: 'X', hidden: true, channelNumber: 7 });
    store.setShowOverride({ slug: 'x', name: null, hidden: false, channelNumber: null });

    expect(store.getShowOverride('x')).toBeNull();
    expect(store.listShowOverrides()).toEqual([]);
    store.close();
  });
});

describe('show_alias', () => {
  it('resolve a cadeia na escrita: alias de alias aponta para o slug final', () => {
    const store = openStore(':memory:');
    store.addShowAlias('b', 'a');
    store.addShowAlias('c', 'b');

    expect(store.listShowAliases()).toEqual([
      { slug: 'b', targetSlug: 'a', createdAt: expect.any(Number) },
      { slug: 'c', targetSlug: 'a', createdAt: expect.any(Number) },
    ]);
    store.close();
  });

  it('fusao encadeada nao perde a primeira: quem apontava para o slug fundido segue o alvo novo', () => {
    // Funde A em B e, depois, B em C. Sem repontar, a tabela guarda 'a -> b'
    // com B ja fundida: o painel mostra C com apenas ['b'] e A some da tela
    // sem nenhum jeito de solta-la.
    const store = openStore(':memory:');
    store.addShowAlias('a', 'b');
    store.addShowAlias('b', 'c');

    expect(store.listShowAliases().map((row) => [row.slug, row.targetSlug])).toEqual([
      ['a', 'c'],
      ['b', 'c'],
    ]);
    store.close();
  });

  it('recusa ciclo', () => {
    const store = openStore(':memory:');
    store.addShowAlias('b', 'a');

    expect(() => store.addShowAlias('a', 'b')).toThrow(/circular/);
    expect(() => store.addShowAlias('a', 'a')).toThrow(/circular/);
    store.close();
  });

  it('removeShowAlias desfaz', () => {
    const store = openStore(':memory:');
    store.addShowAlias('b', 'a');
    store.removeShowAlias('b');

    expect(store.listShowAliases()).toEqual([]);
    store.close();
  });
});

describe('setChannelNumber', () => {
  it('troca os numeros quando o destino esta ocupado', () => {
    const store = openStore(':memory:');
    const um = store.upsertShow({ slug: 'a', name: 'A', absolutePath: '/lib/A' });
    const dois = store.upsertShow({ slug: 'b', name: 'B', absolutePath: '/lib/B' });

    store.setChannelNumber(dois.id, um.channelNumber);

    expect(store.getShowByChannel(um.channelNumber)?.id).toBe(dois.id);
    expect(store.getShowByChannel(dois.channelNumber)?.id).toBe(um.id);
    store.close();
  });

  it('numero livre nao mexe em ninguem', () => {
    const store = openStore(':memory:');
    const um = store.upsertShow({ slug: 'a', name: 'A', absolutePath: '/lib/A' });

    store.setChannelNumber(um.id, 900);

    expect(store.getShowByChannel(900)?.id).toBe(um.id);
    expect(store.getShowByChannel(um.channelNumber)).toBeNull();
    store.close();
  });
});

describe('listVisibleShows', () => {
  it('esconde o que tem override hidden, mas listShows continua vendo tudo', () => {
    const store = openStore(':memory:');
    store.upsertShow({ slug: 'a', name: 'A', absolutePath: '/lib/A' });
    store.upsertShow({ slug: 'b', name: 'B', absolutePath: '/lib/B' });
    store.setShowOverride({ slug: 'b', name: null, hidden: true, channelNumber: null });

    expect(store.listVisibleShows().map((s) => s.slug)).toEqual(['a']);
    expect(store.listShows().map((s) => s.slug)).toEqual(['a', 'b']);
    store.close();
  });
});

describe('manual em show_metadata', () => {
  it('faz roundtrip', () => {
    const store = openStore(':memory:');
    const show = store.upsertShow({ slug: 'a', name: 'A', absolutePath: '/lib/A' });
    store.upsertShowMetadata({
      showId: show.id,
      posterFile: 'x.jpg',
      backdropFile: null,
      backdropCheckedAt: null,
      backdropSource: null,
      year: 1989,
      overview: 'sinopse',
      source: 'tmdb',
      fetchedAt: 10,
      notFound: false,
      manual: true,
    });

    expect(store.getShowMetadata(show.id)?.manual).toBe(true);
    store.close();
  });
});
