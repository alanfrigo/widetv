/**
 * Movimento do foco em grade e em lista.
 *
 * Reducer puro, sem DOM: recebe onde o cursor esta, quantos itens existem e
 * quantas colunas a tela coube AGORA, e devolve onde o cursor passa a estar. O
 * numero de colunas nao e calculado aqui de proposito - quem sabe disso e o
 * layout, e duplicar a conta do CSS em JavaScript daria duas verdades que
 * divergem no primeiro `minmax` que alguem ajustar. O que este modulo oferece e
 * `countColumns`, que le a resposta do proprio layout.
 */

export type NavKey = 'left' | 'right' | 'up' | 'down' | 'first' | 'last';

/**
 * Quantas colunas a grade formou, deduzido da posicao vertical dos itens.
 *
 * Todos os cards da primeira linha compartilham o mesmo `offsetTop`; o primeiro
 * que descer comeca a segunda linha. Tolerancia de 1px porque sub-pixel de
 * layout arredonda diferente entre navegadores.
 *
 * @returns pelo menos 1, sempre: grade de zero coluna travaria a navegacao.
 */
export function countColumns(tops: readonly number[]): number {
  const first = tops[0];
  if (first === undefined) return 1;

  let columns = 0;
  for (const top of tops) {
    if (Math.abs(top - first) > 1) break;
    columns += 1;
  }
  return Math.max(1, columns);
}

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
