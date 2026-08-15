import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, test } from 'vitest';

import { registerAuthGuard, registerAuthRoutes } from '../../src/server/auth/routes';
import { hashPassword } from '../../src/server/auth/password';
import { SESSION_COOKIE_NAME, type SessionConfig } from '../../src/server/auth/session';

const SENHA = 'desenho-secreto';
const SESSION: SessionConfig = {
  secret: 'k'.repeat(64),
  secureCookies: 'always',
  ttlMs: 7 * 24 * 60 * 60 * 1000,
};

let app: FastifyInstance;
let agora = Date.parse('2026-01-01T00:00:00Z');
let hash: string;

async function build(): Promise<FastifyInstance> {
  const instance = Fastify();
  await instance.register(cookie);
  registerAuthGuard(instance, { session: SESSION, now: () => agora });
  registerAuthRoutes(instance, { passwordHash: hash, session: SESSION, now: () => agora });
  instance.get('/api/channels', async () => []);
  instance.get('/api/channels/1/poster', async () => 'jpeg');
  await instance.ready();
  return instance;
}

async function loginCookie(): Promise<string> {
  const r = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { password: SENHA },
  });
  const raw = r.headers['set-cookie'];
  const header = Array.isArray(raw) ? raw[0]! : (raw as string);
  return header.split(';')[0]!;
}

beforeEach(async () => {
  hash ??= await hashPassword(SENHA);
  agora = Date.parse('2026-01-01T00:00:00Z');
  app = await build();
});

describe('POST /api/auth/login', () => {
  test('senha correta emite cookie de sessao', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: SENHA },
    });
    expect(r.statusCode).toBe(200);
    expect(String(r.headers['set-cookie'])).toContain(`${SESSION_COOKIE_NAME}=`);
  });

  test('cookie sai com as flags de seguranca', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: SENHA },
    });
    const header = String(r.headers['set-cookie']);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Secure');
  });

  test('senha errada devolve 401 e nenhum cookie', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'errada' },
    });
    expect(r.statusCode).toBe(401);
    expect(r.headers['set-cookie']).toBeUndefined();
  });

  test('corpo sem senha devolve 400, nao 500', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: {} });
    expect(r.statusCode).toBe(400);
  });

  test('a resposta de erro nao diz nada sobre a senha guardada', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'errada' },
    });
    expect(r.body).not.toContain(hash);
    expect(r.body.toLowerCase()).not.toContain('hash');
  });
});

describe('portao de autenticacao', () => {
  test('rota protegida sem cookie devolve 401', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/channels' });
    expect(r.statusCode).toBe(401);
  });

  test('rota protegida com cookie valido passa', async () => {
    const c = await loginCookie();
    const r = await app.inject({ method: 'GET', url: '/api/channels', headers: { cookie: c } });
    expect(r.statusCode).toBe(200);
  });

  test('a capa tambem fica atras do guard', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/channels/1/poster' });
    expect(r.statusCode).toBe(401);
  });

  test('cookie com assinatura adulterada e recusado', async () => {
    const c = await loginCookie();
    const adulterado = `${c.slice(0, -3)}xyz`;
    const r = await app.inject({
      method: 'GET',
      url: '/api/channels',
      headers: { cookie: adulterado },
    });
    expect(r.statusCode).toBe(401);
  });

  test('cookie expirado e recusado', async () => {
    const c = await loginCookie();
    agora += SESSION.ttlMs + 1;
    const r = await app.inject({ method: 'GET', url: '/api/channels', headers: { cookie: c } });
    expect(r.statusCode).toBe(401);
  });

  test('a rota de login nao pode exigir login', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: SENHA },
    });
    expect(r.statusCode).toBe(200);
  });

  test('GET /api/auth/session responde o estado sem exigir cookie valido', async () => {
    expect((await app.inject({ url: '/api/auth/session' })).statusCode).toBe(401);
    const c = await loginCookie();
    expect((await app.inject({ url: '/api/auth/session', headers: { cookie: c } })).statusCode).toBe(
      200,
    );
  });

  test('logout invalida o cookie no cliente', async () => {
    const c = await loginCookie();
    const r = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: c } });
    expect(r.statusCode).toBe(200);
    expect(String(r.headers['set-cookie'])).toMatch(/Max-Age=0|Expires=/);
  });
});

describe('forca bruta', () => {
  test('tentativas erradas seguidas passam a ser recusadas com 429', async () => {
    let ultimo = 0;
    for (let i = 0; i < 12; i += 1) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { password: `errada-${i}` },
        remoteAddress: '10.0.0.5',
      });
      ultimo = r.statusCode;
    }
    expect(ultimo).toBe(429);
  });

  test('a janela de bloqueio expira', async () => {
    for (let i = 0; i < 12; i += 1) {
      await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { password: 'errada' },
        remoteAddress: '10.0.0.6',
      });
    }
    agora += 60 * 60 * 1000;
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: SENHA },
      remoteAddress: '10.0.0.6',
    });
    expect(r.statusCode).toBe(200);
  });
});

/*
 * O default `auto` nasceu de um defeito real: com `Secure` fixo, o app de TV
 * falando por http://10.0.2.2:8080 recebia 200 no login, guardava o cookie e
 * nunca mais o mandava de volta - o OkHttp recusa enviar cookie Secure por
 * HTTP. A tela piscava e voltava para a senha, indefinidamente. Estes testes
 * batem na ROTA, e nao so na funcao, porque o defeito estava justamente na
 * ligacao entre as duas.
 */
describe('SECURE_COOKIES=auto na rota', () => {
  async function buildAuto(): Promise<FastifyInstance> {
    const config: SessionConfig = { ...SESSION, secureCookies: 'auto' };
    const instance = Fastify();
    await instance.register(cookie);
    registerAuthGuard(instance, { session: config, now: () => agora });
    registerAuthRoutes(instance, { passwordHash: hash, session: config, now: () => agora });
    await instance.ready();
    return instance;
  }

  function setCookieOf(headers: Record<string, unknown>): string {
    const raw = headers['set-cookie'];
    return Array.isArray(raw) ? String(raw[0]) : String(raw);
  }

  test('chamada por HTTP nao recebe Secure, e o cookie volta na proxima', async () => {
    const auto = await buildAuto();
    const login = await auto.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: SENHA },
    });
    expect(login.statusCode).toBe(200);
    const header = setCookieOf(login.headers as Record<string, unknown>);
    expect(header).not.toContain('Secure');

    // A prova que interessa: a sessao emitida por HTTP e aceita de volta.
    const sessao = await auto.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie: header.split(';')[0]! },
    });
    expect(sessao.statusCode).toBe(200);
    await auto.close();
  });

  test('atras de proxy TLS o Secure volta', async () => {
    const auto = await buildAuto();
    const r = await auto.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-forwarded-proto': 'https' },
      payload: { password: SENHA },
    });
    expect(setCookieOf(r.headers as Record<string, unknown>)).toContain('Secure');
    await auto.close();
  });

  test('o logout repete a mesma politica do login', async () => {
    const auto = await buildAuto();
    // `/api/auth/logout` NAO e rota publica: sem sessao ela responde 401 e
    // nunca chega a emitir cookie nenhum. Entra logado, entao.
    const entrada = await auto.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: SENHA },
    });
    const sessao = setCookieOf(entrada.headers as Record<string, unknown>).split(';')[0]!;

    const puro = await auto.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: sessao },
    });
    expect(puro.statusCode).toBe(200);
    expect(setCookieOf(puro.headers as Record<string, unknown>)).not.toContain('Secure');

    const tls = await auto.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: sessao, 'x-forwarded-proto': 'https' },
    });
    const header = setCookieOf(tls.headers as Record<string, unknown>);
    expect(header).toContain('Secure');
    expect(header).toContain('Max-Age=0');
    await auto.close();
  });

  test('SECURE_COOKIES=true continua marcando mesmo em HTTP', async () => {
    // `SESSION` e 'always': e a garantia para quem so serve por HTTPS.
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: SENHA },
    });
    expect(setCookieOf(r.headers as Record<string, unknown>)).toContain('Secure');
  });
});
