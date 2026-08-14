import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import type { EpisodeRow, Store } from '../../src/server/library/index-store';
import { openStore } from '../../src/server/library/index-store';

const AUDIOS = [
  { index: 0, lang: 'por', title: 'Brazilian', codec: 'eac3', isDefault: true },
  { index: 1, lang: 'eng', title: null, codec: 'eac3', isDefault: false },
];

const LEGENDAS = [
  { index: 0, lang: 'por', title: 'Forcada', codec: 'subrip', isDefault: true, forced: true },
  { index: 1, lang: 'eng', title: null, codec: 'subrip', isDefault: false, forced: false },
];

/** Episodio completo com valores plausiveis; o teste sobrescreve o que importa. */
function makeEpisode(overrides: Partial<Omit<EpisodeRow, 'showId'>> = {}): Omit<EpisodeRow, 'showId'> {
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
    expect(episodes[0]).toEqual({ ...makeEpisode(), showId });

    store.close();
  });
});

describe('getEpisode', () => {
  it('acha o episodio pelo id estavel e devolve null quando nao existe', () => {
    const store = openStore(':memory:');
    const showId = makeShow(store);
    store.upsertEpisodes(showId, [makeEpisode()]);

    expect(store.getEpisode('serie/ep01.mp4')).toEqual({ ...makeEpisode(), showId });
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
