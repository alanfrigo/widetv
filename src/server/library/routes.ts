import type { FastifyInstance } from 'fastify';

import { API, type ScanMode } from '@shared/api-types';

import type { LibraryController } from './scan-controller';

/**
 * Rotas de manutencao da biblioteca: o que a tela de configuracoes dispara e
 * consulta.
 *
 * Nenhuma delas ESPERA a tarefa terminar. Um scan de 14 mil arquivos leva
 * minutos e o request morreria de timeout no proxy muito antes - entao o
 * contrato e 202 ("aceitei, esta rodando") e o cliente acompanha por
 * `GET /api/library/status`.
 *
 * Ficam atras do guard de sessao que ja cobre tudo em `/api/`: quem pode
 * assistir pode reindexar, e nada aqui abre porta nova.
 */

export interface LibraryRoutesDeps {
  controller: LibraryController;
}

function isScanMode(value: unknown): value is ScanMode {
  return value === 'incremental' || value === 'full';
}

export function registerLibraryRoutes(app: FastifyInstance, deps: LibraryRoutesDeps): void {
  app.get(API.libraryStatus, async (_request, reply) => {
    // Progresso muda a cada arquivo medido; cache aqui congelaria a barra na
    // tela e o usuario acharia que o scan travou.
    reply.header('cache-control', 'no-store');
    return deps.controller.status();
  });

  app.post(API.libraryScan, async (request, reply) => {
    const raw = (request.body as { mode?: unknown } | null | undefined)?.mode;
    // Corpo ausente e o caso comum (o botao "atualizar" nao manda nada).
    if (raw !== undefined && !isScanMode(raw)) {
      return reply.code(400).send({ error: 'mode precisa ser "incremental" ou "full"' });
    }

    const result = deps.controller.startScan(raw ?? 'incremental');
    // 409 e nao 500: "ja esta rodando" e uma resposta legitima, e o painel
    // mostra o motivo em vez de uma falha.
    return reply.code(result.started ? 202 : 409).send(result);
  });

  app.post(API.libraryMetadata, async (request, reply) => {
    const raw = (request.body as { reset?: unknown } | null | undefined)?.reset;
    if (raw !== undefined && typeof raw !== 'boolean') {
      return reply.code(400).send({ error: 'reset precisa ser booleano' });
    }

    const result = deps.controller.refreshMetadata(raw ?? false);
    return reply.code(result.started ? 202 : 409).send(result);
  });
}
