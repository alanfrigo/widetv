import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { scanLibrary } from '../../src/server/library/scanner.js';
import { buildFixtureTree, removeFixtureTree } from './fixture-tree.js';

/**
 * A arvore e montada em disco no `beforeAll` em vez de ficar versionada. Os
 * testes continuam batendo em filesystem de verdade; o que sai do repositorio e
 * uma pasta de 60 arquivos .mp4 vazios que, num projeto de desenhos, parecia
 * acervo commitado sem querer.
 */
let FIXTURES: string;

beforeAll(async () => {
  FIXTURES = await buildFixtureTree();
});

afterAll(async () => {
  await removeFixtureTree(FIXTURES);
});

/** Raiz de fixture pelo nome da pasta. */
function fixture(name: string): string {
  return path.join(FIXTURES, name);
}

describe('scanLibrary', () => {
  describe('schema RAIZ/SERIE/*.mp4', () => {
    it('devolve a serie com os episodios soltos da pasta', async () => {
      const shows = await scanLibrary(fixture('flat'));

      expect(shows).toHaveLength(1);
      const show = shows[0]!;
      expect(show.name).toBe('Pica-Pau');
      expect(show.slug).toBe('pica-pau');
      expect(show.absolutePath).toBe(path.join(fixture('flat'), 'Pica-Pau'));
      expect(show.episodes.map((e) => e.title)).toEqual([
        'Pica-Pau Ep 01',
        'Pica-Pau Ep 02',
      ]);
      expect(show.episodes.map((e) => e.relativePath)).toEqual([
        'Pica-Pau/Pica-Pau Ep 01.mp4',
        'Pica-Pau/Pica-Pau Ep 02.mp4',
      ]);
      expect(show.episodes.map((e) => e.orderIndex)).toEqual([0, 1]);
      expect(show.episodes[0]!.absolutePath).toBe(
        path.join(fixture('flat'), 'Pica-Pau', 'Pica-Pau Ep 01.mp4'),
      );
    });
  });

  describe('schema RAIZ/SERIE/TEMPORADA N/*.mp4', () => {
    it('percorre as pastas de temporada e tira o season da pasta', async () => {
      const shows = await scanLibrary(fixture('seasons'));

      const show = shows[0]!;
      expect(show.name).toBe('Thundercats');
      const daTemporada = show.episodes.filter((e) =>
        /\/Temporada \d+\/[^/]+$/.test(e.relativePath),
      );
      expect(daTemporada.map((e) => [e.relativePath, e.season])).toEqual([
        ['Thundercats/Temporada 1/Thundercats S01E01.mp4', 1],
        ['Thundercats/Temporada 1/Thundercats S01E02.mp4', 1],
        ['Thundercats/Temporada 2/Thundercats S02E01.mp4', 2],
      ]);
    });

    it('percorre pasta que nao e de temporada, mas deixa season null', async () => {
      const shows = await scanLibrary(fixture('seasons'));

      const extras = shows[0]!.episodes.find((e) => e.title === 'Making Of');
      expect(extras).toBeDefined();
      expect(extras!.relativePath).toBe(
        'Thundercats/Extras/Making Of.mp4',
      );
      expect(extras!.season).toBeNull();
    });

    it('herda a temporada da pasta mais proxima que casou, mesmo com subpasta no meio', async () => {
      const shows = await scanLibrary(fixture('seasons'));

      const bonus = shows[0]!.episodes.find((e) => e.title === 'Bastidores');
      expect(bonus!.relativePath).toBe(
        'Thundercats/Temporada 2/Bonus/Bastidores.mp4',
      );
      expect(bonus!.season).toBe(2);
    });
  });

  describe('extracao de season e episode do nome', () => {
    it('entende o formato S01E02', async () => {
      const shows = await scanLibrary(fixture('naming'));

      const found = shows[0]!.episodes.find(
        (e) => e.title === 'Formatos S01E02',
      );
      expect(found).toMatchObject({ season: 1, episode: 2 });
    });

    it('entende o formato 1x02', async () => {
      const shows = await scanLibrary(fixture('naming'));

      const found = shows[0]!.episodes.find(
        (e) => e.title === 'Formatos 1x03',
      );
      expect(found).toMatchObject({ season: 1, episode: 3 });
    });

    it('entende o formato - 02 - e deixa season null', async () => {
      const shows = await scanLibrary(fixture('naming'));

      const found = shows[0]!.episodes.find(
        (e) => e.title === 'Formatos - 04 - Titulo',
      );
      expect(found).toMatchObject({ season: null, episode: 4 });
    });

    it('entende o formato Ep 02', async () => {
      const shows = await scanLibrary(fixture('naming'));

      const found = shows[0]!.episodes.find(
        (e) => e.title === 'Formatos Ep 05',
      );
      expect(found).toMatchObject({ season: null, episode: 5 });
    });

    it('entende o formato [02]', async () => {
      const shows = await scanLibrary(fixture('naming'));

      const found = shows[0]!.episodes.find(
        (e) => e.title === 'Formatos [06]',
      );
      expect(found).toMatchObject({ season: null, episode: 6 });
    });

    it('devolve null quando nao ha match confiavel, sem inventar pela posicao', async () => {
      const shows = await scanLibrary(fixture('naming'));

      const found = shows[0]!.episodes.find(
        (e) => e.title === 'Formatos sem numero',
      );
      expect(found).toMatchObject({ season: null, episode: null });
      expect(found!.orderIndex).toBeGreaterThanOrEqual(0);
    });
  });

  describe('regex tolerante de pasta de temporada', () => {
    it('aceita S01, T02, Season 3 e temporada 04', async () => {
      const shows = await scanLibrary(fixture('seasonfolders'));

      const porCaminho = new Map(
        shows[0]!.episodes.map((e) => [e.relativePath, e.season]),
      );
      expect(porCaminho.get('Serie/S01/a.mp4')).toBe(1);
      expect(porCaminho.get('Serie/T02/b.mp4')).toBe(2);
      expect(porCaminho.get('Serie/Season 3/c.mp4')).toBe(3);
      expect(porCaminho.get('Serie/temporada 04/d.mp4')).toBe(4);
    });
  });

  describe('mistura dos dois schemas na mesma serie', () => {
    it('ordena por temporada e joga o que nao tem numero para o fim', async () => {
      const shows = await scanLibrary(fixture('mixed'));

      const show = shows[0]!;
      expect(show.name).toBe('He-Man');
      expect(show.episodes.map((e) => e.relativePath)).toEqual([
        'He-Man/Temporada 2/He-Man S02E01.mp4',
        'He-Man/Temporada 10/He-Man S10E01.mp4',
        'He-Man/He-Man Especial.mp4',
      ]);
      expect(show.episodes.map((e) => e.orderIndex)).toEqual([0, 1, 2]);
    });

    it('ordena Temporada 2 antes de Temporada 10 (numero, nao texto)', async () => {
      const shows = await scanLibrary(fixture('mixed'));

      const seasons = shows[0]!.episodes.map((e) => e.season);
      expect(seasons).toEqual([2, 10, null]);
    });

    it('sem agrupamento, a ordem e a da caminhada: soltos antes das temporadas', async () => {
      const shows = await scanLibrary(fixture('mixed'), { smartGrouping: false });

      const show = shows[0]!;
      expect(show.episodes.map((e) => e.relativePath)).toEqual([
        'He-Man/He-Man Especial.mp4',
        'He-Man/Temporada 2/He-Man S02E01.mp4',
        'He-Man/Temporada 10/He-Man S10E01.mp4',
      ]);
      expect(show.episodes.map((e) => e.orderIndex)).toEqual([0, 1, 2]);
      expect(show.episodes.map((e) => e.season)).toEqual([null, 2, 10]);
    });
  });

  describe('ordenacao', () => {
    it('ordena arquivos por natural sort case-insensitive (ep2 antes de ep10)', async () => {
      const shows = await scanLibrary(fixture('natural'));

      expect(shows[0]!.episodes.map((e) => e.title)).toEqual([
        'Ursinhos EP1',
        'Ursinhos ep2',
        'Ursinhos ep10',
      ]);
      expect(shows[0]!.episodes.map((e) => e.orderIndex)).toEqual([0, 1, 2]);
    });

    it('ordena as series por name com natural sort', async () => {
      const shows = await scanLibrary(fixture('showsort'));

      expect(shows.map((s) => s.name)).toEqual(['Serie 2', 'Serie 10']);
    });

    it('nao perde nem embaralha serie com mais series que a concorrencia', async () => {
      const shows = await scanLibrary(fixture('many'));

      expect(shows.map((s) => s.name)).toEqual([
        'Serie 1',
        'Serie 2',
        'Serie 3',
        'Serie 4',
        'Serie 5',
        'Serie 6',
        'Serie 7',
        'Serie 8',
        'Serie 9',
        'Serie 10',
        'Serie 11',
        'Serie 12',
      ]);
      expect(shows.every((s) => s.episodes.length === 1)).toBe(true);
    });
  });

  describe('arquivos e pastas ignorados', () => {
    it('ignora ocultos, @eaDir, .AppleDouble, #recycle e extensao fora da lista', async () => {
      const shows = await scanLibrary(fixture('ignored'));

      expect(shows).toHaveLength(1);
      expect(shows[0]!.episodes.map((e) => e.relativePath)).toEqual([
        'Serie/Serie Ep 01.mp4',
      ]);
    });

    it('ignora pasta oculta e @eaDir na propria raiz', async () => {
      const shows = await scanLibrary(fixture('ignored'));

      expect(shows.map((s) => s.name)).toEqual(['Serie']);
    });
  });

  describe('symlinks', () => {
    it('segue symlink que aponta para dentro da raiz e ignora o que sai dela', async () => {
      const shows = await scanLibrary(fixture('symlink'));

      const caminhos = shows[0]!.episodes.map((e) => e.relativePath);
      expect(caminhos).toContain('Serie/link-dentro.mp4');
      expect(caminhos).toContain('Serie/Temporada 1/Serie S01E03.mp4');
      expect(caminhos).toContain('Serie/Temporada 2/Serie S01E03.mp4');
      expect(caminhos).not.toContain('Serie/link-fora.mp4');
      expect(caminhos.some((c) => c.includes('pasta-fora'))).toBe(false);
      expect(caminhos.some((c) => c.includes('Fora Ep 99'))).toBe(false);
    });

    it('nao entra em loop quando o symlink aponta para a propria pasta', async () => {
      const shows = await scanLibrary(fixture('symlink'));

      const caminhos = shows[0]!.episodes.map((e) => e.relativePath);
      expect(caminhos.some((c) => c.includes('loop/loop'))).toBe(false);
      expect(new Set(caminhos).size).toBe(caminhos.length);
    });
  });

  describe('extensoes', () => {
    it('aceita a lista default e descarta o resto', async () => {
      const shows = await scanLibrary(fixture('ext'));

      // `.avi` entra: ficar de fora fazia as temporadas antigas de um acervo
      // sumirem do catalogo sem nenhum aviso. Elas nao tocam no navegador, mas
      // "invisivel" e pior que "aparece com um aviso do que fazer".
      // `.iso` continua fora - aquilo nao e um episodio.
      expect(shows[0]!.episodes.map((e) => e.title)).toEqual([
        'a',
        'b',
        'c',
        'd',
        'e',
      ]);
    });

    it('respeita a lista passada em options', async () => {
      const shows = await scanLibrary(fixture('ext'), {
        extensions: ['.avi'],
      });

      expect(shows[0]!.episodes.map((e) => e.title)).toEqual(['e']);
    });
  });

  describe('slug', () => {
    it('tira acento, baixa a caixa e junta o resto com traco', async () => {
      const shows = await scanLibrary(fixture('slug'));

      const porNome = new Map(
        shows.map((s) => [s.name.normalize('NFC'), s.slug]),
      );
      expect(porNome.get('Ação & Aventura!')).toBe('acao-aventura');
      expect(porNome.get('As Aventuras do Barão')).toBe(
        'as-aventuras-do-barao',
      );
    });

    it('nunca fica vazio quando o nome nao tem letra ASCII', async () => {
      const shows = await scanLibrary(fixture('slug'));

      const japones = shows.find((s) => s.name.normalize('NFC') === 'ドラえもん');
      expect(japones).toBeDefined();
      expect(japones!.slug).not.toBe('');
      expect(japones!.slug).toMatch(/^[a-z0-9-]+$/);
    });

    it('gera sempre o mesmo slug para o mesmo nome', async () => {
      const primeira = await scanLibrary(fixture('slug'));
      const segunda = await scanLibrary(fixture('slug'));

      expect(primeira.map((s) => s.slug)).toEqual(segunda.map((s) => s.slug));
    });
  });

  describe('serie sem episodio valido', () => {
    it('nao aparece no resultado', async () => {
      const shows = await scanLibrary(fixture('empty-show'));

      expect(shows.map((s) => s.name)).toEqual(['Com Video']);
    });
  });

  describe('agrupamento de pastas de release', () => {
    it('funde S01, S02 e S03 num show so, com o titulo limpo', async () => {
      const shows = await scanLibrary(fixture('release'));

      expect(shows.map((s) => s.name)).toEqual(['Rick and Morty', 'The Simpsons']);
      const rick = shows[0]!;
      expect(rick.slug).toBe('rick-and-morty');
      expect(rick.episodes).toHaveLength(4);
    });

    it('a temporada da pasta de release vale para os episodios dela', async () => {
      const shows = await scanLibrary(fixture('release'));

      const rick = shows[0]!;
      expect(rick.episodes.map((e) => [e.season, e.episode])).toEqual([
        [1, 1],
        [1, 2],
        [2, 1],
        // Arquivo sem numeracao nenhuma: a temporada veio so da pasta.
        [3, null],
      ]);
    });

    it('reatribui orderIndex continuo depois de unir as pastas', async () => {
      const shows = await scanLibrary(fixture('release'));

      expect(shows[0]!.episodes.map((e) => e.orderIndex)).toEqual([0, 1, 2, 3]);
      expect(shows[1]!.episodes.map((e) => e.orderIndex)).toEqual([0]);
    });

    it('aponta para a primeira pasta do grupo em ordem natural', async () => {
      const shows = await scanLibrary(fixture('release'));

      expect(shows[0]!.absolutePath).toBe(
        path.join(
          fixture('release'),
          'Rick.and.Morty.S01.1080p.HMAX.WEB-DL.DD2.0.x264-DUAL-SiGLA',
        ),
      );
    });

    it('nao funde series diferentes que compartilham prefixo', async () => {
      const shows = await scanLibrary(fixture('prefixo'));

      expect(shows.map((s) => s.name)).toEqual(['The Office UK', 'The Office US']);
      expect(shows.map((s) => s.episodes.length)).toEqual([1, 2]);
    });

    it('nao funde nomes que so colidem no slug, sem sinal de release', async () => {
      // "Acao" e "Ação" viram a mesma chave ASCII; sao series diferentes.
      const shows = await scanLibrary(fixture('slug'));

      expect(shows).toHaveLength(3);
    });

    it('smartGrouping false volta ao comportamento de uma pasta por serie', async () => {
      const shows = await scanLibrary(fixture('release'), { smartGrouping: false });

      expect(shows.map((s) => s.name)).toEqual([
        'Rick.and.Morty.S01.1080p.HMAX.WEB-DL.DD2.0.x264-DUAL-SiGLA',
        'Rick.and.Morty.S02.1080p.HMAX.WEB-DL.DD2.0.x264-DUAL-SiGLA',
        'Rick.and.Morty.S03.2160p.NF.WEB-DL.DDP5.1.x265-DUAL-SiGLA',
        'The.Simpsons.S37.1080p.DSNP.WEB-DL.DDP5.1.H.264-DUAL',
      ]);
      // Sem agrupamento a pasta de release nao empresta temporada nenhuma.
      expect(shows[2]!.episodes[0]!.season).toBeNull();
    });

    it('duas execucoes sobre a mesma arvore devolvem exatamente o mesmo resultado', async () => {
      const primeira = await scanLibrary(fixture('release'));
      const segunda = await scanLibrary(fixture('release'));

      expect(segunda).toEqual(primeira);
    });

    it('adicionar uma pasta nova nao renomeia o slug de quem ja existia', async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'widetv-grouping-'));
      const criar = async (folder: string, file: string): Promise<void> => {
        await mkdir(path.join(root, folder), { recursive: true });
        await writeFile(path.join(root, folder, file), '');
      };

      await criar('Rick.and.Morty.S01.1080p.WEB-DL-SiGLA', 'Rick.and.Morty.S01E01.mkv');
      const antes = await scanLibrary(root);

      await criar('Rick.and.Morty.S02.1080p.WEB-DL-SiGLA', 'Rick.and.Morty.S02E01.mkv');
      await criar('Chaves.1a.Temporada.1972.DVDRip', 'Chaves 01.mkv');
      const depois = await scanLibrary(root);

      expect(antes.map((s) => s.slug)).toEqual(['rick-and-morty']);
      expect(depois.map((s) => s.slug)).toEqual(['chaves', 'rick-and-morty']);
      expect(depois.find((s) => s.name === 'Rick and Morty')!.episodes).toHaveLength(2);

      await rm(root, { recursive: true, force: true });
    });
  });

  describe('temporada solta na raiz', () => {
    it('pasta que e SO temporada junta-se a serie pelo nome dos arquivos', async () => {
      const shows = await scanLibrary(fixture('loose'));

      expect(shows.map((s) => s.name)).toEqual(['The Simpsons']);
      const simpsons = shows[0]!;
      expect(simpsons.slug).toBe('the-simpsons');
      expect(simpsons.episodes).toHaveLength(4);
      // A temporada da pasta solta vale para os episodios dela.
      expect(simpsons.episodes.map((e) => e.season)).toEqual([36, 36, 37, 37]);
    });

    it('arquivos sem serie no nome mantem a pasta como canal proprio', async () => {
      const shows = await scanLibrary(fixture('loose-orfa'));

      expect(shows.map((s) => s.name)).toEqual(['S05']);
      // Mesmo sem titulo derivavel, o numero da pasta vale como temporada.
      expect(shows[0]!.episodes[0]!.season).toBe(5);
    });

    it('smartGrouping false nao deriva nada: pasta solta continua canal literal', async () => {
      const shows = await scanLibrary(fixture('loose'), { smartGrouping: false });

      expect(shows.map((s) => s.name)).toEqual(['Temporada 37', 'The Simpsons']);
    });
  });

  describe('ano como desempate no agrupamento', () => {
    it('pasta com ano funde com a temporada solta batizada pelos arquivos', async () => {
      // "The Simpsons (1989)" gera chave com ano; o titulo derivado dos NOMES
      // DE ARQUIVO nunca carrega ano. Sem desempate, nasceriam DOIS canais com
      // o mesmo nome - e o slug do segundo ganharia digest.
      const shows = await scanLibrary(fixture('yeartie'));

      expect(shows.map((s) => s.name)).toEqual(['The Simpsons']);
      const simpsons = shows[0]!;
      expect(simpsons.slug).toBe('the-simpsons');
      expect(simpsons.episodes).toHaveLength(4);
      expect(simpsons.episodes.map((e) => e.season)).toEqual([36, 36, 37, 37]);
    });

    it('dois anos diferentes na mesma base continuam series separadas', async () => {
      // Com "Doctor Who (1963)" e "Doctor Who (2005)" em jogo, fundir a
      // temporada solta sem ano com qualquer um deles seria adivinhacao.
      const shows = await scanLibrary(fixture('twoyears'));

      expect(shows).toHaveLength(3);
      expect(new Set(shows.map((s) => s.slug)).size).toBe(3);
    });

    it('sem sinal de release, o ano continua separando', async () => {
      // "Doce Vida" e "Doce Vida (1989)" sao pastas curadas, sem release: a
      // regra conservadora vale e nada se move.
      const shows = await scanLibrary(fixture('yearplain'));

      expect(shows).toHaveLength(2);
    });
  });

  describe('arquivo de video solto na raiz', () => {
    it('junta-se a serie que ja tem pasta, pelo titulo no proprio nome', async () => {
      const shows = await scanLibrary(fixture('rootfiles'));

      const simpsons = shows.find((s) => s.slug === 'the-simpsons');
      expect(simpsons).toBeDefined();
      expect(simpsons!.episodes.map((e) => e.relativePath)).toEqual([
        'The Simpsons/The.Simpsons.S36E01.mkv',
        'The.Simpsons.S37E01.1080p.DSNP.WEB-DL-DUAL.mkv',
      ]);
      // A pasta de verdade representa o grupo, nunca o arquivo solto.
      expect(simpsons!.absolutePath).toBe(
        path.join(fixture('rootfiles'), 'The Simpsons'),
      );
    });

    it('sem pasta nenhuma, forma serie propria pelo nome do arquivo', async () => {
      const shows = await scanLibrary(fixture('rootfiles'));

      const chaves = shows.find((s) => s.slug === 'chaves');
      expect(chaves).toBeDefined();
      expect(chaves!.name).toBe('Chaves');
      expect(chaves!.episodes.map((e) => [e.season, e.episode])).toEqual([[1, 1]]);
    });

    it('arquivo sem serie no nome continua invisivel', async () => {
      // "ferias na praia.mp4" nao carrega serie nenhuma: inventar um canal por
      // arquivo encheria o catalogo de lixo.
      const shows = await scanLibrary(fixture('rootfiles'));

      expect(shows.map((s) => s.slug).sort()).toEqual(['chaves', 'the-simpsons']);
    });

    it('smartGrouping false ignora arquivo solto, como sempre ignorou', async () => {
      const shows = await scanLibrary(fixture('rootfiles'), { smartGrouping: false });

      expect(shows.map((s) => s.name)).toEqual(['The Simpsons']);
    });
  });

  describe('raiz invalida', () => {
    it('lanca erro com o caminho na mensagem quando a raiz nao existe', async () => {
      const missing = fixture('nao-existe-em-lugar-nenhum');

      await expect(scanLibrary(missing)).rejects.toThrow(missing);
      await expect(scanLibrary(missing)).rejects.toThrow(
        /raiz da biblioteca/i,
      );
    });

    it('lanca erro quando a raiz existe mas nao e diretorio', async () => {
      const notADirectory = path.join(
        fixture('flat'),
        'Pica-Pau',
        'Pica-Pau Ep 01.mp4',
      );

      await expect(scanLibrary(notADirectory)).rejects.toThrow(notADirectory);
      await expect(scanLibrary(notADirectory)).rejects.toThrow(
        /raiz da biblioteca/i,
      );
    });
  });
});
