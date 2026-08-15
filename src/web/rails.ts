/**
 * Movimento do foco entre FAIXAS.
 *
 * O catalogo deixou de ser uma grade 2D: agora sao faixas horizontais empilhadas
 * (hero, no ar agora, continuar assistindo, acervo), cada uma com um numero
 * proprio de itens. `nav.ts` continua servindo a lista de canal do zap e a
 * contagem de colunas; quem anda entre faixas e este reducer.
 *
 * Puro de proposito, como o resto: recebe QUANTOS itens cada faixa tem agora e
 * devolve onde o cursor passa a estar. Quais elementos sao esses e assunto de
 * quem desenha - a mesma regra serve para a tela da serie, onde as "faixas" sao
 * a linha de botoes, a barra de temporadas e cada linha de episodio.
 */

export type RailKey = 'left' | 'right' | 'up' | 'down' | 'first' | 'last';

export interface RailCursor {
  /** Indice da faixa na ordem em que ela aparece na tela. */
  rail: number;
  /** Item dentro da faixa. */
  index: number;
}

/** Faixa vazia esta escondida na tela; parar nela seria foco em lugar nenhum. */
function isFilled(lengths: readonly number[], rail: number): boolean {
  return (lengths[rail] ?? 0) > 0;
}

/** Primeira faixa com item; -1 quando a tela inteira esta vazia. */
function firstFilled(lengths: readonly number[]): number {
  for (let rail = 0; rail < lengths.length; rail += 1) {
    if (isFilled(lengths, rail)) return rail;
  }
  return -1;
}

/**
 * Traz o cursor de volta para dentro do que existe AGORA.
 *
 * A busca filtra o acervo e o historico chega depois do catalogo: a faixa em
 * que o cursor estava pode ter encolhido ou sumido entre um desenho e outro.
 */
export function clampRail(cursor: RailCursor, lengths: readonly number[]): RailCursor {
  const empty: RailCursor = { rail: 0, index: 0 };
  if (lengths.length === 0) return empty;

  const wanted = Number.isFinite(cursor.rail) ? Math.trunc(cursor.rail) : 0;
  let rail = Math.min(Math.max(wanted, 0), lengths.length - 1);

  if (!isFilled(lengths, rail)) {
    // Desce procurando faixa com conteudo e, se nao achar, sobe: o cursor cai
    // na faixa mais proxima em vez de sumir da tela.
    let found = -1;
    for (let below = rail + 1; below < lengths.length && found === -1; below += 1) {
      if (isFilled(lengths, below)) found = below;
    }
    for (let above = rail - 1; above >= 0 && found === -1; above -= 1) {
      if (isFilled(lengths, above)) found = above;
    }
    if (found === -1) return empty;
    rail = found;
  }

  const last = (lengths[rail] ?? 1) - 1;
  const index = Number.isFinite(cursor.index) ? Math.trunc(cursor.index) : 0;
  return { rail, index: Math.min(Math.max(index, 0), last) };
}

/** Onde o foco nasce ao abrir a tela: a primeira faixa que tem algo. */
export function firstRailCursor(lengths: readonly number[]): RailCursor {
  const rail = firstFilled(lengths);
  return rail === -1 ? { rail: 0, index: 0 } : { rail, index: 0 };
}

/** Vizinha ocupada na direcao pedida; -1 quando nao ha nenhuma. */
function neighbourRail(lengths: readonly number[], from: number, delta: 1 | -1): number {
  for (let rail = from + delta; rail >= 0 && rail < lengths.length; rail += delta) {
    if (isFilled(lengths, rail)) return rail;
  }
  return -1;
}

/**
 * Novo cursor depois de uma tecla.
 *
 * Regras escolhidas para nao surpreender quem navega de controle remoto:
 * - esquerda e direita andam dentro da faixa e param nas pontas, sem dar a
 *   volta: passar do ultimo card para o primeiro faria a faixa saltar de volta
 *   ao inicio sem o usuario pedir;
 * - cima e baixo trocam de faixa mantendo a COLUNA aproximada - o mesmo indice,
 *   encostado no ultimo item quando a faixa de destino e mais curta. Faixa vazia
 *   (escondida na tela) e pulada;
 * - Home e End vao as pontas da faixa atual, nunca as da tela.
 */
export function moveRail(
  cursor: RailCursor,
  key: RailKey,
  lengths: readonly number[],
): RailCursor {
  const at = clampRail(cursor, lengths);
  const length = lengths[at.rail] ?? 0;
  if (length === 0) return at;

  switch (key) {
    case 'first':
      return { rail: at.rail, index: 0 };
    case 'last':
      return { rail: at.rail, index: length - 1 };
    case 'left':
      return { rail: at.rail, index: Math.max(0, at.index - 1) };
    case 'right':
      return { rail: at.rail, index: Math.min(length - 1, at.index + 1) };
    case 'up':
    case 'down': {
      const rail = neighbourRail(lengths, at.rail, key === 'down' ? 1 : -1);
      if (rail === -1) return at;
      const target = (lengths[rail] ?? 1) - 1;
      return { rail, index: Math.min(at.index, target) };
    }
  }
}
