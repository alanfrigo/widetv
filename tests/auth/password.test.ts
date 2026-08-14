import { hashPassword, isValidPasswordHash, verifyPassword } from '../../src/server/auth/password.js';

describe('hashPassword / verifyPassword', () => {
  it('aceita a senha correta', async () => {
    const hash = await hashPassword('minha-senha-secreta');
    await expect(verifyPassword('minha-senha-secreta', hash)).resolves.toBe(true);
  });

  it('rejeita senha errada, inclusive quando so muda o ultimo caractere', async () => {
    const hash = await hashPassword('minha-senha-secreta');
    await expect(verifyPassword('minha-senha-secretA', hash)).resolves.toBe(false);
    await expect(verifyPassword('', hash)).resolves.toBe(false);
    await expect(verifyPassword('minha-senha-secreta ', hash)).resolves.toBe(false);
  });

  it('devolve false para hash malformado, sem lancar', async () => {
    const malformed = [
      '',
      'nao-e-hash',
      'scrypt$16384$8$1$c2FsdA==', // campos de menos
      'scrypt$16384$8$1$c2FsdA==$aGFzaA==$extra', // campos demais
      'argon2id$16384$8$1$c2FsdA==$aGFzaA==', // algoritmo desconhecido
      'scrypt$abc$8$1$c2FsdA==$aGFzaA==', // N nao numerico
      'scrypt$16384$8$1$$aGFzaA==', // salt vazio
      'scrypt$16384$8$1$c2FsdA==$', // hash vazio
      'scrypt$12345$8$1$c2FsdA==$aGFzaA==', // N nao potencia de dois
    ];
    for (const hash of malformed) {
      await expect(verifyPassword('qualquer', hash)).resolves.toBe(false);
    }
  });

  it('usa salt aleatorio: dois hashes da mesma senha sao diferentes e ambos valem', async () => {
    const a = await hashPassword('senha-repetida');
    const b = await hashPassword('senha-repetida');
    expect(a).not.toBe(b);
    await expect(verifyPassword('senha-repetida', a)).resolves.toBe(true);
    await expect(verifyPassword('senha-repetida', b)).resolves.toBe(true);
  });

  it('guarda os parametros no proprio hash', async () => {
    const hash = await hashPassword('senha');
    const parts = hash.split('$');
    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe('scrypt');
    // N potencia de dois, r e p inteiros positivos
    expect(Number(parts[1])).toBeGreaterThanOrEqual(16384);
    expect(Number(parts[2])).toBeGreaterThanOrEqual(1);
    expect(Number(parts[3])).toBeGreaterThanOrEqual(1);
    // salt de 16 bytes, chave de 32
    expect(Buffer.from(parts[4] ?? '', 'base64')).toHaveLength(16);
    expect(Buffer.from(parts[5] ?? '', 'base64')).toHaveLength(32);
  });

  it('verifica hash gravado com parametros diferentes dos atuais', async () => {
    // Hash antigo, custo menor: os parametros vem do proprio hash, nao de
    // constantes do modulo, entao ele continua verificavel apos um aumento de N.
    const { scrypt } = await import('node:crypto');
    const salt = Buffer.from('0123456789abcdef');
    const key = await new Promise<Buffer>((resolve, reject) => {
      scrypt('senha-antiga', salt, 32, { N: 1024, r: 8, p: 1 }, (err, derived) =>
        err ? reject(err) : resolve(derived),
      );
    });
    const legacy = `scrypt$1024$8$1$${salt.toString('base64')}$${key.toString('base64')}`;
    await expect(verifyPassword('senha-antiga', legacy)).resolves.toBe(true);
    await expect(verifyPassword('senha-errada', legacy)).resolves.toBe(false);
  });

  it('trata senha com acento, espaco e emoji', async () => {
    const senha = 'Aventuras do Pica-pau 1990 ção ';
    const hash = await hashPassword(senha);
    await expect(verifyPassword(senha, hash)).resolves.toBe(true);
    await expect(verifyPassword('Aventuras do Pica-pau 1990 cao ', hash)).resolves.toBe(false);
  });
});

describe('isValidPasswordHash', () => {
  test('aceita um hash recem gerado', async () => {
    expect(isValidPasswordHash(await hashPassword('qualquer'))).toBe(true);
  });

  test.each([
    ['vazio', ''],
    ['so espacos', '   '],
    ['senha em texto claro', 'minha-senha-secreta'],
    ['algoritmo errado', 'argon2$16384$8$1$c2FsdA==$a2V5'],
    ['campos faltando', 'scrypt$16384$8$1$c2FsdA=='],
    ['parametro nao numerico', 'scrypt$abc$8$1$c2FsdA==$a2V5'],
    ['salt vazio', 'scrypt$16384$8$1$$a2V5'],
    ['chave vazia', 'scrypt$16384$8$1$c2FsdA==$'],
  ])('recusa %s', (_caso, valor) => {
    expect(isValidPasswordHash(valor)).toBe(false);
  });

  test('tolera espaco em volta, que e o que sobra de copiar e colar', async () => {
    const hash = await hashPassword('qualquer');
    expect(isValidPasswordHash(`  ${hash}  `)).toBe(true);
  });
});
