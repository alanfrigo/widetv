import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type { FastifyInstance } from 'fastify';

import { thumbsDir } from '../library/thumb-job';

/**
 * Quadro 16:9 do episodio, em JPEG.
 *
 * Mesma forma da rota de arte do canal, e pelo mesmo motivo: o nome do arquivo
 * vem do indice, o arquivo vem de DATA_DIR, e nao ter a imagem e estado NORMAL
 * (a fila ainda nao chegou nesse episodio) - entao e sempre 404, nunca 500. A
 * tela cai no padrao listrado, que e um desenho previsto, e nunca em imagem
 * quebrada.
 *
 * O `:id` e o caminho relativo do episodio percent-encodado como UM segmento,
 * exatamente como na rota de legenda: quem monta a URL e `API.thumb`.
 */

/** Fonte estreita: so o que a rota precisa saber do indice. */
export interface ThumbEpisode {
  /** Nome do arquivo em `<DATA_DIR>/thumbs`; null enquanto nao ha quadro. */
  thumbFile: string | null;
}

export interface ThumbSource {
  getEpisode(id: string): ThumbEpisode | null;
}

export interface ThumbRoutesOptions {
  source: ThumbSource;
  /** DATA_DIR do servidor; os quadros vivem em `<dataDir>/thumbs`. */
  dataDir: string;
}

export function registerThumbRoutes(app: FastifyInstance, options: ThumbRoutesOptions): void {
  const dir = thumbsDir(options.dataDir);

  app.get('/api/stream/:id/thumb', async (request, reply) => {
    const { id } = request.params as { id: string };

    const episode = options.source.getEpisode(id);
    if (episode === null || episode.thumbFile === null) {
      return reply.code(404).send({ error: 'episodio sem quadro' });
    }

    // `basename` porque o valor vem do banco e vira caminho: mesmo sendo
    // escrito por nos, um nome torto nao pode virar leitura fora de `thumbs/`.
    const filePath = join(dir, basename(episode.thumbFile));
    try {
      const info = await stat(filePath);
      if (!info.isFile()) {
        return reply.code(404).send({ error: 'episodio sem quadro' });
      }
    } catch {
      // Linha no indice e arquivo apagado do volume: 404. A fila nao vai
      // reescrever sozinha (o carimbo diz que ja tentou); quem quiser de volta
      // usa o botao com `reset`.
      return reply.code(404).send({ error: 'episodio sem quadro' });
    }

    reply.header('content-type', 'image/jpeg');
    // O quadro de um episodio so muda quando alguem pede a rodada com `reset`;
    // um dia de cache poupa uma imagem por episodio em cada abertura da lista,
    // que num canal de 300 episodios e a diferenca entre a tela abrir e a tela
    // carregar.
    reply.header('cache-control', 'private, max-age=86400');
    return reply.send(createReadStream(filePath));
  });
}
