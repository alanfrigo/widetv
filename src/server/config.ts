import { resolve } from 'node:path';

import { isValidPasswordHash } from './auth/password';
import type { RescanTime } from './library/rescan-timer';

/**
 * Leitura e validacao das variaveis de ambiente.
 *
 * Recebe o ambiente por parametro em vez de ler `process.env` direto: e o que
 * torna isso testavel e o que impede um import acidental de derrubar o processo
 * na hora do carregamento do modulo.
 */

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export interface AppConfig {
  libraryRoot: string;
  dataDir: string;
  port: number;
  /** Instante zero da grade, em epoch ms. */
  channelEpochMs: number;
  authPasswordHash: string;
  sessionSecret: string;
  secureCookies: boolean;
  /** Indexa o acervo sozinho quando o indice ainda nao existe. */
  autoScan: boolean;
  /**
   * Converte para MP4, em segundo plano, os episodios que o navegador nao toca
   * direto (MKV, audio Dolby). Copia de bytes, nao transcode - mas ocupa
   * espaco em DATA_DIR, entao da para desligar.
   */
  autoRemux: boolean;
  /**
   * Horario LOCAL do rescan diario da biblioteca (adiciona e remove episodios
   * sozinho). `null` quando desligado (RESCAN_TIME=off).
   */
  rescanTime: RescanTime | null;
  /**
   * Chave do TMDB, opcional. `null` quando ausente: a busca de capa cai nos
   * provedores sem chave (TVMaze, iTunes) e o servidor sobe do mesmo jeito.
   */
  tmdbApiKey: string | null;
}

export type Env = Record<string, string | undefined>;

/** Mesmo valor do .env.example: mudar isso reposiciona todos os canais. */
const DEFAULT_EPOCH = '2024-01-01T00:00:00Z';
const DEFAULT_PORT = 8080;
const MIN_SECRET_LENGTH = 32;

function required(env: Env, key: string): string {
  const raw = env[key]?.trim();
  if (!raw) {
    throw new ConfigError(`${key} e obrigatorio. Veja .env.example.`);
  }
  return raw;
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_PORT;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new ConfigError(`PORT precisa ser um inteiro, recebeu "${trimmed}".`);
  }
  const port = Number(trimmed);
  if (port < 1 || port > 65535) {
    throw new ConfigError(`PORT precisa estar entre 1 e 65535, recebeu ${port}.`);
  }
  return port;
}

/** Mesmo valor do .env.example: madrugada, depois do horario tipico de download. */
const DEFAULT_RESCAN_TIME = '04:00';

/**
 * `HH:MM` local, `off`/`false` desliga, vazio cai no default. Formato torto e
 * erro de boot, nao um default silencioso: um horario ignorado so seria
 * descoberto quando a serie nova nunca aparecesse.
 */
function parseRescanTime(raw: string | undefined): RescanTime | null {
  const value = raw?.trim() || DEFAULT_RESCAN_TIME;
  const lowered = value.toLowerCase();
  if (lowered === 'off' || lowered === 'false') return null;

  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new ConfigError(`RESCAN_TIME precisa ser HH:MM (ou "off"), recebeu "${value}".`);
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    throw new ConfigError(`RESCAN_TIME fora do relogio: "${value}".`);
  }
  return { hour, minute };
}

function parseEpoch(raw: string | undefined): number {
  const value = raw?.trim() || DEFAULT_EPOCH;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new ConfigError(`CHANNEL_EPOCH precisa ser uma data ISO 8601, recebeu "${value}".`);
  }
  return parsed;
}

export function loadConfig(env: Env): AppConfig {
  const sessionSecret = required(env, 'SESSION_SECRET');
  if (sessionSecret.length < MIN_SECRET_LENGTH) {
    // Nunca ecoe o valor: essa mensagem costuma acabar em log.
    throw new ConfigError(
      `SESSION_SECRET precisa ter pelo menos ${MIN_SECRET_LENGTH} caracteres. Gere com: openssl rand -hex 32`,
    );
  }

  const authPasswordHash = required(env, 'AUTH_PASSWORD_HASH');
  if (!isValidPasswordHash(authPasswordHash)) {
    // Nunca ecoe o valor recebido: se for a senha em texto claro, ela iria
    // parar no log.
    throw new ConfigError(
      'AUTH_PASSWORD_HASH nao e um hash valido. Ele guarda o HASH da senha, ' +
        'nao a senha. Gere com: npm run hash-password',
    );
  }

  return {
    libraryRoot: required(env, 'LIBRARY_ROOT'),
    dataDir: resolve(env.DATA_DIR?.trim() || './data'),
    port: parsePort(env.PORT),
    channelEpochMs: parseEpoch(env.CHANNEL_EPOCH),
    authPasswordHash,
    sessionSecret,
    // Default seguro: so desliga quem escrever exatamente "false".
    secureCookies: env.SECURE_COOKIES?.trim().toLowerCase() !== 'false',
    // Ligado por padrao: quem sobe isto num NAS nao tem shell no container, e
    // um deploy novo sem indice nao serve canal nenhum.
    autoScan: env.AUTO_SCAN?.trim().toLowerCase() !== 'false',
    // Mesma regra do AUTO_SCAN: so "false" desliga.
    autoRemux: env.AUTO_REMUX?.trim().toLowerCase() !== 'false',
    rescanTime: parseRescanTime(env.RESCAN_TIME),
    // Variavel em branco (a UI do TrueNAS manda assim) conta como ausente: uma
    // chave vazia so renderia 401 em toda busca de capa.
    tmdbApiKey: env.TMDB_API_KEY?.trim() || null,
  };
}
