import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { scanLibrary, type ScannedShow } from '../../src/server/library/scanner';

/**
 * Nomes de pasta tirados do acervo real (461 series). O padrao dominante em
 * portugues poe o numero ANTES da palavra ("1a Temporada"), que e o oposto do
 * que "Temporada 1" sugere.
 */
const SEASON_FOLDERS = [
  '1a Temporada',
  '2a Temporada',
  '10a Temporada',
  '21a Temporada',
  '1 Temporada',
  '3 Temporada',
  '1a Temporada Dublada',
  '2a Temporada Legendada',
  '1a.Temporada.1959-1960',
  '3a.Temporada.1961',
  '1a Season',
  '10a Season',
  'Terceira Temporada Incompleta',
  'Temporada 4',
  'Season 5',
  'S06',
  'T07',
];

const ESPERADO: Record<string, number> = {
  '1a Temporada': 1,
  '2a Temporada': 2,
  '10a Temporada': 10,
  '21a Temporada': 21,
  '1 Temporada': 1,
  '3 Temporada': 3,
  '1a Temporada Dublada': 1,
  '2a Temporada Legendada': 2,
  '1a.Temporada.1959-1960': 1,
  '3a.Temporada.1961': 3,
  '1a Season': 1,
  '10a Season': 10,
  'Terceira Temporada Incompleta': 3,
  'Temporada 4': 4,
  'Season 5': 5,
  S06: 6,
  T07: 7,
};

let root: string;
let show: ScannedShow;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'widetv-seasons-'));
  for (const folder of SEASON_FOLDERS) {
    const dir = join(root, 'Serie', folder);
    await mkdir(dir, { recursive: true });
    // Nome de arquivo sem numeracao: forca o season a vir da pasta.
    await writeFile(join(dir, 'arquivo.mp4'), '');
  }
  const shows = await scanLibrary(root);
  show = shows[0]!;
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('temporadas com os nomes reais do acervo', () => {
  test.each(Object.entries(ESPERADO))('"%s" e a temporada %i', (folder, esperado) => {
    const episodio = show.episodes.find((e) => e.relativePath.includes(`/${folder}/`));
    expect(episodio, `nenhum episodio para a pasta ${folder}`).toBeDefined();
    expect(episodio!.season).toBe(esperado);
  });

  test('pasta que nao e temporada continua sem numero', async () => {
    const outro = await mkdtemp(join(tmpdir(), 'widetv-nao-temporada-'));
    const dir = join(outro, 'Serie', 'Episodios Censurados');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'arquivo.mp4'), '');

    const [serie] = await scanLibrary(outro);
    expect(serie!.episodes[0]!.season).toBeNull();
    await rm(outro, { recursive: true, force: true });
  });

  test('ordena as temporadas por numero, nao por texto', () => {
    const numeros = show.episodes.map((e) => e.season);
    // "10a Temporada" nao pode vir antes de "2a Temporada".
    const dez = numeros.indexOf(10);
    const dois = numeros.indexOf(2);
    expect(dez).toBeGreaterThan(dois);
  });
});
