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
  /**
   * Caminho ABSOLUTO da copia MP4 remuxada, quando existe. Tem preferencia
   * sobre o original: e a versao que o navegador toca. Se o arquivo sumiu do
   * disco, a resposta cai no original em vez de 404 - um MKV que talvez nao
   * toque ainda e melhor que um canal morto.
   *
   * Quem monta este caminho e o chamador (a partir do DATA_DIR proprio), nunca
   * um valor vindo de URL: aqui ele e usado como veio.
   */
  remuxPath?: string | null;
  /**
   * true quando servir o ORIGINAL significaria episodio sem som no navegador:
   * a faixa default e dolby/dts e ainda nao ha remux valido (fila pendente,
   * conversao falhada, plano de versao antiga). Com a flag, a rota responde
   * 202 "preparando" em vez de degradar em silencio - e avisa o chamador para
   * furar a fila de conversao. Quem calcula e quem monta o servidor, que
   * enxerga o indice; este modulo so obedece.
   */
  remuxPending?: boolean;
}

/** Fonte estreita: este modulo nao precisa (nem deve) enxergar o Store inteiro. */
export interface StreamSource {
  getEpisode(id: string): StreamEpisode | null;
}

/**
 * Resolucao de `?audio=N` (troca de dublagem), injetada por quem monta o
 * servidor porque envolve o indice e a fila de variantes:
 *
 * - 'default': N e a faixa que ja toca no arquivo servido - segue o fluxo normal;
 * - 'ready': variante pronta em `path` (absoluto, montado pelo chamador);
 * - 'preparing': geracao em andamento - o cliente consulta de novo;
 * - 'invalid': faixa que o episodio nao tem.
 */
export type AudioResolution =
  | { status: 'default' }
  | { status: 'ready'; path: string }
  | { status: 'preparing' }
  | { status: 'invalid' };

export type AudioResolver = (episodeId: string, audioIndex: number) => Promise<AudioResolution>;

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
  audioResolver?: AudioResolver,
  /** Chamado quando um episodio com `remuxPending` foi pedido: hora de priorizar a conversao. */
  onRemuxPending?: (episodeId: string) => void,
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

      // Dublagem escolhida: `?audio=N` troca o arquivo inteiro, nao a faixa -
      // e a unica troca que funciona em todo navegador.
      const { audio } = request.query as { audio?: string };
      let variantPath: string | null = null;
      if (audio !== undefined && audioResolver !== undefined) {
        if (!/^\d+$/.test(audio)) {
          return reply.code(400).send({ error: 'faixa de audio invalida' });
        }
        const resolution = await audioResolver(id, Number(audio));
        if (resolution.status === 'invalid') {
          return reply.code(400).send({ error: 'faixa de audio inexistente' });
        }
        if (resolution.status === 'preparing') {
          // 202 e nao 404: o recurso vai existir, o cliente so precisa esperar.
          // no-store porque um 202 cacheado seria um "preparando" eterno.
          reply.header('cache-control', 'no-store');
          return reply.code(202).send({ preparing: true });
        }
        if (resolution.status === 'ready') variantPath = resolution.path;
        // 'default' cai no fluxo normal: a faixa pedida ja e a que toca.
      }

      const original = resolveWithinRoot(libraryRoot, episode.relativePath);

      // Variante de dublagem > copia remuxada > original: primeiro caminho
      // cujo arquivo existir de verdade e o que sai pelo socket.
      const candidates = [variantPath, episode.remuxPath ?? null, original].filter(
        (candidate): candidate is string => candidate !== null,
      );

      // Arquivo removido do disco depois do scan e situacao normal num NAS,
      // nao falha de servidor: responde 404 para o cliente pular o canal.
      let filePath: string | null = null;
      let size = 0;
      for (const candidate of candidates) {
        try {
          const info = await stat(candidate);
          if (!info.isFile()) continue;
          filePath = candidate;
          size = info.size;
          break;
        } catch {
          continue;
        }
      }
      if (filePath === null) {
        return reply.code(404).send({ error: 'episodio indisponivel' });
      }

      // Sobrou so o original de um episodio que tocaria mudo: mesmo contrato
      // do `?audio=N` em geracao - 202 sem cache, o cliente consulta de novo.
      // Servir o MKV aqui pareceria funcionar (video anda), mas sem som.
      if (episode.remuxPending === true && filePath === original) {
        onRemuxPending?.(id);
        reply.header('cache-control', 'no-store');
        return reply.code(202).send({ preparing: true });
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
