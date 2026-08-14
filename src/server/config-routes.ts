import type { FastifyInstance } from 'fastify';
import type { ConfigResponse, DisplayMode } from '@shared/api-types';

/**
 * Expoe aos clientes o que o servidor decidiu por env. Fica atras do guard de
 * sessao de proposito: a tela de senha e igual nos dois modos, e rota publica
 * contaria detalhe do deployment para quem esta so batendo na porta.
 */
export interface ConfigRoutesDeps {
  displayMode: DisplayMode;
}

export function registerConfigRoutes(app: FastifyInstance, deps: ConfigRoutesDeps): void {
  app.get('/api/config', async (_request, reply) => {
    // no-store: um redeploy pode trocar o modo, e GET autenticado sem header
    // de cache e candidato a cache heuristico do browser.
    reply.header('cache-control', 'no-store');
    const body: ConfigResponse = { displayMode: deps.displayMode };
    return body;
  });
}
