/**
 * O que fazer quando um episodio do catalogo termina.
 *
 * Reducer minusculo e puro pelo mesmo motivo de `tuner.ts`: a decisao de emendar
 * ou desistir e a regra que importa, e ela nao precisa de <video> para ser
 * verificada.
 */

export type VodEndDecision =
  /** Emenda no proximo episodio da serie, como uma maratona. */
  | { type: 'next'; index: number }
  /** Serie acabou: devolve o usuario para a grade ao vivo do canal. */
  | { type: 'backToLive' };

export function decideOnEnded(currentIndex: number, episodeCount: number): VodEndDecision {
  // Indice fora da lista significa que o acervo mudou embaixo do player. Voltar
  // para a grade e a saida segura: ela se resolve sozinha com o servidor.
  if (!Number.isInteger(currentIndex) || currentIndex < 0 || currentIndex >= episodeCount) {
    return { type: 'backToLive' };
  }

  const next = currentIndex + 1;
  return next < episodeCount ? { type: 'next', index: next } : { type: 'backToLive' };
}
