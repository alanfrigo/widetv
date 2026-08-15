/**
 * Movimento do foco em lista (e em grade, quando houver uma).
 *
 * Reducer puro, sem DOM: recebe onde o cursor esta, quantos itens existem e
 * quantas colunas a tela tem, e devolve onde o cursor passa a estar. Quem anda
 * entre as FAIXAS do catalogo e da tela da serie e o `rails.ts`; aqui ficam a
 * lista de uma coluna (as configuracoes) e o vizinho circular do zap.
 */

export type NavKey = 'left' | 'right' | 'up' | 'down' | 'first' | 'last';

function clamp(cursor: number, count: number): number {
  if (!Number.isFinite(cursor)) return 0;
  return Math.min(Math.max(Math.trunc(cursor), 0), count - 1);
}

/**
 * Novo indice do cursor.
 *
 * Regras escolhidas para nao surpreender quem navega de controle remoto:
 * - esquerda/direita andam item a item pela lista inteira, atravessando a
 *   quebra de linha, e param nas pontas em vez de dar a volta;
 * - para cima na primeira linha nao faz nada (nao pula para o fim da grade);
 * - para baixo na ultima linha nao faz nada, e de qualquer outra linha cai no
 *   item da coluna correspondente - ou no ultimo item, quando a linha de baixo
 *   esta incompleta. Sem essa correcao, a seta para baixo nao teria efeito
 *   nenhum nas ultimas colunas da penultima linha.
 *
 * @param columns  colunas do layout; 1 transforma a grade numa lista vertical.
 */
export function moveCursor(cursor: number, key: NavKey, count: number, columns: number): number {
  if (count <= 0) return 0;

  const width = Math.max(1, Math.trunc(columns));
  const at = clamp(cursor, count);
  const last = count - 1;

  switch (key) {
    case 'first':
      return 0;
    case 'last':
      return last;
    case 'left':
      return Math.max(0, at - 1);
    case 'right':
      return Math.min(last, at + 1);
    case 'up':
      return at - width < 0 ? at : at - width;
    case 'down': {
      const onLastRow = Math.floor(at / width) === Math.floor(last / width);
      return onLastRow ? at : Math.min(last, at + width);
    }
  }
}

/**
 * Vizinho circular numa lista de canais.
 *
 * Diferente de `moveCursor`: aqui dar a volta e o comportamento certo, porque e
 * o zapear do ao vivo - passar do ultimo canal para o primeiro e o que uma TV
 * sempre fez.
 *
 * @param current  indice atual; fora da lista (serie removida num rescan) cai no primeiro.
 * @returns -1 quando nao ha canal nenhum.
 */
export function stepIndex(current: number, delta: number, count: number): number {
  if (count <= 0) return -1;
  if (!Number.isInteger(current) || current < 0 || current >= count) return 0;
  return (((current + delta) % count) + count) % count;
}
