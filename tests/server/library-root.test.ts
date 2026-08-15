import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { libraryRootWarning } from '../../src/server/library-root';

let base: string;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'widetv-libroot-'));
});

afterAll(async () => {
  // Devolve a permissao antes de apagar, senao o rm falha.
  const travado = join(base, 'travado');
  try {
    chmodSync(travado, 0o755);
  } catch {
    /* nem sempre existe */
  }
  await rm(base, { recursive: true, force: true });
});

describe('libraryRootWarning', () => {
  test('diretorio legivel nao gera aviso', () => {
    const ok = join(base, 'ok');
    mkdirSync(ok);
    expect(libraryRootWarning(ok)).toBeNull();
  });

  test('caminho inexistente avisa para conferir a montagem do volume', () => {
    const aviso = libraryRootWarning(join(base, 'nao-existe'));
    expect(aviso).toContain('nao existe');
    expect(aviso).toContain('montado');
  });

  test('arquivo no lugar de diretorio e dito com todas as letras', () => {
    const arquivo = join(base, 'arquivo.mp4');
    writeFileSync(arquivo, 'x');
    expect(libraryRootWarning(arquivo)).toContain('nao e um diretorio');
  });

  test('diretorio sem leitura avisa sobre a ACL e cita o uid', () => {
    // Rodando como root a permissao nao barra nada e o teste nao prova coisa
    // alguma - pula, como em qualquer suite que depende de EACCES.
    if (process.getuid?.() === 0) return;

    const travado = join(base, 'travado');
    mkdirSync(travado, { recursive: true });
    chmodSync(travado, 0o000);

    const aviso = libraryRootWarning(travado);
    expect(aviso).toContain('sem permissao');
    expect(aviso).toContain('ACL');
    expect(aviso).toContain(String(process.getuid?.()));
  });
});
