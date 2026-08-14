import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, describe, expect, test } from 'vitest';

import { registerConfigRoutes } from '../../src/server/config-routes';
import type { ConfigResponse } from '../../src/shared/api-types';

async function build(displayMode: 'crt' | 'widescreen'): Promise<FastifyInstance> {
  const app = Fastify();
  registerConfigRoutes(app, { displayMode });
  await app.ready();
  return app;
}

describe('GET /api/config', () => {
  let app: FastifyInstance;

  afterAll(async () => {
    await app?.close();
  });

  test('devolve displayMode crt', async () => {
    app = await build('crt');
    const r = await app.inject({ url: '/api/config' });
    expect(r.statusCode).toBe(200);
    expect(r.json<ConfigResponse>()).toEqual({ displayMode: 'crt' });
  });

  test('devolve displayMode widescreen', async () => {
    app = await build('widescreen');
    const r = await app.inject({ url: '/api/config' });
    expect(r.statusCode).toBe(200);
    expect(r.json<ConfigResponse>()).toEqual({ displayMode: 'widescreen' });
  });

  test('resposta nunca e cacheada', async () => {
    app = await build('crt');
    const r = await app.inject({ url: '/api/config' });
    expect(r.headers['cache-control']).toMatch(/no-store/);
  });
});
