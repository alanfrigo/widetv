import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { registerLibraryRoutes } from '../../src/server/library/routes';
import type { LibraryController } from '../../src/server/library/scan-controller';
import type { LibraryStatus, ScanMode, TaskAccepted } from '../../src/shared/api-types';

/**
 * As rotas nao decidem nada: elas traduzem o `TaskAccepted` do controlador em
 * 202 ou 409 e validam o corpo. O controlador aqui e de mentira justamente
 * para isso ficar visivel.
 */

const STATUS: LibraryStatus = {
  scan: {
    state: 'idle',
    progress: null,
    startedAt: null,
    last: {
      shows: 2,
      episodes: 10,
      probed: 4,
      cached: 6,
      removedShows: 0,
      removedEpisodes: 0,
      failed: 0,
      durationMs: 1_000,
      finishedAt: Date.parse('2026-01-01T03:00:00Z'),
      error: null,
    },
  },
  metadata: { state: 'idle', last: null },
  remux: { state: 'running' },
};

interface Registro {
  scans: ScanMode[];
  resets: boolean[];
}

let registro: Registro;
/** O que o controlador de mentira devolve no proximo gatilho. */
let resposta: TaskAccepted;
let app: FastifyInstance;

const controller: LibraryController = {
  status: () => STATUS,
  startScan: (mode) => {
    registro.scans.push(mode);
    return resposta;
  },
  refreshMetadata: (reset) => {
    registro.resets.push(reset);
    return resposta;
  },
  triggerRemux: () => undefined,
  bootstrap: () => undefined,
  applySettings: () => undefined,
  stop: () => undefined,
};

beforeAll(async () => {
  app = Fastify();
  registerLibraryRoutes(app, { controller });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  registro = { scans: [], resets: [] };
  resposta = { started: true };
});

describe('GET /api/library/status', () => {
  test('devolve o estado das tarefas de fundo', async () => {
    const r = await app.inject({ url: '/api/library/status' });
    expect(r.statusCode).toBe(200);
    expect(r.json<LibraryStatus>()).toEqual(STATUS);
  });

  test('nunca e cacheada: o painel consulta em polling curto', async () => {
    const r = await app.inject({ url: '/api/library/status' });
    expect(r.headers['cache-control']).toMatch(/no-store/);
  });
});

describe('POST /api/library/scan', () => {
  test('sem corpo, aceita como incremental e devolve 202', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/library/scan' });
    expect(r.statusCode).toBe(202);
    expect(r.json<TaskAccepted>()).toEqual({ started: true });
    expect(registro.scans).toEqual(['incremental']);
  });

  test('mode full chega no controlador', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/library/scan', payload: { mode: 'full' } });
    expect(r.statusCode).toBe(202);
    expect(registro.scans).toEqual(['full']);
  });

  test('scan ja rodando devolve 409 com o motivo', async () => {
    resposta = { started: false, reason: 'scan ja esta em andamento' };
    const r = await app.inject({ method: 'POST', url: '/api/library/scan' });
    expect(r.statusCode).toBe(409);
    expect(r.json<TaskAccepted>()).toEqual({
      started: false,
      reason: 'scan ja esta em andamento',
    });
  });

  test('mode fora do enum devolve 400 e nao dispara nada', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/library/scan',
      payload: { mode: 'completo' },
    });
    expect(r.statusCode).toBe(400);
    expect(registro.scans).toEqual([]);
  });

  test('mode com tipo errado tambem e 400', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/library/scan', payload: { mode: 1 } });
    expect(r.statusCode).toBe(400);
    expect(registro.scans).toEqual([]);
  });
});

describe('POST /api/library/metadata', () => {
  test('sem corpo, dispara sem reset e devolve 202', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/library/metadata' });
    expect(r.statusCode).toBe(202);
    expect(registro.resets).toEqual([false]);
  });

  test('reset true chega no controlador', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/library/metadata',
      payload: { reset: true },
    });
    expect(r.statusCode).toBe(202);
    expect(registro.resets).toEqual([true]);
  });

  test('busca ja rodando devolve 409', async () => {
    resposta = { started: false, reason: 'busca de metadata ja esta em andamento' };
    const r = await app.inject({ method: 'POST', url: '/api/library/metadata' });
    expect(r.statusCode).toBe(409);
    expect(r.json<TaskAccepted>().reason).toMatch(/ja esta em andamento/);
  });

  test('reset com tipo errado devolve 400', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/library/metadata',
      payload: { reset: 'sim' },
    });
    expect(r.statusCode).toBe(400);
    expect(registro.resets).toEqual([]);
  });
});
