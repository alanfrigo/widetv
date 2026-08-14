import type { FastifyInstance } from 'fastify';

import { type ChannelSource, listChannelEpisodes, listChannels, resolveNowPlaying } from './service';

export interface ChannelRoutesDeps {
  source: ChannelSource;
  /** Instante zero global da grade. */
  epochMs: number;
  /** Injetado para os testes poderem controlar o tempo. */
  now: () => number;
}

export function registerChannelRoutes(app: FastifyInstance, deps: ChannelRoutesDeps): void {
  app.get('/api/channels', async () => listChannels(deps.source));

  app.get('/api/channels/:number/now', async (request, reply) => {
    const { number } = request.params as { number: string };

    if (!/^\d+$/.test(number)) {
      return reply.code(400).send({ error: 'numero de canal invalido' });
    }

    const playing = resolveNowPlaying(deps.source, Number(number), deps.epochMs, deps.now());
    if (playing === null) {
      return reply.code(404).send({ error: 'canal inexistente ou sem episodio' });
    }

    // A grade muda a cada segundo. Qualquer cache aqui congela o canal e faz o
    // cliente sincronizar contra um instante que ja passou.
    reply.header('cache-control', 'no-store');
    return playing;
  });

  app.get('/api/channels/:number/episodes', async (request, reply) => {
    const { number } = request.params as { number: string };
    if (!/^\d+$/.test(number)) {
      return reply.code(400).send({ error: 'numero de canal invalido' });
    }
    const episodes = listChannelEpisodes(deps.source, Number(number));
    if (episodes === null) {
      return reply.code(404).send({ error: 'canal inexistente' });
    }
    // A lista muda em rescan; cache aqui deixaria link morto no menu.
    reply.header('cache-control', 'no-store');
    return episodes;
  });
}
