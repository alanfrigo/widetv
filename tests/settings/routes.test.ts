import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { openStore, type Store } from '../../src/server/library/index-store';
import { registerSettingsRoutes } from '../../src/server/settings/routes';
import { createSettingsService, type SettingsService } from '../../src/server/settings/store';
import type { AppSettings } from '../../src/shared/api-types';

let app: FastifyInstance;
let store: Store;
let settings: SettingsService;

beforeEach(async () => {
  // Servico de verdade sobre um indice em memoria: a rota so vale se o que ela
  // aceita for exatamente o que o servico grava.
  store = openStore(':memory:');
  settings = createSettingsService(store, {
    rescanTime: { hour: 4, minute: 0 },
    autoRemux: true,
    remuxCacheMaxBytes: 20 * 1024 ** 3,
    autoThumbs: true,
    smartGrouping: true,
    tmdbConfigured: true,
  });

  app = Fastify();
  registerSettingsRoutes(app, { settings });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  store.close();
});

describe('GET /api/settings', () => {
  test('devolve os efetivos sem cache', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(r.statusCode).toBe(200);
    // Cache aqui mostraria na TV a escolha feita no tablet ha um minuto.
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.json<AppSettings>()).toEqual({
      audioLang: null,
      subtitleLang: null,
      subtitlesAuto: false,
      rescanTime: '04:00',
      autoRemux: true,
      remuxCacheMaxBytes: 20 * 1024 ** 3,
      autoThumbs: true,
      smartGrouping: true,
      tmdbConfigured: true,
    });
  });
});

describe('PATCH /api/settings', () => {
  test('aplica e devolve o objeto efetivo inteiro', async () => {
    const r = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { audioLang: 'pt-BR', subtitlesAuto: true },
    });

    expect(r.statusCode).toBe(200);
    expect(r.json<AppSettings>()).toMatchObject({
      audioLang: 'por',
      subtitlesAuto: true,
      // Campo ausente no corpo continua como estava.
      autoRemux: true,
      rescanTime: '04:00',
    });
    expect(store.getSetting('audio_lang')).toBe('por');
  });

  test('desligar legenda passa pelo corpo como null', async () => {
    const r = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { subtitleLang: null },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json<AppSettings>().subtitleLang).toBeNull();
    expect(store.getSetting('subtitle_lang')).toBe('off');
  });

  test('tipo errado devolve 400 e nao grava nada', async () => {
    for (const payload of [
      { audioLang: 42 },
      { subtitleLang: [] },
      { subtitlesAuto: 'sim' },
      { autoRemux: 1 },
      { autoThumbs: 'sim' },
      { smartGrouping: null },
      { rescanTime: 4 },
    ]) {
      const r = await app.inject({ method: 'PATCH', url: '/api/settings', payload });
      expect(r.statusCode).toBe(400);
      expect(r.json<{ error: string }>().error).toBeTruthy();
    }
    expect(store.listSettings()).toEqual({});
  });

  test('rescanTime torto devolve 400 em vez de derrubar o servidor no ar', async () => {
    for (const valor of ['25:00', '4h', 'madrugada']) {
      const r = await app.inject({
        method: 'PATCH',
        url: '/api/settings',
        payload: { rescanTime: valor },
      });
      expect(r.statusCode).toBe(400);
    }
    expect(store.getSetting('rescan_time')).toBeNull();
  });

  test('corpo nao-objeto devolve 400', async () => {
    for (const payload of ['"texto"', '[1,2]', 'null', '3']) {
      const r = await app.inject({
        method: 'PATCH',
        url: '/api/settings',
        headers: { 'content-type': 'application/json' },
        payload,
      });
      expect(r.statusCode).toBe(400);
    }
  });

  test('tmdbConfigured no corpo e ignorado, nao recusado', async () => {
    // O cliente mais simples devolve o objeto que acabou de receber no GET.
    const r = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { tmdbConfigured: false, autoRemux: false },
    });

    expect(r.statusCode).toBe(200);
    expect(r.json<AppSettings>().tmdbConfigured).toBe(true);
    expect(r.json<AppSettings>().autoRemux).toBe(false);
  });

  test('nao existe POST nem PUT: eles apagariam a escolha do outro aparelho', async () => {
    for (const method of ['POST', 'PUT'] as const) {
      const r = await app.inject({ method, url: '/api/settings', payload: { autoRemux: false } });
      expect(r.statusCode).toBe(404);
    }
  });
});
