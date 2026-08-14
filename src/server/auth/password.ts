/**
 * Hash de senha com scrypt do node:crypto.
 *
 * Por que scrypt e nao argon2: o CONTRACTS.md permite as duas opcoes e pede que
 * a escolha seja documentada. O runtime ja carrega um modulo nativo
 * (better-sqlite3), que obriga o Dockerfile a recompilar na arquitetura do
 * runtime. Adicionar `argon2` dobraria essa superficie de build (mais um
 * node-gyp, mais um risco de prebuild ausente em arm64) para proteger uma unica
 * senha de acesso domestico. scrypt vem no core, tem custo de memoria
 * configuravel e nao adiciona nada ao build.
 *
 * Formato autocontido, os parametros viajam junto com o hash:
 *   scrypt$N$r$p$<salt base64>$<hash base64>
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const ALGORITHM = 'scrypt';
const DEFAULT_N = 16384;
const DEFAULT_R = 8;
const DEFAULT_P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

/** Teto de custo aceito ao verificar. Impede que um hash adulterado com N
 * gigante vire uma bomba de memoria no processo do servidor. */
const MAX_N = 1 << 20;
const MAX_R = 32;
const MAX_P = 16;

function maxmemFor(n: number, r: number, p: number): number {
  // scrypt precisa de 128 * N * r bytes; a margem cobre o overhead interno.
  return 256 * n * r * p + 1024 * 1024;
}

function isPowerOfTwo(value: number): boolean {
  return value > 1 && (value & (value - 1)) === 0;
}

/** Aceita apenas parametros que o scrypt consegue rodar sem lancar. */
function paramsAreSane(n: number, r: number, p: number): boolean {
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (!isPowerOfTwo(n) || n > MAX_N) return false;
  if (r < 1 || r > MAX_R) return false;
  if (p < 1 || p > MAX_P) return false;
  return true;
}

/**
 * Confere so o FORMATO do hash, sem senha nenhuma.
 *
 * Existe para o servidor recusar subir com `AUTH_PASSWORD_HASH` mal
 * configurado. Sem isso, colar a senha em texto claro no lugar do hash faz o
 * servidor subir normalmente e responder "senha incorreta" para a senha certa,
 * que e o pior jeito possivel de falhar: parece bug de login, e e configuracao.
 */
export function isValidPasswordHash(hash: string): boolean {
  const parts = hash.trim().split('$');
  if (parts.length !== 6) return false;

  const [algorithm, rawN, rawR, rawP, rawSalt, rawKey] = parts;
  if (algorithm !== ALGORITHM) return false;
  if (!paramsAreSane(Number(rawN), Number(rawR), Number(rawP))) return false;

  return (
    Buffer.from(rawSalt ?? '', 'base64').length > 0 &&
    Buffer.from(rawKey ?? '', 'base64').length > 0
  );
}

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(plain, salt, KEY_BYTES, {
    N: DEFAULT_N,
    r: DEFAULT_R,
    p: DEFAULT_P,
    maxmem: maxmemFor(DEFAULT_N, DEFAULT_R, DEFAULT_P),
  });
  return [
    ALGORITHM,
    String(DEFAULT_N),
    String(DEFAULT_R),
    String(DEFAULT_P),
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  const parts = hash.split('$');
  if (parts.length !== 6) return false;
  const [algorithm, rawN, rawR, rawP, rawSalt, rawKey] = parts;
  if (algorithm !== ALGORITHM) return false;

  const n = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  if (!paramsAreSane(n, r, p)) return false;

  const salt = Buffer.from(rawSalt ?? '', 'base64');
  const expected = Buffer.from(rawKey ?? '', 'base64');
  if (salt.length === 0 || expected.length === 0) return false;

  const derived = await scrypt(plain, salt, expected.length, {
    N: n,
    r,
    p,
    maxmem: maxmemFor(n, r, p),
  });
  return timingSafeEqual(derived, expected);
}
