import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { API } from '../../src/shared/api-types';
import {
  registerThumbRoutes,
  type ThumbEpisode,
} from '../../src/server/stream/thumb';

/**
 * A rota so LE o que a fila ja escreveu. O que ela protege: nao ter quadro e
 * estado normal (404, para a tela cair no listrado), nunca 500 - e o nome do
 * arquivo, que vem do banco, nao pode virar leitura fora de `thumbs/`.
 */

const ID = 'The Simpsons/Season 01/s01e01.mkv';

let base: string;
let app: FastifyInstance;
let episodes: Map<string, ThumbEpisode>;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'widetv-thumb-rota-'));
  episodes = new Map();

  app = Fastify({ maxParamLength: 2048 });
  registerThumbRoutes(app, {
    source: { getEpisode: (id) => episodes.get(id) ?? null },
    dataDir: base,
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await rm(base, { recursive: true, force: true });
});

/** URL que o cliente monta: o id inteiro vira UM segmento. */
function url(id: string): string {
  return API.thumb(id);
}

describe('GET /api/stream/:id/thumb', () => {
  test('404 antes de o quadro existir, 200 com o JPEG depois', async () => {
    episodes.set(ID, { thumbFile: null });

    const antes = await app.inject({ url: url(ID) });
    expect(antes.statusCode).toBe(404);

    // A fila rodou: arquivo em disco e nome na coluna.
    await mkdir(join(base, 'thumbs'), { recursive: true });
    await writeFile(join(base, 'thumbs', '42.jpg'), 'jpeg!');
    episodes.set(ID, { thumbFile: '42.jpg' });

    const depois = await app.inject({ url: url(ID) });
    expect(depois.statusCode).toBe(200);
    expect(depois.headers['content-type']).toBe('image/jpeg');
    expect(depois.body).toBe('jpeg!');
  });

  test('um dia de cache, e sempre privado', async () => {
    await mkdir(join(base, 'thumbs'), { recursive: true });
    await writeFile(join(base, 'thumbs', '42.jpg'), 'jpeg!');
    episodes.set(ID, { thumbFile: '42.jpg' });

    const r = await app.inject({ url: url(ID) });
    expect(r.headers['cache-control']).toBe('private, max-age=86400');
  });

  test('episodio desconhecido tambem e 404, nao 500', async () => {
    const r = await app.inject({ url: url('nao/existe.mkv') });
    expect(r.statusCode).toBe(404);
  });

  test('linha com nome de arquivo apagado do volume: 404', async () => {
    episodes.set(ID, { thumbFile: '42.jpg' });
    const r = await app.inject({ url: url(ID) });
    expect(r.statusCode).toBe(404);
  });

  test('nome torto no banco nao le fora do diretorio de quadros', async () => {
    await writeFile(join(base, 'segredo.jpg'), 'nao servir');
    episodes.set(ID, { thumbFile: '../segredo.jpg' });

    const r = await app.inject({ url: url(ID) });
    expect(r.statusCode).toBe(404);
  });
});
