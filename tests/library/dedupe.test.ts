import { createHash } from 'node:crypto';
import { describe, expect, test, beforeEach, afterEach } from 'vitest';

import { mergeDuplicateShows } from '../../src/server/library/dedupe';
import {
  openStore,
  type EpisodeInput,
  type Store,
} from '../../src/server/library/index-store';
import { runScan } from '../../src/server/library/scan-job';

/**
 * A limpeza existe porque o prune do fim do scan so roda em rodada perfeita:
 * um scan que morre antes (raiz sem permissao, volume desmontado) congelaria o
 * par de canais duplicados que um scanner antigo gravou - para sempre, rescan
 * diario apos rescan diario.
 */

let store: Store;

beforeEach(() => {
  store = openStore(':memory:');
});

afterEach(() => {
  store.close();
});

/** O mesmo sufixo que `disambiguateSlugs` gera para um nome. */
function digestOf(name: string): string {
  return createHash('sha1').update(name.normalize('NFC')).digest('hex').slice(0, 6);
}

/** Episodio minimo e valido; o teste e da fusao, nao do probe. */
function ep(folder: string, file: string, orderIndex: number): EpisodeInput {
  return {
    id: `${folder}/${file}`,
    absolutePath: `/lib/${folder}/${file}`,
    title: file.replace(/\.[^.]+$/, ''),
    season: null,
    episode: null,
    orderIndex,
    durationMs: 60_000,
    videoCodec: 'h264',
    audioCodec: 'aac',
    width: 1280,
    height: 720,
    faststart: true,
    audioTracks: [],
    subtitleTracks: [],
    mtimeMs: 1,
    size: 1,
  };
}

describe('mergeDuplicateShows', () => {
  test('gemeo de digest funde no slug limpo, levando episodios e historico', async () => {
    // O rastro do bug do ano: pasta principal "The Simpsons (1989)" e a
    // temporada solta viraram DOIS canais identicos, o segundo com digest.
    const alvo = store.upsertShow({
      slug: 'the-simpsons',
      name: 'The Simpsons',
      absolutePath: '/lib/The Simpsons (1989)',
    });
    const duplicado = store.upsertShow({
      slug: `the-simpsons-${digestOf('The Simpsons')}`,
      name: 'The Simpsons',
      absolutePath: '/lib/Temporada 37',
    });
    store.upsertEpisodes(alvo.id, [ep('The Simpsons (1989)', 'The.Simpsons.S36E01.mkv', 0)]);
    store.upsertEpisodes(duplicado.id, [ep('Temporada 37', 'The.Simpsons.S37E01.mkv', 0)]);
    store.upsertShowMetadata({
      showId: duplicado.id,
      posterFile: null,
      backdropFile: null,
      backdropCheckedAt: null,
      backdropSource: null,
      year: 1989,
      overview: null,
      source: 'tvmaze',
      fetchedAt: 1,
      notFound: false,
    });
    store.upsertWatchHistory({
      episodeId: 'Temporada 37/The.Simpsons.S37E01.mkv',
      positionMs: 5_000,
      durationMs: 60_000,
      updatedAt: 1,
      watchedAt: null,
    });

    expect(mergeDuplicateShows(store)).toBe(1);

    const shows = store.listShows();
    expect(shows).toHaveLength(1);
    expect(shows[0]!.slug).toBe('the-simpsons');
    expect(shows[0]!.channelNumber).toBe(alvo.channelNumber);

    // Os episodios mudam de canal sem mudar de id, entao o historico segue.
    const episodios = store.listEpisodes(alvo.id);
    expect(episodios.map((e) => [e.id, e.orderIndex])).toEqual([
      ['The Simpsons (1989)/The.Simpsons.S36E01.mkv', 0],
      ['Temporada 37/The.Simpsons.S37E01.mkv', 1],
    ]);
    const historico = store.listWatchHistory(10);
    expect(historico).toHaveLength(1);
    expect(historico[0]!.channelNumber).toBe(alvo.channelNumber);

    // A metadata do duplicado morre com ele (CASCADE).
    expect(store.getShowMetadata(duplicado.id)).toBeNull();
  });

  test('series homonimas de anos DIFERENTES nao se fundem', () => {
    // "Doctor Who (1963)" e "Doctor Who (2005)" tambem viram dois canais
    // chamados "Doctor Who" com digest no segundo - e sao series distintas de
    // proposito. A limpeza nunca pode fundir o que o scan separa.
    store.upsertShow({
      slug: 'doctor-who',
      name: 'Doctor Who',
      absolutePath: '/lib/Doctor Who (1963)',
    });
    store.upsertShow({
      slug: `doctor-who-${digestOf('Doctor Who')}`,
      name: 'Doctor Who',
      absolutePath: '/lib/Doctor Who (2005)',
    });

    expect(mergeDuplicateShows(store)).toBe(0);
    expect(store.listShows()).toHaveLength(2);
  });

  test('sufixo hex que nao e digest do nome nao engana a limpeza', () => {
    store.upsertShow({ slug: 'akira', name: 'Akira', absolutePath: '/lib/Akira' });
    // Seis hex no fim, mas nao o sha1 do nome: pasta com esse nome mesmo.
    store.upsertShow({ slug: 'akira-0a1b2c', name: 'Akira', absolutePath: '/lib/Akira 0a1b2c' });

    expect(mergeDuplicateShows(store)).toBe(0);
    expect(store.listShows()).toHaveLength(2);
  });

  test('canal fantasma "Temporada 37" funde na serie que os arquivos apontam', () => {
    // Rastro do scanner de antes da derivacao de titulo: a pasta de temporada
    // solta virou canal proprio, mas os arquivos dizem de quem ela e.
    const alvo = store.upsertShow({
      slug: 'the-simpsons',
      name: 'The Simpsons',
      absolutePath: '/lib/The Simpsons',
    });
    const fantasma = store.upsertShow({
      slug: 'temporada-37',
      name: 'Temporada 37',
      absolutePath: '/lib/Temporada 37',
    });
    store.upsertEpisodes(alvo.id, [ep('The Simpsons', 'The.Simpsons.S36E01.mkv', 0)]);
    store.upsertEpisodes(fantasma.id, [
      ep('Temporada 37', 'The.Simpsons.S37E01.1080p.WEB-DL.mkv', 0),
      ep('Temporada 37', 'The.Simpsons.S37E02.1080p.WEB-DL.mkv', 1),
    ]);

    expect(mergeDuplicateShows(store)).toBe(1);
    const shows = store.listShows();
    expect(shows).toHaveLength(1);
    expect(shows[0]!.slug).toBe('the-simpsons');
    expect(store.listEpisodes(alvo.id)).toHaveLength(3);
  });

  test('fantasma cujos arquivos nao apontam serie nenhuma fica como esta', () => {
    const fantasma = store.upsertShow({
      slug: 's05',
      name: 'S05',
      absolutePath: '/lib/S05',
    });
    store.upsertEpisodes(fantasma.id, [ep('S05', '01.mp4', 0), ep('S05', '02.mp4', 1)]);

    expect(mergeDuplicateShows(store)).toBe(0);
    expect(store.listShows()).toHaveLength(1);
  });

  test('indice sem duplicata passa intocado', () => {
    store.upsertShow({ slug: 'he-man', name: 'He-Man', absolutePath: '/lib/He-Man' });
    store.upsertShow({
      slug: 'thundercats',
      name: 'ThunderCats',
      absolutePath: '/lib/ThunderCats',
    });

    expect(mergeDuplicateShows(store)).toBe(0);
    expect(store.listShows()).toHaveLength(2);
  });
});

describe('runScan com duplicata no indice', () => {
  test('scan que morre ANTES do prune ainda limpa a duplicata', async () => {
    // O prune roda so no fim de rodada perfeita; uma raiz ilegivel (EACCES,
    // volume desmontado) matava o scan antes e congelava o par duplicado -
    // rescan diario apos rescan diario. A limpeza roda antes de tocar o disco.
    store.upsertShow({
      slug: 'the-simpsons',
      name: 'The Simpsons',
      absolutePath: '/lib/The Simpsons (1989)',
    });
    store.upsertShow({
      slug: `the-simpsons-${digestOf('The Simpsons')}`,
      name: 'The Simpsons',
      absolutePath: '/lib/Temporada 37',
    });

    await expect(
      runScan({ root: '/nao/existe/em/lugar/nenhum', store }),
    ).rejects.toThrow(/raiz da biblioteca/i);

    expect(store.listShows()).toHaveLength(1);
    expect(store.listShows()[0]!.slug).toBe('the-simpsons');
  });
});
