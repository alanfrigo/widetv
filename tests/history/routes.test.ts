import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import type { WatchHistoryEntry, WatchHistoryRow } from '../../src/server/library/index-store';
import { registerHistoryRoutes, type HistorySource } from '../../src/server/history/routes';

const EP = 'Serie/ep 01.mkv';
const EP_URL = `/api/history/${encodeURIComponent(EP)}`;

let rows: Map<string, WatchHistoryRow>;
let app: FastifyInstance;

const source: HistorySource = {
  hasEpisode: (id) => id === EP,
  getWatchHistory: (id) => rows.get(id) ?? null,
  upsertWatchHistory: (row) => {
    rows.set(row.episodeId, row);
  },
  deleteWatchHistory: (id) => {
    rows.delete(id);
  },
  listWatchHistory: (limit) =>
    [...rows.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit)
      .map((row): WatchHistoryEntry => ({ ...row, channelNumber: 7 })),
};

beforeAll(async () => {
  app = Fastify({ maxParamLength: 2048 });
  registerHistoryRoutes(app, { source, now: () => 1234 });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  rows = new Map();
});

describe('PUT /api/history/:id', () => {
  test('grava a posicao com o relogio do servidor', async () => {
    const r = await app.inject({
      method: 'PUT',
      url: EP_URL,
      payload: { positionMs: 600_000, durationMs: 1_320_000 },
    });
    expect(r.statusCode).toBe(204);
    expect(rows.get(EP)).toEqual({
      episodeId: EP,
      positionMs: 600_000,
      durationMs: 1_320_000,
      updatedAt: 1234,
    });
  });

  test('POST faz o mesmo: e o verbo do sendBeacon na saida da pagina', async () => {
    const r = await app.inject({
      method: 'POST',
      url: EP_URL,
      payload: { positionMs: 1000, durationMs: 1_320_000 },
    });
    expect(r.statusCode).toBe(204);
    expect(rows.has(EP)).toBe(true);
  });

  test('posicao dentro dos creditos finais APAGA o progresso', async () => {
    rows.set(EP, { episodeId: EP, positionMs: 1, durationMs: 2, updatedAt: 1 });
    const r = await app.inject({
      method: 'PUT',
      url: EP_URL,
      // 96% de 1.320.000: passou dos 95%.
      payload: { positionMs: 1_267_200, durationMs: 1_320_000 },
    });
    expect(r.statusCode).toBe(204);
    expect(rows.has(EP)).toBe(false);
  });

  test('episodio fora do indice devolve 404 sem gravar', async () => {
    const r = await app.inject({
      method: 'PUT',
      url: '/api/history/outro',
      payload: { positionMs: 1, durationMs: 2 },
    });
    expect(r.statusCode).toBe(404);
    expect(rows.size).toBe(0);
  });

  test('corpo torto devolve 400: NaN, negativo, duracao zero, campo faltando', async () => {
    for (const payload of [
      { positionMs: -1, durationMs: 10 },
      { positionMs: 1, durationMs: 0 },
      { positionMs: 'dez', durationMs: 10 },
      { durationMs: 10 },
      {},
    ]) {
      const r = await app.inject({ method: 'PUT', url: EP_URL, payload });
      expect(r.statusCode).toBe(400);
    }
    expect(rows.size).toBe(0);
  });
});

describe('GET /api/history', () => {
  test('devolve as entradas com canal, sem cache', async () => {
    rows.set(EP, { episodeId: EP, positionMs: 5000, durationMs: 10_000, updatedAt: 9 });
    const r = await app.inject({ method: 'GET', url: '/api/history' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(r.body)).toEqual([
      { episodeId: EP, channelNumber: 7, positionMs: 5000, durationMs: 10_000, updatedAt: 9 },
    ]);
  });
});
