import { chmodSync, mkdirSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { DataDirError, ensureDataDir } from '../../src/server/data-dir';

let base: string;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'retro-tv-datadir-'));
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

describe('ensureDataDir', () => {
  test('cria o diretorio quando ele ainda nao existe', () => {
    const alvo = join(base, 'novo', 'aninhado');
    ensureDataDir(alvo);
    expect(statSync(alvo).isDirectory()).toBe(true);
  });

  test('e idempotente: rodar de novo num diretorio existente nao reclama', () => {
    const alvo = join(base, 'novo', 'aninhado');
    expect(() => ensureDataDir(alvo)).not.toThrow();
  });

  test('diretorio sem permissao de escrita falha no boot, nao na primeira gravacao', () => {
    // Este e o caso real do container: DATA_DIR caindo em /app, que pertence ao
    // root enquanto o processo roda como `node`. Descobrir isso no boot e muito
    // melhor do que descobrir no meio de um scan de 14 mil arquivos.
    const travado = join(base, 'travado');
    mkdirSync(travado, { recursive: true });
    chmodSync(travado, 0o555);

    expect(() => ensureDataDir(travado)).toThrow(DataDirError);
  });

  test('a mensagem de erro cita o caminho e a variavel que o controla', () => {
    const travado = join(base, 'travado');
    try {
      ensureDataDir(travado);
      throw new Error('deveria ter falhado');
    } catch (error) {
      const mensagem = (error as Error).message;
      expect(mensagem).toContain(travado);
      expect(mensagem).toContain('DATA_DIR');
    }
  });
});
