import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { scanLibrary } from '../../src/server/library/scanner';

/**
 * O slug e a chave idempotente da serie no indice, e o numero do canal e
 * amarrado a ele. Dois nomes diferentes colidindo no mesmo slug fariam duas
 * series virarem um canal so, e a segunda sumiria sem aviso.
 */

let root: string;

async function serie(name: string, episodio = 'ep 01.mp4'): Promise<void> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, episodio), '');
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'widetv-slug-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('unicidade do slug', () => {
  test('acento e ausencia de acento nao colapsam na mesma serie', async () => {
    await serie('Acao');
    await serie('Ação');

    const shows = await scanLibrary(root);
    expect(shows).toHaveLength(2);
    expect(new Set(shows.map((s) => s.slug)).size).toBe(2);
  });

  test('diferenca so de pontuacao tambem gera slugs distintos', async () => {
    await serie('Tom e Jerry');
    await serie('Tom & Jerry');
    await serie('Tom - Jerry');

    const shows = await scanLibrary(root);
    expect(new Set(shows.map((s) => s.slug)).size).toBe(shows.length);
  });

  test('o primeiro em ordem mantem o slug limpo', async () => {
    await serie('Acao');
    await serie('Ação');

    const shows = await scanLibrary(root);
    const limpo = shows.filter((s) => s.slug === 'acao');
    expect(limpo).toHaveLength(1);
    expect(limpo[0]!.name).toBe('Acao');
  });

  test('o slug de uma serie nao muda quando outra e adicionada depois', async () => {
    await serie('Acao');
    const antes = (await scanLibrary(root))[0]!.slug;

    await serie('Ação');
    const depois = (await scanLibrary(root)).find((s) => s.name === 'Acao')!.slug;

    expect(depois).toBe(antes);
  });

  test('sem colisao, nenhum sufixo e adicionado', async () => {
    await serie('ThunderCats');
    await serie('He-Man');

    const shows = await scanLibrary(root);
    expect(shows.map((s) => s.slug).sort()).toEqual(['he-man', 'thundercats']);
  });

  test('a desambiguacao e estavel entre execucoes', async () => {
    // Tres nomes que diferem so por acento. Nao vale usar diferenca de caixa:
    // o filesystem do macOS e case-insensitive e as pastas virariam uma so.
    await serie('Acao');
    await serie('Ação');
    await serie('Açao');

    const a = (await scanLibrary(root)).map((s) => `${s.name}=${s.slug}`);
    const b = (await scanLibrary(root)).map((s) => `${s.name}=${s.slug}`);
    expect(b).toEqual(a);
    expect(new Set((await scanLibrary(root)).map((s) => s.slug)).size).toBe(3);
  });
});
