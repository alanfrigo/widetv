import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { registerStreamRoutes, type StreamSource } from '../../src/server/stream/direct';

const BODY = Buffer.from('0123456789'.repeat(100)); // 1000 bytes
const REMUXED = Buffer.from('mp4-remuxado');

/**
 * Nome de release de cena real: passa de 100 chars sozinho. O servidor precisa
 * de maxParamLength maior que o default do Fastify (100), senao todo id longo
 * vira 414 antes de chegar na rota.
 */
const NOME_LONGO =
  'The.Simpsons.S37E01.Thrifty.Ways.to.Thieve.Your.Mother.1080p.DSNP.WEB-DL.DDP5.1.H.264.DUAL-SiGLA.mkv';

let dir: string;
let app: FastifyInstance;

let fora: string;
let remuxado: string;

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), 'widetv-stream-'));
  dir = join(base, 'acervo');
  await mkdir(join(dir, 'Serie'), { recursive: true });
  await writeFile(join(dir, 'Serie', 'ep 01 (piloto).mp4'), BODY);
  await writeFile(join(dir, 'Serie', 'ep 02.mkv'), BODY);
  await writeFile(join(dir, 'Serie', NOME_LONGO), BODY);

  // Fora da raiz de proposito: prova que a checagem de contencao nao le daqui.
  fora = join(base, 'segredo.mp4');
  await writeFile(fora, 'nao deveria sair daqui');

  // Copia remuxada vive FORA da biblioteca, no DATA_DIR - como em producao.
  await mkdir(join(base, 'data', 'remux'), { recursive: true });
  remuxado = join(base, 'data', 'remux', 'abc123.mp4');
  await writeFile(remuxado, REMUXED);

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
              : id === 'remux'
                ? { relativePath: 'Serie/ep 02.mkv', remuxPath: remuxado }
                : id === 'remux-sumiu'
                  ? {
                      relativePath: 'Serie/ep 02.mkv',
                      remuxPath: join(base, 'data', 'remux', 'nao-existe.mp4'),
                    }
                  : id === `Serie/${NOME_LONGO}`
                    ? { relativePath: `Serie/${NOME_LONGO}` }
                    : null,
  };

  // Mesmo maxParamLength do servidor real: o id de episodio e um caminho
  // inteiro e o default de 100 chars nao aguenta nome de release.
  app = Fastify({ maxParamLength: 2048 });
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

describe('id com nome de release de cena (mais de 100 chars)', () => {
  test('nao vira 414: o id de episodio e um caminho inteiro', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/api/stream/${encodeURIComponent(`Serie/${NOME_LONGO}`)}`,
    });
    expect(r.statusCode).toBe(200);
    expect(r.rawPayload.equals(BODY)).toBe(true);
  });
});

describe('copia remuxada', () => {
  test('quando existe, e ela que sai - com content-type de mp4, nao do mkv fonte', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/stream/remux' });
    expect(r.statusCode).toBe(200);
    expect(r.rawPayload.equals(REMUXED)).toBe(true);
    expect(r.headers['content-type']).toBe('video/mp4');
  });

  test('Range funciona sobre a copia, nao sobre o original', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/stream/remux',
      headers: { range: 'bytes=0-3' },
    });
    expect(r.statusCode).toBe(206);
    expect(r.rawPayload.equals(REMUXED.subarray(0, 4))).toBe(true);
    expect(r.headers['content-range']).toBe(`bytes 0-3/${REMUXED.length}`);
  });

  test('copia apagada do disco cai no original em vez de 404', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/stream/remux-sumiu' });
    expect(r.statusCode).toBe(200);
    expect(r.rawPayload.equals(BODY)).toBe(true);
    expect(r.headers['content-type']).toBe('video/x-matroska');
  });
});

describe('remuxPending: original com dolby tocaria mudo, melhor preparar', () => {
  let pendente: FastifyInstance;
  const avisados: string[] = [];

  beforeAll(async () => {
    pendente = Fastify({ maxParamLength: 2048 });
    registerStreamRoutes(
      pendente,
      {
        getEpisode: (id) =>
          id === 'mudo'
            ? { relativePath: 'Serie/ep 02.mkv', remuxPending: true }
            : id === 'pronto'
              ? { relativePath: 'Serie/ep 02.mkv', remuxPath: remuxado, remuxPending: false }
              : id === 'copia-sumiu'
                ? {
                    relativePath: 'Serie/ep 02.mkv',
                    remuxPath: join(dir, '..', 'data', 'remux', 'nao-existe.mp4'),
                    remuxPending: true,
                  }
                : null,
      },
      dir,
      undefined,
      (episodeId) => avisados.push(episodeId),
    );
    await pendente.ready();
  });

  afterAll(async () => {
    await pendente.close();
  });

  test('devolve 202 preparando em vez do MKV mudo, e avisa a fila de prioridade', async () => {
    const r = await pendente.inject({ method: 'GET', url: '/api/stream/mudo' });
    expect(r.statusCode).toBe(202);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(r.body)).toEqual({ preparing: true });
    expect(avisados).toContain('mudo');
  });

  test('HEAD tambem responde 202: e o probe que o cliente usa', async () => {
    const r = await pendente.inject({ method: 'HEAD', url: '/api/stream/mudo' });
    expect(r.statusCode).toBe(202);
  });

  test('com remux pronto a flag nao interfere: sai o MP4', async () => {
    const r = await pendente.inject({ method: 'GET', url: '/api/stream/pronto' });
    expect(r.statusCode).toBe(200);
    expect(r.rawPayload.equals(REMUXED)).toBe(true);
  });

  test('copia sumida com pendencia vira 202, nunca o original mudo', async () => {
    const r = await pendente.inject({ method: 'GET', url: '/api/stream/copia-sumiu' });
    expect(r.statusCode).toBe(202);
  });
});

describe('?audio=N (troca de dublagem)', () => {
  let comAudio: FastifyInstance;

  beforeAll(async () => {
    comAudio = Fastify({ maxParamLength: 2048 });
    registerStreamRoutes(
      comAudio,
      { getEpisode: (id) => (id === 'ep' ? { relativePath: 'Serie/ep 02.mkv' } : null) },
      dir,
      async (_id, audioIndex) => {
        if (audioIndex === 0) return { status: 'default' };
        if (audioIndex === 1) return { status: 'ready', path: remuxado };
        if (audioIndex === 2) return { status: 'preparing' };
        return { status: 'invalid' };
      },
    );
    await comAudio.ready();
  });

  afterAll(async () => {
    await comAudio.close();
  });

  test('faixa default segue o fluxo normal', async () => {
    const r = await comAudio.inject({ method: 'GET', url: '/api/stream/ep?audio=0' });
    expect(r.statusCode).toBe(200);
    expect(r.rawPayload.equals(BODY)).toBe(true);
  });

  test('variante pronta e servida com Range', async () => {
    const r = await comAudio.inject({
      method: 'GET',
      url: '/api/stream/ep?audio=1',
      headers: { range: 'bytes=0-3' },
    });
    expect(r.statusCode).toBe(206);
    expect(r.rawPayload.equals(REMUXED.subarray(0, 4))).toBe(true);
  });

  test('variante em geracao devolve 202 sem cache: o cliente consulta de novo', async () => {
    const r = await comAudio.inject({ method: 'GET', url: '/api/stream/ep?audio=2' });
    expect(r.statusCode).toBe(202);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(r.body)).toEqual({ preparing: true });
  });

  test('faixa inexistente e query torta devolvem 400', async () => {
    expect((await comAudio.inject({ method: 'GET', url: '/api/stream/ep?audio=9' })).statusCode).toBe(400);
    expect((await comAudio.inject({ method: 'GET', url: '/api/stream/ep?audio=abc' })).statusCode).toBe(400);
  });

  test('HEAD com variante pronta responde os cabecalhos dela', async () => {
    const r = await comAudio.inject({ method: 'HEAD', url: '/api/stream/ep?audio=1' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-length']).toBe(String(REMUXED.length));
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
