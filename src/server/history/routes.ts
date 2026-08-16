import type { FastifyInstance } from 'fastify';

import type { SaveProgressRequest, WatchProgress } from '@shared/api-types';

import type { WatchHistoryEntry, WatchHistoryRow } from '../library/index-store';

import { decideProgress } from './progress';
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
  clearWatchHistory(): void;
  listWatchHistory(limit: number): WatchHistoryEntry[];
}

export interface HistoryRoutesDeps {
  source: HistorySource;
  /** Injetado para os testes poderem controlar o tempo. */
  now: () => number;
}

const LIST_LIMIT = 100;

function toProgress(entry: WatchHistoryEntry): WatchProgress {
  return {
    episodeId: entry.episodeId,
    channelNumber: entry.channelNumber,
    positionMs: entry.positionMs,
    durationMs: entry.durationMs,
    updatedAt: entry.updatedAt,
    watchedAt: entry.watchedAt,
  };
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

      // Episodio fora do indice: 404 em vez de gravar lixo. Acontece de verdade
      // num rescan que removeu o arquivo com alguem assistindo. A checagem vem
      // ANTES da decisao porque a marcacao manual le a duracao daqui.
      const episode = deps.source.getEpisode(id);
      if (episode === null) {
        return reply.code(404).send({ error: 'episodio desconhecido' });
      }

      const decision = decideProgress({
        episodeId: id,
        body,
        episodeDurationMs: episode.durationMs,
        nowMs: deps.now(),
      });

      switch (decision.kind) {
        case 'invalid':
          return reply.code(400).send({ error: decision.reason });
        case 'forget':
          deps.source.deleteWatchHistory(id);
          break;
        case 'save':
          deps.source.upsertWatchHistory(decision.row);
          break;
      }
      return reply.code(204).send();
    },
  });

  app.delete('/api/history/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    // Sem 404 no episodio desconhecido: apagar o que ja nao existe entregou o
    // resultado pedido. Um erro aqui obrigaria o cliente a tratar um caso em que
    // nao ha nada de errado.
    deps.source.deleteWatchHistory(id);
    return reply.code(204).send();
  });

  app.delete('/api/history', async (_request, reply) => {
    deps.source.clearWatchHistory();
    return reply.code(204).send();
  });
}
