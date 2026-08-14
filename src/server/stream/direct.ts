import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';

import { parseRangeHeader } from './range';

/**
 * Entrega do arquivo de video com suporte a Range.
 *
 * Aqui nao ha transcode: o arquivo sai do disco como esta. Isso e deliberado -
 * o TrueNAS alvo nao tem GPU, e transcodificar em software derrubaria o
 * servidor com poucos espectadores.
 */

export interface StreamEpisode {
  /**
   * Caminho relativo a raiz da biblioteca.
   *
   * Deliberadamente relativo: o mesmo indice tem que servir no host e dentro do
   * container, onde a biblioteca esta montada noutro lugar. Guardar o absoluto
   * amarra o banco a um ponto de montagem e faz todo episodio virar 404 mudo
   * quando ele muda.
   */
  relativePath: string;
}

/** Fonte estreita: este modulo nao precisa (nem deve) enxergar o Store inteiro. */
export interface StreamSource {
  getEpisode(id: string): StreamEpisode | null;
}

const CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
};

function contentType(filePath: string): string {
  return CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Cabecalhos comuns as respostas 200 e 206.
 * `Accept-Ranges` nao e opcional: sem ele o Chrome nem tenta pedir faixa, e o
 * player perde a capacidade de sintonizar no meio do episodio.
 */
function baseHeaders(reply: FastifyReply, filePath: string): void {
  reply.header('accept-ranges', 'bytes');
  reply.header('content-type', contentType(filePath));
  // O acervo e imutavel na pratica, mas a grade nao: nao deixe cachear a resposta
  // de forma que atrapalhe uma retomada apos rescan.
  reply.header('cache-control', 'private, max-age=3600');
}

/**
 * Junta a raiz com o caminho relativo e confere que o resultado continua dentro
 * dela. Os ids vem do indice, nao do usuario, mas eles chegam aqui por um
 * parametro de URL: um id torto no banco nao pode virar leitura arbitraria de
 * disco.
 */
export function resolveWithinRoot(root: string, relativePath: string): string | null {
  const base = resolve(root);
  const target = resolve(base, relativePath);
  if (target !== base && !target.startsWith(base + sep)) return null;
  return target;
}

export function registerStreamRoutes(
  app: FastifyInstance,
  source: StreamSource,
  libraryRoot: string,
): void {
  app.route({
    method: ['GET', 'HEAD'],
    url: '/api/stream/:id',
    handler: async (request, reply) => {
      const { id } = request.params as { id: string };

      const episode = source.getEpisode(id);
      if (episode === null) {
        return reply.code(404).send({ error: 'episodio desconhecido' });
      }

      const filePath = resolveWithinRoot(libraryRoot, episode.relativePath);
      if (filePath === null) {
        return reply.code(404).send({ error: 'episodio indisponivel' });
      }

      // Arquivo removido do disco depois do scan e situacao normal num NAS,
      // nao falha de servidor: responde 404 para o cliente pular o canal.
      let size: number;
      try {
        const info = await stat(filePath);
        if (!info.isFile()) {
          return reply.code(404).send({ error: 'episodio indisponivel' });
        }
        size = info.size;
      } catch {
        return reply.code(404).send({ error: 'episodio indisponivel' });
      }

      const range = parseRangeHeader(request.headers.range, size);

      if (range.kind === 'unsatisfiable') {
        reply.header('content-range', `bytes */${size}`);
        return reply.code(416).send();
      }

      baseHeaders(reply, filePath);

      const start = range.kind === 'partial' ? range.start : 0;
      const end = range.kind === 'partial' ? range.end : size - 1;
      const length = end - start + 1;

      reply.header('content-length', String(length));
      if (range.kind === 'partial') {
        reply.header('content-range', `bytes ${start}-${end}/${size}`);
        reply.code(206);
      }

      if (request.method === 'HEAD') {
        return reply.send();
      }

      return reply.send(createReadStream(filePath, { start, end }));
    },
  });
}
