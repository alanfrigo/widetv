import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type { FastifyInstance, FastifyReply } from 'fastify';

import type { ShowMetadataRow } from '../library/index-store';
import { backdropsDir, postersDir } from '../metadata/service';
import {
  type ChannelSource,
  listChannelEpisodes,
  listChannels,
  listNowPlaying,
  resolveNowPlaying,
} from './service';
import { createTimelineCache } from './timeline-cache';

export interface ChannelRoutesDeps {
  source: ChannelSource;
  /** Instante zero global da grade. */
  epochMs: number;
  /** Injetado para os testes poderem controlar o tempo. */
  now: () => number;
  /** DATA_DIR do servidor; as artes vivem em `<dataDir>/posters` e `<dataDir>/backdrops`. */
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
  const backdrops = backdropsDir(deps.dataDir);
  // Uma instancia so, compartilhada pelas duas rotas de "no ar": se cada uma
  // tivesse a sua, a faixa do catalogo e o player poderiam sincronizar contra
  // grades diferentes no instante seguinte a um rescan.
  const grid = createTimelineCache(deps.source);

  app.get('/api/channels', async () => {
    const channels = listChannels(deps.source);
    if (deps.onMetadataMissing !== undefined && deps.source.hasShowsWithoutMetadata()) {
      deps.onMetadataMissing();
    }
    return channels;
  });

  // Fora de `/api/channels/` de proposito: e o estado de TODOS os canais num
  // instante, e nao um sub-recurso de um canal. Um `GET` por canal seriam 460
  // requests a cada abertura do catalogo.
  app.get('/api/now', async (_request, reply) => {
    const playing = listNowPlaying(deps.source, deps.epochMs, deps.now(), grid);
    // Mesmo motivo do "no ar" de um canal so: cache aqui entrega uma grade que
    // ja passou.
    reply.header('cache-control', 'no-store');
    return playing;
  });

  app.get('/api/channels/:number/now', async (request, reply) => {
    const { number } = request.params as { number: string };

    if (!/^\d+$/.test(number)) {
      return reply.code(400).send({ error: 'numero de canal invalido' });
    }

    const playing = resolveNowPlaying(deps.source, Number(number), deps.epochMs, deps.now(), grid);
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
    const metadata = artOf(deps, request.params);
    if (metadata.status !== 'ok') return replyForArtError(reply, metadata.status);
    return serveArt(reply, posters, metadata.row?.posterFile ?? null, 'canal sem capa');
  });

  app.get('/api/channels/:number/backdrop', async (request, reply) => {
    const metadata = artOf(deps, request.params);
    if (metadata.status !== 'ok') return replyForArtError(reply, metadata.status);
    return serveArt(reply, backdrops, metadata.row?.backdropFile ?? null, 'canal sem arte');
  });
}

type ArtLookup =
  | { status: 'ok'; row: ShowMetadataRow | null }
  | { status: 'invalid-number' }
  | { status: 'unknown-channel' };

/** Resolve `:number` ate a linha de metadata do canal. */
function artOf(deps: ChannelRoutesDeps, params: unknown): ArtLookup {
  const { number } = params as { number: string };
  if (!/^\d+$/.test(number)) return { status: 'invalid-number' };

  const show = deps.source.getShowByChannel(Number(number));
  if (show === null) return { status: 'unknown-channel' };

  return { status: 'ok', row: deps.source.getShowMetadata(show.id) };
}

function replyForArtError(
  reply: FastifyReply,
  status: 'invalid-number' | 'unknown-channel',
): FastifyReply {
  return status === 'invalid-number'
    ? reply.code(400).send({ error: 'numero de canal invalido' })
    : reply.code(404).send({ error: 'canal inexistente' });
}

/**
 * Serve uma arte do canal em JPEG.
 *
 * Capa (2:3) e arte 16:9 tem exatamente o mesmo desenho, so mudam o diretorio e
 * a mensagem de ausencia - por isso uma funcao so. Nao ter a imagem e estado
 * normal (a busca ainda nao rodou, ou o provedor nao tem), entao e sempre 404,
 * nunca 500.
 */
async function serveArt(
  reply: FastifyReply,
  dir: string,
  fileName: string | null,
  missing: string,
): Promise<FastifyReply> {
  if (fileName === null) {
    return reply.code(404).send({ error: missing });
  }

  // `basename` porque o valor vem do banco e vira caminho: mesmo sendo escrito
  // por nos, um nome torto nao pode virar leitura fora do diretorio de artes.
  const filePath = join(dir, basename(fileName));
  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      return reply.code(404).send({ error: missing });
    }
  } catch {
    // Linha no indice e arquivo apagado do volume: 404, e a proxima rodada de
    // enriquecimento nao vai reescrever - quem quiser de volta, apaga a linha.
    return reply.code(404).send({ error: missing });
  }

  reply.header('content-type', 'image/jpeg');
  // A arte de um canal so muda quando alguem apaga o indice; um dia de cache
  // no cliente poupa uma imagem por canal em cada abertura da grade.
  reply.header('cache-control', 'private, max-age=86400');
  return reply.send(createReadStream(filePath));
}
