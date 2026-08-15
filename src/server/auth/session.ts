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

/**
 * Quando marcar o cookie como `Secure`.
 *
 * `auto` existe porque o caso normal deste app e uma casa: o servidor sobe num
 * NAS e os aparelhos falam com ele por `http://192.168.x.x:8080`, sem TLS. Um
 * `Secure` fixo ali e um cookie que o cliente guarda e nunca reenvia - o
 * navegador so nao sofre disso em `localhost`, que ele trata como origem segura
 * por excecao. Fora do navegador (o OkHttp do app de TV, por exemplo) o login
 * responde 200 e a proxima chamada volta 401, para sempre.
 */
export type SecureCookiePolicy = 'always' | 'never' | 'auto';

export interface SessionConfig {
  secret: string;
  secureCookies: SecureCookiePolicy;
  ttlMs: number;
}

/**
 * @param requestIsSecure  a conexao que pediu o cookie chegou por HTTPS (TLS
 *                         direto ou `x-forwarded-proto: https` de um proxy).
 */
export function shouldMarkSecure(
  policy: SecureCookiePolicy,
  requestIsSecure: boolean,
): boolean {
  if (policy === 'always') return true;
  if (policy === 'never') return false;
  return requestIsSecure;
}

/** Nome do cookie. O modulo HTTP le `request.cookies[SESSION_COOKIE_NAME]`. */
export const SESSION_COOKIE_NAME = 'rtv_session';

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function issueSessionCookie(
  config: SessionConfig,
  issuedAtMs: number,
  requestIsSecure: boolean,
): string {
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
  if (shouldMarkSecure(config.secureCookies, requestIsSecure)) attributes.push('Secure');
  return attributes.join('; ');
}

/**
 * Cookie de logout. Precisa repetir os MESMOS atributos do de login: cliente que
 * casa cookie por (nome, dominio, caminho, secure) ignora um apagamento que nao
 * bate, e a sessao continuaria de pe.
 */
export function clearSessionCookie(
  config: SessionConfig,
  requestIsSecure: boolean,
): string {
  const attributes = [`${SESSION_COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (shouldMarkSecure(config.secureCookies, requestIsSecure)) attributes.push('Secure');
  return attributes.join('; ');
}

/**
 * A conexao chegou por HTTPS?
 *
 * O `x-forwarded-proto` entra porque o deploy tipico poe um proxy na frente
 * terminando TLS - sem ele, `auto` nunca marcaria `Secure` atras de um Caddy ou
 * de um Nginx. Cabecalho forjado aqui so consegue ADICIONAR `Secure`, que e
 * mais restritivo; para o caminho contrario existe `SECURE_COOKIES=true`.
 */
export function requestIsSecure(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  encrypted: boolean,
): boolean {
  if (encrypted) return true;
  const raw = headers['x-forwarded-proto'];
  const first = Array.isArray(raw) ? raw[0] : raw;
  // Uma cadeia de proxies manda "https, http": vale o primeiro, que e o do cliente.
  return first?.split(',')[0]?.trim().toLowerCase() === 'https';
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
