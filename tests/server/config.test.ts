import { describe, expect, test } from 'vitest';
import {
  ConfigError,
  loadConfig,
  parseRescanTimeEnv,
  parseRescanTimeInput,
} from '../../src/server/config';

function env(over: Record<string, string | undefined> = {}) {
  return {
    LIBRARY_ROOT: '/media/desenhos',
    DATA_DIR: './data',
    PORT: '8080',
    CHANNEL_EPOCH: '2024-01-01T00:00:00Z',
    AUTH_PASSWORD_HASH: 'scrypt$16384$8$1$abc$def',
    SESSION_SECRET: 'a'.repeat(64),
    SECURE_COOKIES: 'true',
    ...over,
  };
}

describe('loadConfig', () => {
  test('le um ambiente completo', () => {
    const c = loadConfig(env());
    expect(c.libraryRoot).toBe('/media/desenhos');
    expect(c.port).toBe(8080);
    expect(c.channelEpochMs).toBe(Date.parse('2024-01-01T00:00:00Z'));
    expect(c.secureCookies).toBe('always');
  });

  test('resolve dataDir para caminho absoluto', () => {
    expect(loadConfig(env()).dataDir.startsWith('/')).toBe(true);
  });

  test('autoScan vem ligado: num deploy novo nao existe indice, e o usuario nao tem shell', () => {
    expect(loadConfig(env()).autoScan).toBe(true);
    expect(loadConfig(env({ AUTO_SCAN: undefined })).autoScan).toBe(true);
  });

  test('AUTO_SCAN=false desliga, e so isso desliga', () => {
    expect(loadConfig(env({ AUTO_SCAN: 'false' })).autoScan).toBe(false);
    expect(loadConfig(env({ AUTO_SCAN: 'FALSE' })).autoScan).toBe(false);
    expect(loadConfig(env({ AUTO_SCAN: '0' })).autoScan).toBe(true);
    expect(loadConfig(env({ AUTO_SCAN: 'sim' })).autoScan).toBe(true);
  });

  test('autoRemux segue a mesma regra do autoScan: ligado por padrao, so "false" desliga', () => {
    expect(loadConfig(env()).autoRemux).toBe(true);
    expect(loadConfig(env({ AUTO_REMUX: 'false' })).autoRemux).toBe(false);
    expect(loadConfig(env({ AUTO_REMUX: 'FALSE' })).autoRemux).toBe(false);
    expect(loadConfig(env({ AUTO_REMUX: '0' })).autoRemux).toBe(true);
  });

  test('autoThumbs segue a mesma regra: ligado por padrao, so "false" desliga', () => {
    expect(loadConfig(env()).autoThumbs).toBe(true);
    expect(loadConfig(env({ AUTO_THUMBS: 'false' })).autoThumbs).toBe(false);
    expect(loadConfig(env({ AUTO_THUMBS: 'FALSE' })).autoThumbs).toBe(false);
    expect(loadConfig(env({ AUTO_THUMBS: '0' })).autoThumbs).toBe(true);
  });

  test('rescanTime: default 04:00, HH:MM local, off/false desliga', () => {
    expect(loadConfig(env()).rescanTime).toEqual({ hour: 4, minute: 0 });
    expect(loadConfig(env({ RESCAN_TIME: '3:30' })).rescanTime).toEqual({ hour: 3, minute: 30 });
    expect(loadConfig(env({ RESCAN_TIME: '23:59' })).rescanTime).toEqual({ hour: 23, minute: 59 });
    expect(loadConfig(env({ RESCAN_TIME: 'off' })).rescanTime).toBeNull();
    expect(loadConfig(env({ RESCAN_TIME: 'false' })).rescanTime).toBeNull();
    // Vazio (UI de NAS manda assim) conta como ausente e cai no default.
    expect(loadConfig(env({ RESCAN_TIME: '' })).rescanTime).toEqual({ hour: 4, minute: 0 });
  });

  test('rescanTime torto e erro de boot, nao default silencioso', () => {
    for (const value of ['4h', '25:00', '04:60', 'madrugada', '4:0']) {
      expect(() => loadConfig(env({ RESCAN_TIME: value }))).toThrow(/RESCAN_TIME/);
    }
  });

  test('smartGrouping segue a regra do autoScan: ligado por padrao, so "false" desliga', () => {
    expect(loadConfig(env()).smartGrouping).toBe(true);
    expect(loadConfig(env({ SMART_GROUPING: undefined })).smartGrouping).toBe(true);
    expect(loadConfig(env({ SMART_GROUPING: 'false' })).smartGrouping).toBe(false);
    expect(loadConfig(env({ SMART_GROUPING: 'FALSE' })).smartGrouping).toBe(false);
    expect(loadConfig(env({ SMART_GROUPING: '0' })).smartGrouping).toBe(true);
  });

  test('DATA_DIR vazio nao vira caminho relativo silencioso', () => {
    // Uma UI que manda a variavel em branco (TrueNAS faz isso) derrubava o
    // dataDir para ./data, ou seja /app/data dentro do container: diretorio do
    // root, sem volume e sem permissao de escrita.
    const c = loadConfig(env({ DATA_DIR: '   ' }));
    expect(c.dataDir).toBe(loadConfig(env({ DATA_DIR: undefined })).dataDir);
  });

  test('PORT tem default', () => {
    expect(loadConfig(env({ PORT: undefined })).port).toBe(8080);
  });

  test('CHANNEL_EPOCH tem default estavel', () => {
    const c = loadConfig(env({ CHANNEL_EPOCH: undefined }));
    expect(Number.isFinite(c.channelEpochMs)).toBe(true);
  });

  test.each(['LIBRARY_ROOT', 'AUTH_PASSWORD_HASH', 'SESSION_SECRET'])(
    '%s ausente e erro de configuracao, nao crash silencioso',
    (key) => {
      expect(() => loadConfig(env({ [key]: undefined }))).toThrow(ConfigError);
      expect(() => loadConfig(env({ [key]: undefined }))).toThrow(new RegExp(key));
    },
  );

  test('variavel presente mas vazia conta como ausente', () => {
    expect(() => loadConfig(env({ LIBRARY_ROOT: '   ' }))).toThrow(ConfigError);
  });

  test('SESSION_SECRET curto e recusado', () => {
    expect(() => loadConfig(env({ SESSION_SECRET: 'curto' }))).toThrow(/SESSION_SECRET/);
  });

  test('CHANNEL_EPOCH invalido e recusado', () => {
    expect(() => loadConfig(env({ CHANNEL_EPOCH: 'ontem' }))).toThrow(/CHANNEL_EPOCH/);
  });

  test.each(['0', '70000', 'abc', '-1', '8080.5'])('PORT invalido (%s) e recusado', (port) => {
    expect(() => loadConfig(env({ PORT: port }))).toThrow(/PORT/);
  });

  test('SECURE_COOKIES e tri-estado: so "true" e "false" mandam', () => {
    // Ausente ou ilegivel cai em `auto`, que marca Secure quando ha TLS - e o
    // que faz a casa em HTTP na LAN funcionar sem abrir mao de HTTPS quando ele
    // existe. Veja `parseSecureCookies`.
    expect(loadConfig(env({ SECURE_COOKIES: undefined })).secureCookies).toBe('auto');
    expect(loadConfig(env({ SECURE_COOKIES: 'false' })).secureCookies).toBe('never');
    expect(loadConfig(env({ SECURE_COOKIES: 'qualquer coisa' })).secureCookies).toBe('auto');
  });

  test('AUTH_PASSWORD_HASH em texto claro e recusado no boot', () => {
    // Erro classico: colar a senha onde o hash deveria estar. Sem esta checagem
    // o servidor sobe achando que esta configurado e responde "senha incorreta"
    // para a senha certa, que e o pior jeito possivel de falhar.
    expect(() => loadConfig(env({ AUTH_PASSWORD_HASH: 'minha-senha' }))).toThrow(
      /AUTH_PASSWORD_HASH/,
    );
  });

  test('AUTH_PASSWORD_HASH truncado e recusado no boot', () => {
    expect(() => loadConfig(env({ AUTH_PASSWORD_HASH: 'scrypt$16384$8$1$abc' }))).toThrow(
      ConfigError,
    );
  });

  test('a mensagem do hash invalido diz como gerar o certo', () => {
    expect(() => loadConfig(env({ AUTH_PASSWORD_HASH: 'minha-senha' }))).toThrow(
      /hash-password/,
    );
  });

  test('TMDB_API_KEY e opcional: sem ela o servidor sobe e usa os provedores sem chave', () => {
    expect(loadConfig(env()).tmdbApiKey).toBeNull();
    expect(loadConfig(env({ TMDB_API_KEY: undefined })).tmdbApiKey).toBeNull();
  });

  test('TMDB_API_KEY em branco conta como ausente, nao como chave vazia', () => {
    // A UI do TrueNAS manda variavel nao preenchida como string vazia; uma chave
    // vazia so renderia 401 em toda busca de capa.
    expect(loadConfig(env({ TMDB_API_KEY: '   ' })).tmdbApiKey).toBeNull();
  });

  test('TMDB_API_KEY chega sem espaco em volta', () => {
    expect(loadConfig(env({ TMDB_API_KEY: ' abc123 ' })).tmdbApiKey).toBe('abc123');
  });

  test('DISPLAY_MODE nao existe mais e nao derruba o boot', () => {
    // widetv e widescreen-only: a variavel do fork antigo ainda pode estar no
    // .env de quem migrou, e ela tem que ser simplesmente ignorada.
    expect(() => loadConfig(env({ DISPLAY_MODE: 'crt' }))).not.toThrow();
  });

  test('mensagem de erro nomeia a variavel e nao vaza o segredo', () => {
    const secret = 'x'.repeat(64);
    try {
      loadConfig(env({ SESSION_SECRET: secret, CHANNEL_EPOCH: 'ontem' }));
      expect.unreachable('deveria ter lancado');
    } catch (e) {
      const message = (e as Error).message;
      expect(message).toContain('CHANNEL_EPOCH');
      expect(message).not.toContain(secret);
    }
  });
});

describe('parseRescanTimeEnv x parseRescanTimeInput', () => {
  test('os dois leem o mesmo horario', () => {
    expect(parseRescanTimeEnv('23:59')).toEqual({ hour: 23, minute: 59 });
    expect(parseRescanTimeInput('23:59')).toEqual({ hour: 23, minute: 59 });
    expect(parseRescanTimeEnv('3:30')).toEqual({ hour: 3, minute: 30 });
    expect(parseRescanTimeInput('3:30')).toEqual({ hour: 3, minute: 30 });
  });

  test('e desligam do mesmo jeito', () => {
    expect(parseRescanTimeEnv('off')).toBeNull();
    expect(parseRescanTimeEnv('FALSE')).toBeNull();
    expect(parseRescanTimeInput('off')).toBeNull();
    expect(parseRescanTimeInput('FALSE')).toBeNull();
    // Do painel, "desligado" chega como null; campo apagado tambem desliga.
    expect(parseRescanTimeInput(null)).toBeNull();
    expect(parseRescanTimeInput('  ')).toBeNull();
  });

  test('valor torto: o .env derruba o boot, o painel so recusa', () => {
    // A diferenca e o ponto de existirem duas funcoes. Ambiente torto precisa
    // ser descoberto antes de o servidor subir; painel torto vira 400, porque
    // ninguem pode derrubar um servidor no ar digitando "25:00" na TV.
    for (const valor of ['4h', '25:00', '04:60', 'madrugada', '4:0']) {
      expect(() => parseRescanTimeEnv(valor)).toThrow(ConfigError);
      expect(parseRescanTimeInput(valor)).toBeUndefined();
    }
  });

  test('so o .env tem default: vazio la vira 04:00, aqui vira desligado', () => {
    expect(parseRescanTimeEnv(undefined)).toEqual({ hour: 4, minute: 0 });
    expect(parseRescanTimeEnv('')).toEqual({ hour: 4, minute: 0 });
    expect(parseRescanTimeInput('')).toBeNull();
  });
});
