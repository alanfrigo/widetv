import type { FastifyInstance } from 'fastify';

import type { SaveProgressRequest, WatchProgress } from '@shared/api-types';

import type { WatchHistoryEntry, WatchHistoryRow } from '../library/index-store';

import { listResume, RESUME_LIMIT, type ResumeSource } from './resume';

/**
 * Historico de onde o usuario parou.
 *
 * Fica no SERVIDOR, nao no localStorage, porque o mesmo acervo e assistido da
 * TV, do notebook e (depois) do app Android - o sofa nao pode depender do
 * navegador em que a maratona comecou.
 */

/** Fonte estreita: so o que as rotas precisam do Store. */
export interface HistorySource extends ResumeSource {
  getWatchHistory(episodeId: string): WatchHistoryRow | null;
  upsertWatchHistory(row: WatchHistoryRow): void;
  deleteWatchHistory(episodeId: string): void;
  listWatchHistory(limit: number): WatchHistoryEntry[];
}

export interface HistoryRoutesDeps {
  source: HistorySource;
  /** Injetado para os testes poderem controlar o tempo. */
  now: () => number;
}

const LIST_LIMIT = 100;

/**
 * Fracao a partir da qual o episodio conta como assistido e o progresso e
 * APAGADO: retomar dentro dos creditos finais nao ajuda ninguem, e a proxima
 * abertura deve comecar do zero. 95% de um episodio de 22 min deixa ~66 s de
 * margem - o tamanho tipico dos creditos.
 */
const FINISHED_RATIO = 0.95;

function toProgress(entry: WatchHistoryEntry): WatchProgress {
  return {
    episodeId: entry.episodeId,
    channelNumber: entry.channelNumber,
    positionMs: entry.positionMs,
    durationMs: entry.durationMs,
    updatedAt: entry.updatedAt,
  };
}

/** Numero finito e nao-negativo; o resto e corpo torto. */
function validMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function registerHistoryRoutes(app: FastifyInstance, deps: HistoryRoutesDeps): void {
  app.get('/api/history', async (_request, reply) => {
    // Progresso muda a cada segundo assistido; cache aqui congelaria a retomada.
    reply.header('cache-control', 'no-store');
    return deps.source.listWatchHistory(LIST_LIMIT).map(toProgress);
  });

  app.get('/api/history/resume', async (_request, reply) => {
    // Mesmo motivo do historico cru: a posicao muda a cada segundo assistido, e
    // uma faixa cacheada mandaria o usuario de volta para onde ele ja passou.
    reply.header('cache-control', 'no-store');
    return listResume(deps.source, RESUME_LIMIT);
  });

  // POST alem de PUT porque `navigator.sendBeacon` - o unico jeito confiavel de
  // gravar na saida da pagina - so fala POST.
  app.route({
    method: ['PUT', 'POST'],
    url: '/api/history/:id',
    handler: async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as Partial<SaveProgressRequest> | null;

      if (body === null || !validMs(body.positionMs) || !validMs(body.durationMs) || body.durationMs === 0) {
        return reply.code(400).send({ error: 'positionMs e durationMs precisam ser numeros validos' });
      }

      // Episodio fora do indice: 404 em vez de gravar lixo. Acontece de verdade
      // num rescan que removeu o arquivo com alguem assistindo.
      if (deps.source.getEpisode(id) === null) {
        return reply.code(404).send({ error: 'episodio desconhecido' });
      }

      if (body.positionMs >= body.durationMs * FINISHED_RATIO) {
        deps.source.deleteWatchHistory(id);
      } else {
        deps.source.upsertWatchHistory({
          episodeId: id,
          positionMs: Math.round(body.positionMs),
          durationMs: Math.round(body.durationMs),
          updatedAt: deps.now(),
        });
      }
      return reply.code(204).send();
    },
  });
}
