import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { registerStreamRoutes, type StreamSource } from '../../src/server/stream/direct';

const BODY = Buffer.from('0123456789'.repeat(100)); // 1000 bytes
let dir: string;
let app: FastifyInstance;

let fora: string;

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), 'retro-tv-stream-'));
  dir = join(base, 'acervo');
  await mkdir(join(dir, 'Serie'), { recursive: true });
  await writeFile(join(dir, 'Serie', 'ep 01 (piloto).mp4'), BODY);

  // Fora da raiz de proposito: prova que a checagem de contencao nao le daqui.
  fora = join(base, 'segredo.mp4');
  await writeFile(fora, 'nao deveria sair daqui');

  const source: StreamSource = {
    getEpisode: (id) =>
      id === 'ok'
        ? { relativePath: 'Serie/ep 01 (piloto).mp4' }
        : id === 'sumiu'
          ? { relativePath: 'Serie/nao-existe.mp4' }
          : id === 'fuga'
            ? { relativePath: '../segredo.mp4' }
            : id === 'absoluto'
              ? { relativePath: fora }
              : null,
  };

  app = Fastify();
  registerStreamRoutes(app, source, dir);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await rm(join(dir, '..'), { recursive: true, force: true });
});

describe('GET /api/stream/:id sem Range', () => {
  test('serve o arquivo inteiro', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/stream/ok' });
    expect(r.statusCode).toBe(200);
    expect(r.rawPayload.length).toBe(BODY.length);
    expect(r.rawPayload.equals(BODY)).toBe(true);
  });

  test('anuncia suporte a Range, senao o browser nem tenta buscar', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/stream/ok' });
    expect(r.headers['accept-ranges']).toBe('bytes');
    expect(r.headers['content-length']).toBe(String(BODY.length));
  });

  test('declara content-type de video pela extensao', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/stream/ok' });
    expect(r.headers['content-type']).toBe('video/mp4');
  });
});

describe('GET /api/stream/:id com Range', () => {
  test('faixa fechada devolve 206 com exatamente aqueles bytes', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/stream/ok',
      headers: { range: 'bytes=10-19' },
    });
    expect(r.statusCode).toBe(206);
    expect(r.rawPayload.equals(BODY.subarray(10, 20))).toBe(true);
    expect(r.headers['content-range']).toBe(`bytes 10-19/${BODY.length}`);
    expect(r.headers['content-length']).toBe('10');
  });

  test('faixa aberta vai do offset ate o fim: e assim que o player sintoniza no meio', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/stream/ok',
      headers: { range: 'bytes=990-' },
    });
    expect(r.statusCode).toBe(206);
    expect(r.rawPayload.equals(BODY.subarray(990))).toBe(true);
  });

  test('faixa insatisfazivel devolve 416 com o tamanho real', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/stream/ok',
      headers: { range: 'bytes=5000-' },
    });
    expect(r.statusCode).toBe(416);
    expect(r.headers['content-range']).toBe(`bytes */${BODY.length}`);
  });

  test('Range malformado e ignorado e vira resposta 200 inteira', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/stream/ok',
      headers: { range: 'bytes=abc' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.rawPayload.length).toBe(BODY.length);
  });
});

describe('erros', () => {
  test('episodio desconhecido devolve 404', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/stream/inexistente' });
    expect(r.statusCode).toBe(404);
  });

  test('registro no banco apontando para arquivo sumido devolve 404, nao 500', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/stream/sumiu' });
    expect(r.statusCode).toBe(404);
  });

  test('HEAD devolve os cabecalhos sem corpo', async () => {
    const r = await app.inject({ method: 'HEAD', url: '/api/stream/ok' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-length']).toBe(String(BODY.length));
    expect(r.rawPayload.length).toBe(0);
  });
});

describe('resolucao do caminho', () => {
  test('resolve a partir da raiz da biblioteca, nao de um caminho gravado', async () => {
    // O indice guarda o caminho RELATIVO justamente para o mesmo banco servir no
    // host e dentro do container, onde a biblioteca fica noutro ponto de
    // montagem. Amarrar no absoluto faz todo episodio virar 404 silencioso.
    const r = await app.inject({ method: 'GET', url: '/api/stream/ok' });
    expect(r.statusCode).toBe(200);
    expect(r.rawPayload.equals(BODY)).toBe(true);
  });

  test('caminho que escapa da raiz devolve 404 e nao le o arquivo de fora', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/stream/fuga' });
    expect(r.statusCode).toBe(404);
    expect(r.body).not.toContain('nao deveria sair daqui');
  });

  test('caminho absoluto apontando para fora tambem e recusado', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/stream/absoluto' });
    expect(r.statusCode).toBe(404);
    expect(r.body).not.toContain('nao deveria sair daqui');
  });
});
