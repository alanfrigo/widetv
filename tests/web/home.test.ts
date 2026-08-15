import { describe, expect, test } from 'vitest';
import type { ChannelSummary } from '../../src/shared/api-types';
import {
  emptySearchText,
  filterChannels,
  foldText,
  heroSentence,
  liveAside,
  shelfAside,
} from '../../src/web/home';

function channel(number: number, name: string): ChannelSummary {
  return {
    number,
    name,
    episodeCount: 10,
    posterUrl: null,
    backdropUrl: null,
    year: 1989,
    overview: null,
    seasons: [],
  };
}

const CATALOG: ChannelSummary[] = [
  channel(1, 'Os Simpsons'),
  channel(2, 'Os Cavaleiros do Zodíaco'),
  channel(12, 'A Formiga Atômica'),
];

describe('foldText', () => {
  test('tira acento e caixa para a comparacao', () => {
    expect(foldText('Zodíaco')).toBe('zodiaco');
    expect(foldText('  ATÔMICA ')).toBe('atomica');
  });
});

describe('busca do acervo', () => {
  test('sem consulta, o acervo inteiro', () => {
    expect(filterChannels(CATALOG, '')).toHaveLength(3);
    expect(filterChannels(CATALOG, '   ')).toHaveLength(3);
  });

  test('acha por pedaco do nome, sem acento e sem caixa', () => {
    expect(filterChannels(CATALOG, 'simpsons').map((c) => c.number)).toEqual([1]);
    expect(filterChannels(CATALOG, 'zodiaco').map((c) => c.number)).toEqual([2]);
    expect(filterChannels(CATALOG, 'ATOMICA').map((c) => c.number)).toEqual([12]);
  });

  test('quem decorou o numero do canal tambem acha', () => {
    expect(filterChannels(CATALOG, '12').map((c) => c.name)).toEqual(['A Formiga Atômica']);
  });

  test('busca sem resultado devolve lista vazia, nao o acervo', () => {
    expect(filterChannels(CATALOG, 'xyz')).toEqual([]);
  });

  test('a lista devolvida e uma copia: filtrar nao mexe no catalogo', () => {
    expect(filterChannels(CATALOG, '')).not.toBe(CATALOG);
  });
});

describe('textos das faixas', () => {
  test('sem busca o aside do acervo mostra a ordem', () => {
    expect(shelfAside('', 84)).toBe('A → Z');
  });

  test('com busca ele vira a contagem', () => {
    expect(shelfAside('simp', 1)).toBe('1 resultado');
    expect(shelfAside('simp', 3)).toBe('3 resultados');
    expect(shelfAside('xyz', 0)).toBe('nenhum resultado');
  });

  test('o ao vivo conta canais', () => {
    expect(liveAside(8)).toBe('8 canais');
    expect(liveAside(1)).toBe('1 canal');
  });

  test('o recado da busca vazia repete o que foi digitado', () => {
    expect(emptySearchText(' pokemon ')).toBe('Nada no acervo com "pokemon".');
  });
});

describe('frase do hero', () => {
  test('conta o episodio e ha quanto tempo ele comecou', () => {
    expect(heroSentence({ episodeNumber: 8, elapsedMs: 7 * 60_000 })).toContain(
      'Está tocando o episódio 8 há 7 minutos.',
    );
  });

  test('o fecho explica a grade e vale sempre', () => {
    const tail = 'entrar no canal é chegar no meio, como televisão.';
    expect(heroSentence(null)).toContain(tail);
    expect(heroSentence({ episodeNumber: 1, elapsedMs: 0 })).toContain(tail);
  });

  test('sem "/api/now" sobra o fecho, e nao um numero inventado', () => {
    expect(heroSentence(null).startsWith('A grade')).toBe(true);
  });

  test('o singular e o "acabou de comecar" nao saem torto', () => {
    expect(heroSentence({ episodeNumber: 3, elapsedMs: 60_000 })).toContain('há um minuto');
    expect(heroSentence({ episodeNumber: 3, elapsedMs: 5_000 })).toContain('há menos de um minuto');
  });

  test('arquivo sem numeracao nao vira "o episódio null"', () => {
    expect(heroSentence({ episodeNumber: null, elapsedMs: 120_000 })).toContain(
      'Está tocando um episódio há 2 minutos.',
    );
  });
});
