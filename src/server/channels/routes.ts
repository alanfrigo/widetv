import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type { FastifyInstance } from 'fastify';

import { hasShowsWithoutMetadata, postersDir } from '../metadata/service';
import { type ChannelSource, listChannelEpisodes, listChannels, resolveNowPlaying } from './service';

export interface ChannelRoutesDeps {
  source: ChannelSource;
  /** Instante zero global da grade. */
  epochMs: number;
  /** Injetado para os testes poderem controlar o tempo. */
  now: () => number;
  /** DATA_DIR do servidor; as capas vivem em `<dataDir>/posters`. */
  dataDir: string;
  /**
   * Chamado quando a listagem encontra serie sem metadata. E fire-and-forget de
   * proposito: a resposta NUNCA espera a rede. Sem isto, um acervo recem
   * indexado ficaria sem capa ate o proximo scan.
   */
  onMetadataMissing?: () => void;
}

export function registerChannelRoutes(app: FastifyInstance, deps: ChannelRoutesDeps): void {
  const posters = postersDir(deps.dataDir);

  app.get('/api/channels', async () => {
    const channels = listChannels(deps.source);
    if (deps.onMetadataMissing !== undefined && hasShowsWithoutMetadata(deps.source)) {
      deps.onMetadataMissing();
    }
    return channels;
  });

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

  app.get('/api/channels/:number/poster', async (request, reply) => {
    const { number } = request.params as { number: string };
    if (!/^\d+$/.test(number)) {
      return reply.code(400).send({ error: 'numero de canal invalido' });
    }

    const show = deps.source.getShowByChannel(Number(number));
    if (show === null) {
      return reply.code(404).send({ error: 'canal inexistente' });
    }

    const metadata = deps.source.getShowMetadata(show.id);
    if (metadata?.posterFile == null) {
      // Sem capa e estado normal (busca ainda nao rodou, ou o provedor nao
      // conhece a serie), nao erro do servidor.
      return reply.code(404).send({ error: 'canal sem capa' });
    }

    // `basename` porque o valor vem do banco e vira caminho: mesmo sendo escrito
    // por nos, um nome torto nao pode virar leitura fora de `posters/`.
    const filePath = join(posters, basename(metadata.posterFile));
    try {
      const info = await stat(filePath);
      if (!info.isFile()) {
        return reply.code(404).send({ error: 'canal sem capa' });
      }
    } catch {
      // Linha no indice e arquivo apagado do volume: 404, e a proxima rodada de
      // enriquecimento nao vai reescrever - quem quiser de volta, apaga a linha.
      return reply.code(404).send({ error: 'canal sem capa' });
    }

    reply.header('content-type', 'image/jpeg');
    // A capa de um canal so muda quando alguem apaga o indice; um dia de cache
    // no cliente poupa uma imagem por canal em cada abertura da grade.
    reply.header('cache-control', 'private, max-age=86400');
    return reply.send(createReadStream(filePath));
  });
}
