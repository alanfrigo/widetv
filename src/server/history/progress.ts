import type { SaveProgressRequest } from '@shared/api-types';

import type { WatchHistoryRow } from '../library/index-store';

/**
 * O que fazer com uma gravacao de progresso.
 *
 * Funcao pura, separada da rota, porque a regra aqui e a mais facil de errar do
 * app inteiro: o mesmo corpo pode significar "guarde onde eu parei", "eu vi este
 * episodio" ou "esqueca que eu vi", e cada um deixa o banco num estado
 * diferente. Com a decisao numa funcao so, a rota vira transporte e a regra vira
 * tabela de teste.
 */

/**
 * Fracao a partir da qual o episodio conta como VISTO.
 *
 * Retomar dentro dos creditos finais nao ajuda ninguem: a proxima abertura deve
 * comecar do zero. 95% de um episodio de 22 min deixa ~66 s de margem - o
 * tamanho tipico dos creditos.
 *
 * Ate a versao 11 do indice, cruzar esta linha APAGAVA o progresso. Passou a
 * marcar porque apagar tornava "nunca abri" e "vi ate o fim" indistinguiveis, e
 * a lista de episodios da serie nao tinha como dizer o que ja passou.
 */
export const FINISHED_RATIO = 0.95;

/** Numero finito e nao-negativo; o resto e corpo torto. */
export function validMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export type ProgressDecision =
  /** Grava (ou regrava) a linha exatamente como esta aqui. */
  | { kind: 'save'; row: WatchHistoryRow }
  /** Apaga a linha. E o que "nunca vi isto" significa. */
  | { kind: 'forget' }
  /** Corpo que nao da para interpretar; vira 400. */
  | { kind: 'invalid'; reason: string };

export interface ProgressInput {
  episodeId: string;
  body: Partial<SaveProgressRequest> | null;
  /** Duracao conhecida do episodio no indice; usada quando o corpo nao a traz. */
  episodeDurationMs: number;
  nowMs: number;
}

/**
 * Traduz o corpo do PUT numa decisao.
 *
 * As duas formas do corpo sao exclusivas de proposito. `{watched}` vem de um
 * botao ("ja vi este") e nao carrega posicao nenhuma; `{positionMs, durationMs}`
 * vem do player, que nao tem opiniao sobre "visto" - so sobre onde o video esta.
 * Aceitar as duas juntas obrigaria a inventar qual delas ganha.
 */
export function decideProgress(input: ProgressInput): ProgressDecision {
  const { episodeId, body, episodeDurationMs, nowMs } = input;
  if (body === null || typeof body !== 'object') {
    return { kind: 'invalid', reason: 'corpo ausente' };
  }

  if (body.watched !== undefined) {
    if (typeof body.watched !== 'boolean') {
      return { kind: 'invalid', reason: 'watched precisa ser booleano' };
    }
    // Desmarcar apaga a linha inteira: manter uma linha com posicao zero e
    // `watched_at` nulo diria "comecei e parei no segundo zero", que e outra
    // coisa - e sujaria a faixa de continuar assistindo com episodios intocados.
    if (!body.watched) return { kind: 'forget' };

    // Marcar na mao zera a posicao: quem diz "ja vi" nao quer que a proxima
    // abertura caia no meio. A duracao vem do indice porque o botao pode estar
    // na lista de episodios, longe de qualquer player.
    return {
      kind: 'save',
      row: {
        episodeId,
        positionMs: 0,
        durationMs: episodeDurationMs,
        updatedAt: nowMs,
        watchedAt: nowMs,
      },
    };
  }

  if (!validMs(body.positionMs) || !validMs(body.durationMs) || body.durationMs === 0) {
    return { kind: 'invalid', reason: 'positionMs e durationMs precisam ser numeros validos' };
  }

  const finished = body.positionMs >= body.durationMs * FINISHED_RATIO;
  return {
    kind: 'save',
    row: {
      episodeId,
      // Terminou: a posicao volta a zero para a proxima abertura comecar do
      // comeco, e a marca de visto guarda o que aconteceu.
      positionMs: finished ? 0 : Math.round(body.positionMs),
      durationMs: Math.round(body.durationMs),
      updatedAt: nowMs,
      // Rever DESMARCA. Quem voltou ao meio do episodio esta assistindo de
      // novo, e a faixa de continuar assistindo tem que oferece-lo outra vez.
      watchedAt: finished ? nowMs : null,
    },
  };
}
