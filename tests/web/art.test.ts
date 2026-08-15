import { describe, expect, test } from 'vitest';
import type { EpisodeRef } from '../../src/shared/api-types';
import { episodeArtUrl, imageUrl, wideArtUrl } from '../../src/web/art';

function ep(thumbUrl: string | null): EpisodeRef {
  return {
    id: 'simpsons/s01e01.mkv',
    title: 'Simpsons Roasting on an Open Fire',
    season: 1,
    episode: 1,
    durationMs: 22 * 60_000,
    width: 1920,
    height: 1080,
    audioTracks: [],
    subtitleTracks: [],
    thumbUrl,
  };
}

const THUMB = '/api/stream/simpsons%2Fs01e01.mkv/thumb';
const BACKDROP = '/api/channels/7/backdrop';

describe('imagem do card 16:9', () => {
  test('o quadro do episodio ganha da arte do canal', () => {
    expect(wideArtUrl(ep(THUMB), BACKDROP)).toBe(THUMB);
  });

  test('sem quadro, cai na arte do canal', () => {
    // E o normal por muito tempo: a fila do servidor leva minutos num acervo
    // grande, e ate ela chegar o card mostra a arte da serie.
    expect(wideArtUrl(ep(null), BACKDROP)).toBe(BACKDROP);
  });

  test('sem os dois, nao ha imagem nenhuma - sobra o listrado', () => {
    expect(wideArtUrl(ep(null), null)).toBeNull();
  });

  test('sem episodio nenhum, ainda vale a arte do canal', () => {
    expect(wideArtUrl(null, BACKDROP)).toBe(BACKDROP);
    expect(wideArtUrl(null, null)).toBeNull();
  });
});

describe('imagem da linha de episodio', () => {
  test('e o quadro do proprio arquivo, e so ele', () => {
    expect(episodeArtUrl(ep(THUMB))).toBe(THUMB);
    // A arte do canal NAO entra aqui: seria a mesma imagem repetida em todas as
    // linhas da serie, dizendo menos que o listrado.
    expect(episodeArtUrl(ep(null))).toBeNull();
  });
});

describe('guardas', () => {
  test('servidor mais velho, sem o campo, nao vira `src="undefined"`', () => {
    const older = { ...ep(null) } as Partial<EpisodeRef>;
    delete older.thumbUrl;
    const episode = older as EpisodeRef;

    expect(episodeArtUrl(episode)).toBeNull();
    expect(wideArtUrl(episode, BACKDROP)).toBe(BACKDROP);
    expect(imageUrl(undefined)).toBeNull();
  });

  test('string vazia nao e URL: `src=""` pede a propria pagina de volta', () => {
    expect(imageUrl('')).toBeNull();
    expect(wideArtUrl(ep(''), BACKDROP)).toBe(BACKDROP);
    expect(wideArtUrl(ep(''), '')).toBeNull();
  });
});
