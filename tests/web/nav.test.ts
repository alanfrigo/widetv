import { describe, expect, test } from 'vitest';
import { countColumns, moveCursor, stepIndex, type NavKey } from '../../src/web/nav';

/** Aplica uma sequencia de teclas, como quem segura a seta. */
function walk(start: number, keys: NavKey[], count: number, columns: number): number {
  return keys.reduce((cursor, key) => moveCursor(cursor, key, count, columns), start);
}

describe('countColumns', () => {
  test('conta quantos itens dividem a primeira linha', () => {
    expect(countColumns([0, 0, 0, 0, 300, 300, 300, 300])).toBe(4);
  });

  test('grade de uma coluna so', () => {
    expect(countColumns([0, 240, 480])).toBe(1);
  });

  test('linha unica: todos os itens sao colunas', () => {
    expect(countColumns([12, 12, 12])).toBe(3);
  });

  test('sub-pixel de layout nao quebra a contagem', () => {
    expect(countColumns([0, 0.5, 1, 300.2])).toBe(3);
  });

  test('grade vazia ainda devolve uma coluna, para nao travar a navegacao', () => {
    expect(countColumns([])).toBe(1);
  });
});

describe('moveCursor na grade', () => {
  // 10 itens em 4 colunas:  0 1 2 3 / 4 5 6 7 / 8 9
  const COUNT = 10;
  const COLUMNS = 4;

  test('direita e esquerda andam item a item', () => {
    expect(moveCursor(0, 'right', COUNT, COLUMNS)).toBe(1);
    expect(moveCursor(5, 'left', COUNT, COLUMNS)).toBe(4);
  });

  test('direita atravessa a quebra de linha', () => {
    expect(moveCursor(3, 'right', COUNT, COLUMNS)).toBe(4);
    expect(moveCursor(4, 'left', COUNT, COLUMNS)).toBe(3);
  });

  test('as pontas seguram o cursor em vez de dar a volta', () => {
    expect(moveCursor(0, 'left', COUNT, COLUMNS)).toBe(0);
    expect(moveCursor(9, 'right', COUNT, COLUMNS)).toBe(9);
  });

  test('baixo e cima andam uma linha inteira', () => {
    expect(moveCursor(1, 'down', COUNT, COLUMNS)).toBe(5);
    expect(moveCursor(5, 'up', COUNT, COLUMNS)).toBe(1);
  });

  test('cima na primeira linha nao pula para o fim da grade', () => {
    expect(moveCursor(2, 'up', COUNT, COLUMNS)).toBe(2);
  });

  test('baixo na ultima linha fica parado', () => {
    expect(moveCursor(8, 'down', COUNT, COLUMNS)).toBe(8);
    expect(moveCursor(9, 'down', COUNT, COLUMNS)).toBe(9);
  });

  test('baixo com linha de baixo incompleta cai no ultimo item', () => {
    // Coluna 3 da segunda linha (indice 7) nao tem par embaixo: sem a correcao
    // a seta nao faria nada e a ultima linha ficaria inalcancavel.
    expect(moveCursor(7, 'down', COUNT, COLUMNS)).toBe(9);
    expect(moveCursor(6, 'down', COUNT, COLUMNS)).toBe(9);
  });

  test('inicio e fim vao direto para as pontas', () => {
    expect(moveCursor(5, 'first', COUNT, COLUMNS)).toBe(0);
    expect(moveCursor(5, 'last', COUNT, COLUMNS)).toBe(9);
  });

  test('uma coluna transforma a grade numa lista vertical', () => {
    expect(moveCursor(0, 'down', 3, 1)).toBe(1);
    expect(moveCursor(2, 'down', 3, 1)).toBe(2);
    expect(moveCursor(2, 'up', 3, 1)).toBe(1);
    expect(moveCursor(0, 'up', 3, 1)).toBe(0);
  });

  test('percorrer a grade toda com a seta para a direita para no ultimo', () => {
    const keys: NavKey[] = Array.from({ length: 20 }, () => 'right');
    expect(walk(0, keys, COUNT, COLUMNS)).toBe(9);
  });

  test('grade vazia nao produz indice negativo', () => {
    expect(moveCursor(0, 'down', 0, 4)).toBe(0);
    expect(moveCursor(3, 'left', 0, 4)).toBe(0);
  });

  test('cursor fora da lista e trazido de volta antes de andar', () => {
    // Acervo que encolheu num rescan com o foco no fim da grade.
    expect(moveCursor(99, 'left', COUNT, COLUMNS)).toBe(8);
    expect(moveCursor(-4, 'right', COUNT, COLUMNS)).toBe(1);
  });

  test('zero coluna e tratado como uma: layout nao pode travar a seta', () => {
    expect(moveCursor(0, 'down', 3, 0)).toBe(1);
  });
});

describe('stepIndex', () => {
  test('anda para o vizinho', () => {
    expect(stepIndex(1, 1, 5)).toBe(2);
    expect(stepIndex(1, -1, 5)).toBe(0);
  });

  test('da a volta nas duas pontas, como zapear numa TV', () => {
    expect(stepIndex(4, 1, 5)).toBe(0);
    expect(stepIndex(0, -1, 5)).toBe(4);
  });

  test('indice fora da lista recomeca do primeiro canal', () => {
    expect(stepIndex(-1, 1, 5)).toBe(0);
    expect(stepIndex(9, -1, 5)).toBe(0);
  });

  test('sem canal nenhum devolve -1 em vez de fingir um indice', () => {
    expect(stepIndex(0, 1, 0)).toBe(-1);
  });
});
