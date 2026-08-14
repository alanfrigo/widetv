import { describe, expect, test } from 'vitest';
import { ConfigError, loadConfig } from '../../src/server/config';

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
    expect(c.secureCookies).toBe(true);
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

  test('SECURE_COOKIES so e falso quando dito explicitamente', () => {
    // Default seguro: quem esquecer a variavel nao perde a flag Secure.
    expect(loadConfig(env({ SECURE_COOKIES: undefined })).secureCookies).toBe(true);
    expect(loadConfig(env({ SECURE_COOKIES: 'false' })).secureCookies).toBe(false);
    expect(loadConfig(env({ SECURE_COOKIES: 'qualquer coisa' })).secureCookies).toBe(true);
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

  test('displayMode tem default crt', () => {
    expect(loadConfig(env({ DISPLAY_MODE: undefined })).displayMode).toBe('crt');
    expect(loadConfig(env({ DISPLAY_MODE: '' })).displayMode).toBe('crt');
    expect(loadConfig(env({ DISPLAY_MODE: '   ' })).displayMode).toBe('crt');
  });

  test('displayMode aceita widescreen, com trim e case-insensitive', () => {
    expect(loadConfig(env({ DISPLAY_MODE: 'widescreen' })).displayMode).toBe('widescreen');
    expect(loadConfig(env({ DISPLAY_MODE: ' WIDESCREEN ' })).displayMode).toBe('widescreen');
  });

  test.each(['widescren', '4k'])('displayMode invalido (%s) e recusado', (value) => {
    expect(() => loadConfig(env({ DISPLAY_MODE: value }))).toThrow(ConfigError);
    expect(() => loadConfig(env({ DISPLAY_MODE: value }))).toThrow(/DISPLAY_MODE/);
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
