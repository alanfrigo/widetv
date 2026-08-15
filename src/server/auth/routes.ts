import type { FastifyInstance, FastifyRequest } from 'fastify';

import { verifyPassword } from './password';
import {
  SESSION_COOKIE_NAME,
  clearSessionCookie,
  issueSessionCookie,
  requestIsSecure,
  verifySessionCookie,
  type SessionConfig,
} from './session';

/**
 * Portao de entrada. O app fica exposto na internet, entao tudo aqui e escrito
 * assumindo que alguem vai bater na porta: a resposta de erro nao diferencia
 * causas, e tentativa repetida do mesmo IP e freada.
 */

/** Rotas que existem justamente para quem ainda nao tem sessao. */
const PUBLIC_PATHS = new Set(['/api/auth/login', '/api/auth/session']);

const MAX_FAILURES = 10;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;

export interface AuthDeps {
  passwordHash: string;
  session: SessionConfig;
  now: () => number;
}

export interface GuardDeps {
  session: SessionConfig;
  now: () => number;
}

/** TLS terminando no proprio processo. Atras de proxy o socket e texto puro. */
function isEncrypted(request: FastifyRequest): boolean {
  return (request.raw.socket as { encrypted?: boolean }).encrypted === true;
}

function sessionIsValid(request: FastifyRequest, deps: GuardDeps): boolean {
  const raw = request.cookies[SESSION_COOKIE_NAME];
  if (raw === undefined) return false;
  return verifySessionCookie(deps.session, raw, deps.now());
}

/**
 * Contador de falhas por IP, em memoria.
 *
 * Reiniciar o servidor limpa o contador, o que e aceitavel: isso freia varredura
 * automatizada, nao substitui o firewall nem o reverse proxy.
 */
class FailureTracker {
  private readonly failures = new Map<string, { count: number; firstAtMs: number }>();

  isLocked(ip: string, nowMs: number): boolean {
    const entry = this.failures.get(ip);
    if (entry === undefined) return false;
    if (nowMs - entry.firstAtMs > LOCKOUT_WINDOW_MS) {
      this.failures.delete(ip);
      return false;
    }
    return entry.count >= MAX_FAILURES;
  }

  record(ip: string, nowMs: number): void {
    const entry = this.failures.get(ip);
    if (entry === undefined || nowMs - entry.firstAtMs > LOCKOUT_WINDOW_MS) {
      this.failures.set(ip, { count: 1, firstAtMs: nowMs });
      return;
    }
    entry.count += 1;
  }

  clear(ip: string): void {
    this.failures.delete(ip);
  }
}

export function registerAuthGuard(app: FastifyInstance, deps: GuardDeps): void {
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    if (PUBLIC_PATHS.has(request.url.split('?')[0] ?? request.url)) return;
    if (sessionIsValid(request, deps)) return;
    return reply.code(401).send({ error: 'nao autenticado' });
  });
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const tracker = new FailureTracker();

  app.post('/api/auth/login', async (request, reply) => {
    const body = request.body as { password?: unknown } | undefined;
    const password = body?.password;

    if (typeof password !== 'string' || password.length === 0) {
      return reply.code(400).send({ error: 'senha ausente' });
    }

    const now = deps.now();
    const ip = request.ip;

    if (tracker.isLocked(ip, now)) {
      return reply.code(429).send({ error: 'muitas tentativas' });
    }

    if (!(await verifyPassword(password, deps.passwordHash))) {
      tracker.record(ip, now);
      // Mensagem generica de proposito: nada sobre formato, tamanho ou hash.
      return reply.code(401).send({ error: 'acesso negado' });
    }

    tracker.clear(ip);
    reply.header(
      'set-cookie',
      issueSessionCookie(deps.session, now, requestIsSecure(request.headers, isEncrypted(request))),
    );
    return { ok: true };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    reply.header(
      'set-cookie',
      clearSessionCookie(deps.session, requestIsSecure(request.headers, isEncrypted(request))),
    );
    return { ok: true };
  });

  app.get('/api/auth/session', async (request, reply) => {
    if (!sessionIsValid(request, { session: deps.session, now: deps.now })) {
      return reply.code(401).send({ error: 'nao autenticado' });
    }
    return { ok: true };
  });
}
