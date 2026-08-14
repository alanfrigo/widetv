/**
 * Cookie de sessao stateless, assinado por HMAC-SHA256.
 *
 * Nada de sessao em memoria: o servidor reinicia e o cookie tem que continuar
 * valendo. Todo o estado cabe no proprio valor:
 *
 *   <issuedAtMs>.<hmac-sha256 base64url do issuedAtMs>
 *
 * A expiracao e derivada de `issuedAtMs + ttlMs`, entao adiantar o relogio do
 * cliente nao ajuda: o instante de emissao esta dentro da area assinada.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SessionConfig {
  secret: string;
  secureCookies: boolean;
  ttlMs: number;
}

/** Nome do cookie. O modulo HTTP le `request.cookies[SESSION_COOKIE_NAME]`. */
export const SESSION_COOKIE_NAME = 'rtv_session';

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function issueSessionCookie(config: SessionConfig, issuedAtMs: number): string {
  if (config.secret.length === 0) {
    throw new Error('SESSION_SECRET vazio: gere um com `openssl rand -hex 32`');
  }
  if (!Number.isInteger(issuedAtMs)) {
    throw new Error(`issuedAtMs precisa ser inteiro de epoch ms, recebi ${issuedAtMs}`);
  }
  const payload = String(issuedAtMs);
  const value = `${payload}.${sign(config.secret, payload)}`;
  const attributes = [
    `${SESSION_COOKIE_NAME}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(config.ttlMs / 1000)}`,
  ];
  if (config.secureCookies) attributes.push('Secure');
  return attributes.join('; ');
}

export function verifySessionCookie(config: SessionConfig, value: string, nowMs: number): boolean {
  // Sem segredo nao existe assinatura confiavel: nenhum cookie vale.
  if (config.secret.length === 0) return false;
  const separator = value.lastIndexOf('.');
  if (separator <= 0) return false;
  const payload = value.slice(0, separator);
  const signature = value.slice(separator + 1);

  const expected = Buffer.from(sign(config.secret, payload), 'utf8');
  const received = Buffer.from(signature, 'utf8');
  if (expected.length !== received.length) return false;
  if (!timingSafeEqual(expected, received)) return false;

  const issuedAtMs = Number(payload);
  if (!Number.isInteger(issuedAtMs)) return false;
  return nowMs < issuedAtMs + config.ttlMs;
}
