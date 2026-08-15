import { describe, expect, test } from 'vitest';
import {
  clampRail,
  firstRailCursor,
  moveRail,
  type RailCursor,
  type RailKey,
} from '../../src/web/rails';

/** Catalogo tipico: hero de 3 botoes, 8 canais no ar, 3 retomadas, 84 series. */
const HOME: readonly number[] = [3, 8, 3, 84];

function walk(start: RailCursor, keys: RailKey[], lengths: readonly number[]): RailCursor {
  return keys.reduce((cursor, key) => moveRail(cursor, key, lengths), start);
}

describe('dentro da faixa', () => {
  test('direita e esquerda andam item a item', () => {
    expect(moveRail({ rail: 1, index: 0 }, 'right', HOME)).toEqual({ rail: 1, index: 1 });
    expect(moveRail({ rail: 1, index: 4 }, 'left', HOME)).toEqual({ rail: 1, index: 3 });
  });

  test('as pontas seguram o cursor em vez de dar a volta', () => {
    expect(moveRail({ rail: 1, index: 0 }, 'left', HOME)).toEqual({ rail: 1, index: 0 });
    expect(moveRail({ rail: 1, index: 7 }, 'right', HOME)).toEqual({ rail: 1, index: 7 });
  });

  test('Home e End vao as pontas da FAIXA, nao da tela', () => {
    expect(moveRail({ rail: 3, index: 40 }, 'first', HOME)).toEqual({ rail: 3, index: 0 });
    expect(moveRail({ rail: 3, index: 40 }, 'last', HOME)).toEqual({ rail: 3, index: 83 });
    expect(moveRail({ rail: 1, index: 2 }, 'last', HOME)).toEqual({ rail: 1, index: 7 });
  });

  test('segurar a seta para a direita para no ultimo card', () => {
    const keys: RailKey[] = Array.from({ length: 30 }, () => 'right');
    expect(walk({ rail: 1, index: 0 }, keys, HOME)).toEqual({ rail: 1, index: 7 });
  });
});

describe('entre faixas', () => {
  test('baixo e cima trocam de faixa', () => {
    expect(moveRail({ rail: 0, index: 0 }, 'down', HOME)).toEqual({ rail: 1, index: 0 });
    expect(moveRail({ rail: 1, index: 0 }, 'up', HOME)).toEqual({ rail: 0, index: 0 });
  });

  test('a coluna aproximada e mantida na troca', () => {
    expect(moveRail({ rail: 1, index: 5 }, 'down', HOME)).toEqual({ rail: 2, index: 2 });
    expect(moveRail({ rail: 3, index: 6 }, 'up', HOME)).toEqual({ rail: 2, index: 2 });
  });

  test('faixa mais curta encosta o cursor no ultimo item', () => {
    // A faixa de retomada tem 3 itens; vir da coluna 5 do ao vivo cai no 2.
    expect(moveRail({ rail: 1, index: 7 }, 'down', HOME)).toEqual({ rail: 2, index: 2 });
  });

  test('as pontas da tela seguram o cursor', () => {
    expect(moveRail({ rail: 0, index: 1 }, 'up', HOME)).toEqual({ rail: 0, index: 1 });
    expect(moveRail({ rail: 3, index: 4 }, 'down', HOME)).toEqual({ rail: 3, index: 4 });
  });

  test('faixa vazia esta escondida na tela e por isso e pulada', () => {
    // Sem `/api/now` e sem historico, so sobram o hero e o acervo.
    const lengths = [3, 0, 0, 84];
    expect(moveRail({ rail: 0, index: 0 }, 'down', lengths)).toEqual({ rail: 3, index: 0 });
    expect(moveRail({ rail: 3, index: 2 }, 'up', lengths)).toEqual({ rail: 0, index: 2 });
  });

  test('sem faixa nenhuma o cursor nao inventa posicao', () => {
    expect(moveRail({ rail: 0, index: 0 }, 'down', [0, 0])).toEqual({ rail: 0, index: 0 });
    expect(moveRail({ rail: 1, index: 3 }, 'left', [])).toEqual({ rail: 0, index: 0 });
  });
});

describe('clampRail', () => {
  test('cursor dentro do que existe fica onde esta', () => {
    expect(clampRail({ rail: 2, index: 1 }, HOME)).toEqual({ rail: 2, index: 1 });
  });

  test('faixa que encolheu na busca traz o cursor para o ultimo card', () => {
    expect(clampRail({ rail: 3, index: 80 }, [3, 8, 3, 2])).toEqual({ rail: 3, index: 1 });
  });

  test('faixa que sumiu joga o cursor para a vizinha de baixo', () => {
    // O historico esvaziou com o cursor nele.
    expect(clampRail({ rail: 2, index: 1 }, [3, 8, 0, 84])).toEqual({ rail: 3, index: 1 });
  });

  test('sem vizinha embaixo, o cursor sobe', () => {
    expect(clampRail({ rail: 3, index: 5 }, [3, 8, 0, 0])).toEqual({ rail: 1, index: 5 });
  });

  test('indice quebrado nao vira NaN na tela', () => {
    expect(clampRail({ rail: -2, index: Number.NaN }, HOME)).toEqual({ rail: 0, index: 0 });
    expect(clampRail({ rail: 99, index: 1 }, HOME)).toEqual({ rail: 3, index: 1 });
  });
});

describe('firstRailCursor', () => {
  test('nasce na primeira faixa que tem algo', () => {
    expect(firstRailCursor(HOME)).toEqual({ rail: 0, index: 0 });
    expect(firstRailCursor([0, 0, 3, 84])).toEqual({ rail: 2, index: 0 });
  });

  test('tela inteira vazia nao trava a navegacao', () => {
    expect(firstRailCursor([0, 0])).toEqual({ rail: 0, index: 0 });
    expect(firstRailCursor([])).toEqual({ rail: 0, index: 0 });
  });
});
