import { readdir, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { ShowMetadataRow, ShowRow } from '../../src/server/library/index-store';
import {
  createEnricher,
  enrichMissing,
  listShowsMissingMetadata,
  NOT_FOUND_TTL_MS,
  type MetadataStore,
} from '../../src/server/metadata/service';
import { ImageGoneError } from '../../src/server/metadata/providers';
import type { LookupResult, ShowMetadata } from '../../src/server/metadata/providers';

/**
 * O que estes testes protegem, em uma frase: o indice so pode aprender coisa
 * definitiva ("achei", "nao existe") - falha de rede tem que deixar o show
 * exatamente como estava, para ser tentado de novo.
 */

const AGORA = Date.parse('2026-01-01T00:00:00Z');

function show(id: number, name: string): ShowRow {
  return { id, slug: name.toLowerCase(), name, channelNumber: id, absolutePath: `/lib/${name}` };
}

interface FakeStore extends MetadataStore {
  rows: Map<number, ShowMetadataRow>;
}

function makeStore(shows: ShowRow[]): FakeStore {
  const rows = new Map<number, ShowMetadataRow>();
  return {
    rows,
    listShows: () => shows,
    getShowMetadata: (showId) => rows.get(showId) ?? null,
    upsertShowMetadata: (row) => {
      rows.set(row.showId, row);
    },
  };
}

function found(
  posterUrl: string | null = 'https://img/a.jpg',
  over: Partial<ShowMetadata> = {},
  providerFailed = false,
): LookupResult {
  return {
    status: 'found',
    metadata: {
      posterUrl,
      backdropUrl: null,
      year: 1985,
      overview: 'Sinopse.',
      source: 'tvmaze',
      ...over,
    },
    providerFailed,
    failureReason: providerFailed ? 'tmdb respondeu 500' : null,
  };
}

/** Linha completa; os testes sobrescrevem o que importa. */
function row(showId: number, over: Partial<ShowMetadataRow> = {}): ShowMetadataRow {
  return {
    showId,
    posterFile: `${String(showId)}.jpg`,
    backdropFile: null,
    backdropCheckedAt: null,
    backdropSource: null,
    year: 1985,
    overview: null,
    source: 'tvmaze',
    fetchedAt: AGORA,
    notFound: false,
    ...over,
  };
}

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'widetv-metadata-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('listShowsMissingMetadata', () => {
  test('serie nunca buscada entra', () => {
    const store = makeStore([show(1, 'ThunderCats')]);
    expect(listShowsMissingMetadata(store, AGORA).map((s) => s.id)).toEqual([1]);
  });

  test('serie ja encontrada nao volta: capa nao muda', () => {
    const store = makeStore([show(1, 'ThunderCats')]);
    store.rows.set(1, row(1, { fetchedAt: AGORA - 10 * NOT_FOUND_TTL_MS }));
    expect(listShowsMissingMetadata(store, AGORA)).toEqual([]);
  });

  test('not_found dentro do TTL nao e reconsultado', () => {
    const store = makeStore([show(1, 'Obscura')]);
    store.rows.set(
      1,
      row(1, {
        posterFile: null,
        year: null,
        source: null,
        fetchedAt: AGORA - (NOT_FOUND_TTL_MS - 1),
        notFound: true,
      }),
    );
    expect(listShowsMissingMetadata(store, AGORA)).toEqual([]);
  });

  test('not_found vencido volta para a fila', () => {
    const store = makeStore([show(1, 'Obscura')]);
    store.rows.set(
      1,
      row(1, {
        posterFile: null,
        year: null,
        source: null,
        fetchedAt: AGORA - NOT_FOUND_TTL_MS,
        notFound: true,
      }),
    );
    expect(listShowsMissingMetadata(store, AGORA).map((s) => s.id)).toEqual([1]);
  });

  test('serie sem arte 16:9 procurada NAO volta sozinha: seria loop de rede a cada boot', () => {
    const store = makeStore([show(1, 'ThunderCats')]);
    store.rows.set(1, row(1, { source: 'tmdb', backdropCheckedAt: null }));
    expect(listShowsMissingMetadata(store, AGORA)).toEqual([]);
  });

  test('mas volta quando a pessoa pede refresh', () => {
    const store = makeStore([show(1, 'ThunderCats')]);
    store.rows.set(1, row(1, { source: 'tmdb', backdropCheckedAt: null }));
    expect(listShowsMissingMetadata(store, AGORA, NOT_FOUND_TTL_MS, 'refresh').map((s) => s.id)) //
      .toEqual([1]);
  });

  test('serie ja PROCURADA sai da fila do refresh, tenha ganhado arte ou nao', () => {
    // O criterio e o carimbo, e nao `backdropFile === null`: uma serie que o
    // provedor conhece mas nao ilustra tem arquivo nulo para sempre, e voltaria
    // a cada clique se o predicado olhasse so para o arquivo.
    const store = makeStore([show(1, 'Com arte'), show(2, 'Sem arte no provedor')]);
    store.rows.set(1, row(1, { backdropFile: '1.jpg', backdropCheckedAt: AGORA }));
    store.rows.set(2, row(2, { backdropFile: null, backdropCheckedAt: AGORA }));
    expect(listShowsMissingMetadata(store, AGORA, NOT_FOUND_TTL_MS, 'refresh')).toEqual([]);
  });

  test('o refresh nao exige que a linha tenha vindo do TMDB', () => {
    // Uma linha do TVMaze pode ser do tempo em que nao havia TMDB_API_KEY.
    // Exigir `source === 'tmdb'` a deixaria sem arte para sempre, mesmo depois
    // de a chave ser configurada.
    const store = makeStore([show(1, 'Do TVMaze')]);
    store.rows.set(1, row(1, { source: 'tvmaze', backdropCheckedAt: null }));
    expect(listShowsMissingMetadata(store, AGORA, NOT_FOUND_TTL_MS, 'refresh').map((s) => s.id)) //
      .toEqual([1]);
  });
});

describe('enrichMissing', () => {
  test('grava a linha e a capa em disco', async () => {
    const store = makeStore([show(1, 'ThunderCats')]);

    const report = await enrichMissing(store, dataDir, {
      now: () => AGORA,
      // Com TMDB na cadeia: e o que autoriza o carimbo de "ja procurei arte".
      tmdbApiKey: 'chave-de-teste',
      lookup: () => Promise.resolve(found()),
      download: () => Promise.resolve(new Uint8Array([0xff, 0xd8, 0xff])),
    });

    expect(report).toEqual({ considered: 1, found: 1, posters: 1, notFound: 0, failed: 0 });
    expect(store.rows.get(1)).toEqual({
      showId: 1,
      posterFile: '1.jpg',
      backdropFile: null,
      backdropCheckedAt: AGORA,
      backdropSource: null,
      year: 1985,
      overview: 'Sinopse.',
      source: 'tvmaze',
      fetchedAt: AGORA,
      notFound: false,
    });
    expect(Array.from(await readFile(join(dataDir, 'posters', '1.jpg')))).toEqual([
      0xff, 0xd8, 0xff,
    ]);
  });

  test('nao deixa temporario para tras', async () => {
    const store = makeStore([show(1, 'ThunderCats')]);
    await enrichMissing(store, dataDir, {
      now: () => AGORA,
      lookup: () => Promise.resolve(found()),
      download: () => Promise.resolve(new Uint8Array([1])),
    });
    expect(await readdir(join(dataDir, 'posters'))).toEqual(['1.jpg']);
  });

  test('serie sem capa no provedor guarda ano e sinopse, sem arquivo', async () => {
    const store = makeStore([show(1, 'Sem arte')]);

    const report = await enrichMissing(store, dataDir, {
      now: () => AGORA,
      lookup: () => Promise.resolve(found(null)),
      download: () => Promise.reject(new Error('nao deveria baixar nada')),
    });

    expect(report.posters).toBe(0);
    expect(store.rows.get(1)?.posterFile).toBeNull();
    expect(store.rows.get(1)?.year).toBe(1985);
  });

  test('arte 16:9 vai para backdrops/ e o basename entra na linha', async () => {
    const store = makeStore([show(1, 'ThunderCats')]);

    await enrichMissing(store, dataDir, {
      now: () => AGORA,
      lookup: () => Promise.resolve(found('https://img/a.jpg', { backdropUrl: 'https://img/b.jpg' })),
      download: (url) =>
        Promise.resolve(new Uint8Array(url.endsWith('b.jpg') ? [0xbb] : [0xaa])),
    });

    expect(store.rows.get(1)?.backdropFile).toBe('1.jpg');
    // Marcada como do provedor: e o que impede a arte tirada de quadro de
    // tomar este lugar depois.
    expect(store.rows.get(1)?.backdropSource).toBe('tmdb');
    // Diretorios distintos: capa e arte tem o mesmo nome, so o caminho muda.
    expect(Array.from(await readFile(join(dataDir, 'posters', '1.jpg')))).toEqual([0xaa]);
    expect(Array.from(await readFile(join(dataDir, 'backdrops', '1.jpg')))).toEqual([0xbb]);
    expect(await readdir(join(dataDir, 'backdrops'))).toEqual(['1.jpg']);
  });

  test('arte do TMDB SUBSTITUI a que foi tirada de um quadro', async () => {
    const store = makeStore([show(1, 'ThunderCats')]);
    // O estado de quem rodou a fila de quadros sem TMDB_API_KEY: a linha existe
    // so para guardar o nome do arquivo, e diz que ninguem procurou metadata.
    store.rows.set(
      1,
      row(1, {
        posterFile: null,
        backdropFile: '1.jpg',
        backdropSource: 'frame',
        year: null,
        source: null,
        fetchedAt: 0,
        notFound: true,
      }),
    );

    await enrichMissing(store, dataDir, {
      now: () => AGORA,
      lookup: () => Promise.resolve(found('https://img/a.jpg', { backdropUrl: 'https://img/b.jpg' })),
      download: (url) =>
        Promise.resolve(new Uint8Array(url.endsWith('b.jpg') ? [0xbb] : [0xaa])),
    });

    expect(store.rows.get(1)).toMatchObject({
      backdropFile: '1.jpg',
      backdropSource: 'tmdb',
    });
    // O quadro era o remendo; a arte de verdade escreve por cima do mesmo
    // arquivo, entao nao ficam duas em disco.
    expect(Array.from(await readFile(join(dataDir, 'backdrops', '1.jpg')))).toEqual([0xbb]);
  });

  test('a arte de quadro NUNCA substitui a do provedor, e sobrevive a uma busca sem arte', async () => {
    const store = makeStore([show(1, 'ThunderCats'), show(2, 'Duas')]);
    // 1 ja tem arte do provedor; 2 tem uma tirada de quadro.
    store.rows.set(1, row(1, { backdropFile: '1.jpg', backdropSource: 'tmdb', notFound: true }));
    store.rows.set(
      2,
      row(2, { posterFile: null, backdropFile: '2.jpg', backdropSource: 'frame', notFound: true }),
    );

    await enrichMissing(store, dataDir, {
      now: () => AGORA,
      // O provedor da vez nao tem arte 16:9 (TVMaze, iTunes) - e o caso comum.
      lookup: () => Promise.resolve(found('https://img/a.jpg')),
      download: () => Promise.resolve(new Uint8Array([0xaa])),
    });

    // Nenhuma das duas foi apagada por uma resposta que nao trouxe arte.
    expect(store.rows.get(1)).toMatchObject({ backdropFile: '1.jpg', backdropSource: 'tmdb' });
    expect(store.rows.get(2)).toMatchObject({ backdropFile: '2.jpg', backdropSource: 'frame' });
  });

  test('"nao conheco esta serie" nao apaga a arte tirada de quadro', async () => {
    const store = makeStore([show(1, 'Obscura')]);
    store.rows.set(
      1,
      row(1, {
        posterFile: null,
        backdropFile: '1.jpg',
        backdropSource: 'frame',
        fetchedAt: 0,
        notFound: true,
      }),
    );

    await enrichMissing(store, dataDir, {
      now: () => AGORA,
      lookup: () => Promise.resolve({ status: 'not-found' }),
    });

    // Sem isto, a serie que o provedor nao conhece - justamente a que mais
    // precisa do remendo - voltaria ao listrado depois da primeira busca.
    expect(store.rows.get(1)).toMatchObject({
      backdropFile: '1.jpg',
      backdropSource: 'frame',
      notFound: true,
    });
  });

  test('provedor sem arte 16:9 nem cria o diretorio de backdrops', async () => {
    const store = makeStore([show(1, 'Do TVMaze')]);

    await enrichMissing(store, dataDir, {
      now: () => AGORA,
      lookup: () => Promise.resolve(found()),
      download: () => Promise.resolve(new Uint8Array([1])),
    });

    expect(store.rows.get(1)?.backdropFile).toBeNull();
    await expect(readdir(join(dataDir, 'backdrops'))).rejects.toThrow();
  });

  test('arte que falha ao baixar NAO derruba a capa nem marca not_found', async () => {
    // A arte e enfeite: a tela cai no padrao listrado sem ela. Abortar aqui
    // jogaria fora a capa que ja esta em disco.
    const store = makeStore([show(1, 'ThunderCats')]);

    const report = await enrichMissing(store, dataDir, {
      now: () => AGORA,
      tmdbApiKey: 'chave-de-teste',
      lookup: () => Promise.resolve(found('https://img/a.jpg', { backdropUrl: 'https://img/b.jpg' })),
      download: (url) =>
        url.endsWith('b.jpg')
          ? Promise.reject(new Error('502'))
          : Promise.resolve(new Uint8Array([0xaa])),
    });

    expect(report).toMatchObject({ found: 1, posters: 1, failed: 0, notFound: 0 });
    expect(store.rows.get(1)).toMatchObject({
      posterFile: '1.jpg',
      backdropFile: null,
      backdropCheckedAt: AGORA,
      backdropSource: null,
      notFound: false,
    });
    expect(Array.from(await readFile(join(dataDir, 'posters', '1.jpg')))).toEqual([0xaa]);
  });

  test('not-found vira linha marcada, para nao rebater no provedor toda hora', async () => {
    const store = makeStore([show(1, 'Nao existe')]);

    const report = await enrichMissing(store, dataDir, {
      now: () => AGORA,
      tmdbApiKey: 'chave-de-teste',
      lookup: () => Promise.resolve({ status: 'not-found' }),
    });

    expect(report.notFound).toBe(1);
    expect(store.rows.get(1)).toEqual({
      showId: 1,
      posterFile: null,
      backdropFile: null,
      backdropCheckedAt: AGORA,
      backdropSource: null,
      year: null,
      overview: null,
      source: null,
      fetchedAt: AGORA,
      notFound: true,
    });
  });

  test('erro de rede NAO grava nada: a serie tem que ser tentada de novo', async () => {
    const store = makeStore([show(1, 'ThunderCats')]);

    const report = await enrichMissing(store, dataDir, {
      now: () => AGORA,
      lookup: () => Promise.resolve({ status: 'error', reason: 'ENOTFOUND' }),
    });

    expect(report).toMatchObject({ failed: 1, found: 0, notFound: 0 });
    expect(store.rows.size).toBe(0);
    expect(listShowsMissingMetadata(store, AGORA).map((s) => s.id)).toEqual([1]);
  });

  test('lookup que lanca tem o mesmo tratamento de erro de rede', async () => {
    const store = makeStore([show(1, 'ThunderCats')]);
    const report = await enrichMissing(store, dataDir, {
      now: () => AGORA,
      lookup: () => Promise.reject(new Error('boom')),
    });
    expect(report.failed).toBe(1);
    expect(store.rows.size).toBe(0);
  });

  test('capa que falha ao baixar tambem nao grava linha', async () => {
    // Gravar sem capa selaria o show como resolvido e a imagem nunca mais seria
    // tentada - exatamente o que este projeto quer.
    const store = makeStore([show(1, 'ThunderCats')]);

    const report = await enrichMissing(store, dataDir, {
      now: () => AGORA,
      lookup: () => Promise.resolve(found()),
      download: () => Promise.reject(new Error('502')),
    });

    expect(report.failed).toBe(1);
    expect(store.rows.size).toBe(0);
  });

  test('uma serie quebrada nao derruba as outras', async () => {
    const store = makeStore([show(1, 'Boa'), show(2, 'Ruim'), show(3, 'Boa 2')]);

    const report = await enrichMissing(store, dataDir, {
      now: () => AGORA,
      lookup: (name) =>
        name === 'Ruim'
          ? Promise.resolve<LookupResult>({ status: 'error', reason: 'timeout' })
          : Promise.resolve(found()),
      download: () => Promise.resolve(new Uint8Array([1])),
    });

    expect(report).toMatchObject({ considered: 3, found: 2, failed: 1 });
    expect([...store.rows.keys()].sort()).toEqual([1, 3]);
  });

  test('respeita a concorrencia: no maximo duas buscas em voo', async () => {
    const store = makeStore([1, 2, 3, 4, 5, 6].map((n) => show(n, `Serie ${String(n)}`)));
    let emVoo = 0;
    let pico = 0;

    await enrichMissing(store, dataDir, {
      now: () => AGORA,
      lookup: async () => {
        emVoo += 1;
        pico = Math.max(pico, emVoo);
        await new Promise((r) => setTimeout(r, 1));
        emVoo -= 1;
        return found(null);
      },
    });

    expect(pico).toBe(2);
    expect(store.rows.size).toBe(6);
  });

  test('serie ja resolvida nao e consultada de novo', async () => {
    const store = makeStore([show(1, 'ThunderCats')]);
    const lookup = vi.fn(() => Promise.resolve(found(null)));

    await enrichMissing(store, dataDir, { now: () => AGORA, lookup });
    await enrichMissing(store, dataDir, { now: () => AGORA, lookup });

    expect(lookup).toHaveBeenCalledTimes(1);
  });

  test('not_found so e reconsultado depois do TTL de sete dias', async () => {
    const store = makeStore([show(1, 'Obscura')]);
    const lookup = vi.fn(() => Promise.resolve<LookupResult>({ status: 'not-found' }));

    await enrichMissing(store, dataDir, { now: () => AGORA, lookup });
    await enrichMissing(store, dataDir, { now: () => AGORA + NOT_FOUND_TTL_MS - 1, lookup });
    expect(lookup).toHaveBeenCalledTimes(1);

    await enrichMissing(store, dataDir, { now: () => AGORA + NOT_FOUND_TTL_MS, lookup });
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  test('acervo inteiro ja resolvido nao cria nem o diretorio de capas', async () => {
    const store = makeStore([]);
    const report = await enrichMissing(store, dataDir, { now: () => AGORA });
    expect(report.considered).toBe(0);
    await expect(readdir(join(dataDir, 'posters'))).rejects.toThrow();
  });
});

describe('rebusca funde, nunca sobrescreve', () => {
  /** Linha boa de verdade: capa em disco, ano, sinopse, arte ainda nao procurada. */
  function jaEnriquecida(store: FakeStore, over: Partial<ShowMetadataRow> = {}): void {
    store.rows.set(
      1,
      row(1, {
        posterFile: '1.jpg',
        backdropFile: null,
        backdropCheckedAt: null,
        backdropSource: null,
        year: 1985,
        overview: 'Sinopse boa em portugues.',
        source: 'tmdb',
        notFound: false,
        ...over,
      }),
    );
  }

  /** Escreve a capa que ja estaria em disco de uma rodada anterior. */
  async function capaNoDisco(bytes: number[]): Promise<void> {
    await mkdir(join(dataDir, 'posters'), { recursive: true });
    await writeFile(join(dataDir, 'posters', '1.jpg'), Buffer.from(bytes));
  }

  test('"nao conheco esta serie" nao apaga capa, ano nem sinopse', async () => {
    // O cenario real: acervo enriquecido antes de a arte 16:9 existir, usuario
    // clica em "so o que falta", e o provedor que outrora achou agora nao acha.
    // Sobrescrever aqui seria perda de dado que ninguem pediu.
    const store = makeStore([show(1, 'ThunderCats')]);
    jaEnriquecida(store);
    await capaNoDisco([0xaa]);

    const report = await enrichMissing(
      store,
      dataDir,
      { now: () => AGORA, lookup: () => Promise.resolve<LookupResult>({ status: 'not-found' }) },
      'refresh',
    );

    expect(report.notFound).toBe(1);
    expect(store.rows.get(1)).toMatchObject({
      posterFile: '1.jpg',
      year: 1985,
      overview: 'Sinopse boa em portugues.',
      source: 'tmdb',
      // E continua sendo uma linha BOA: nada de virar not_found.
      notFound: false,
    });
    // O arquivo tambem sobrevive.
    expect(Array.from(await readFile(join(dataDir, 'posters', '1.jpg')))).toEqual([0xaa]);
  });

  test('e a serie sai da fila em vez de voltar a cada clique', async () => {
    const store = makeStore([show(1, 'ThunderCats')]);
    jaEnriquecida(store);
    await capaNoDisco([0xaa]);

    expect(listShowsMissingMetadata(store, AGORA, NOT_FOUND_TTL_MS, 'refresh')).toHaveLength(1);

    await enrichMissing(
      store,
      dataDir,
      {
        now: () => AGORA,
        tmdbApiKey: 'chave-de-teste',
        lookup: () => Promise.resolve<LookupResult>({ status: 'not-found' }),
      },
      'refresh',
    );

    expect(listShowsMissingMetadata(store, AGORA, NOT_FOUND_TTL_MS, 'refresh')).toEqual([]);
  });

  test('provedor mais fraco nao rebaixa a linha nem a capa em disco', async () => {
    // TMDB caiu, TVMaze respondeu com capa. Sem fusao, a sinopse pt-BR viraria
    // ingles e `<showId>.jpg` seria reescrito com a arte pior.
    const store = makeStore([show(1, 'ThunderCats')]);
    jaEnriquecida(store);
    await capaNoDisco([0xaa]);

    const baixados: string[] = [];
    await enrichMissing(
      store,
      dataDir,
      {
        now: () => AGORA,
        lookup: () =>
          Promise.resolve(
            found('https://tvmaze/pior.jpg', {
              source: 'tvmaze',
              year: 1984,
              overview: 'Weaker English summary.',
            }),
          ),
        download: (url) => {
          baixados.push(url);
          return Promise.resolve(new Uint8Array([0xbb]));
        },
      },
      'refresh',
    );

    expect(store.rows.get(1)).toMatchObject({
      posterFile: '1.jpg',
      year: 1985,
      overview: 'Sinopse boa em portugues.',
      source: 'tmdb',
    });
    // Nada foi baixado: a linha ja tinha capa, e o nome do arquivo e o mesmo.
    expect(baixados).toEqual([]);
    expect(Array.from(await readFile(join(dataDir, 'posters', '1.jpg')))).toEqual([0xaa]);
  });

  test('mas o provedor fraco preenche o buraco que a linha tem', async () => {
    // "So o que falta" e aditivo: o que a linha nao tem, ela ganha.
    const store = makeStore([show(1, 'ThunderCats')]);
    jaEnriquecida(store, { overview: null, year: null });
    await capaNoDisco([0xaa]);

    await enrichMissing(
      store,
      dataDir,
      {
        now: () => AGORA,
        lookup: () =>
          Promise.resolve(
            found('https://tvmaze/pior.jpg', {
              source: 'tvmaze',
              year: 1984,
              overview: 'Achei a sinopse.',
              backdropUrl: 'https://img/wide.jpg',
            }),
          ),
        download: () => Promise.resolve(new Uint8Array([0xbb])),
      },
      'refresh',
    );

    expect(store.rows.get(1)).toMatchObject({
      year: 1984,
      overview: 'Achei a sinopse.',
      backdropFile: '1.jpg',
      // A fonte identifica quem estabeleceu a linha, e continua sendo o TMDB.
      source: 'tmdb',
    });
    // A capa velha continua intacta; so a arte 16:9 foi baixada.
    expect(Array.from(await readFile(join(dataDir, 'posters', '1.jpg')))).toEqual([0xaa]);
    expect(Array.from(await readFile(join(dataDir, 'backdrops', '1.jpg')))).toEqual([0xbb]);
  });

  test('serie que o provedor conhece mas nao ilustra sai da fila apos UMA tentativa', async () => {
    const store = makeStore([show(1, 'Animacao antiga')]);
    jaEnriquecida(store);
    await capaNoDisco([0xaa]);

    const lookup = vi.fn(() => Promise.resolve(found('https://img/a.jpg', { source: 'tmdb' })));
    const opcoes = {
      now: () => AGORA,
      tmdbApiKey: 'chave-de-teste',
      lookup,
      download: () => Promise.resolve(new Uint8Array([1])),
    };

    await enrichMissing(store, dataDir, opcoes, 'refresh');
    expect(store.rows.get(1)?.backdropFile).toBeNull();
    expect(store.rows.get(1)?.backdropCheckedAt).toBe(AGORA);

    // Segundo clique no botao: a serie nem entra na fila, entao nao ha consulta.
    await enrichMissing(store, dataDir, opcoes, 'refresh');
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  test('busca INCOMPLETA nao carimba: um provedor fora do ar nao sela a serie', async () => {
    // Se carimbasse, dez minutos de TMDB fora do ar custariam a arte 16:9 para
    // sempre - o predicado do refresh nunca mais ofereceria a serie.
    const store = makeStore([show(1, 'ThunderCats')]);
    jaEnriquecida(store);
    await capaNoDisco([0xaa]);

    await enrichMissing(
      store,
      dataDir,
      {
        now: () => AGORA,
        lookup: () => Promise.resolve(found('https://tvmaze/a.jpg', { source: 'tvmaze' }, true)),
        download: () => Promise.resolve(new Uint8Array([0xbb])),
      },
      'refresh',
    );

    expect(store.rows.get(1)?.backdropCheckedAt).toBeNull();
    expect(listShowsMissingMetadata(store, AGORA, NOT_FOUND_TTL_MS, 'refresh')).toHaveLength(1);
    // E a linha continua intacta enquanto isso.
    expect(store.rows.get(1)).toMatchObject({ source: 'tmdb', year: 1985 });
  });

  test('reset continua apagando: linha zerada e SOBRESCRITA, nao fundida', async () => {
    // E o que o painel grava antes de disparar o "buscar tudo de novo": a linha
    // vira not_found com fetchedAt 0. Nada ali pode ser preservado, senao a
    // capa errada que motivou o reset sobreviveria a ele.
    const store = makeStore([show(1, 'Pasta renomeada')]);
    store.rows.set(
      1,
      row(1, {
        posterFile: null,
        backdropFile: null,
        backdropCheckedAt: null,
        backdropSource: null,
        year: null,
        overview: null,
        source: null,
        fetchedAt: 0,
        notFound: true,
      }),
    );

    await enrichMissing(
      store,
      dataDir,
      {
        now: () => AGORA,
        tmdbApiKey: 'chave-de-teste',
        lookup: () =>
          Promise.resolve(found('https://img/nova.jpg', { source: 'tmdb', overview: 'Serie certa.' })),
        download: () => Promise.resolve(new Uint8Array([0xcc])),
      },
      'refresh',
    );

    expect(store.rows.get(1)).toMatchObject({
      posterFile: '1.jpg',
      overview: 'Serie certa.',
      source: 'tmdb',
      notFound: false,
      backdropCheckedAt: AGORA,
      backdropSource: null,
    });
    expect(Array.from(await readFile(join(dataDir, 'posters', '1.jpg')))).toEqual([0xcc]);
  });

  test('sem TMDB na cadeia, a arte 16:9 NAO e carimbada: a chave pode chegar depois', async () => {
    // Sem chave, so o TVMaze/iTunes respondem - e eles nunca tem arte 16:9.
    // Carimbar aqui transformaria "depois eu ponho a chave" em estado
    // permanente: o refresh nunca mais ofereceria a serie.
    const store = makeStore([show(1, 'ThunderCats')]);

    await enrichMissing(store, dataDir, {
      now: () => AGORA,
      lookup: () => Promise.resolve(found()),
      download: () => Promise.resolve(new Uint8Array([0xaa])),
    });

    expect(store.rows.get(1)?.backdropCheckedAt).toBeNull();
    // Chave configurada, "so o que falta" clicado: a serie volta para a fila.
    expect(listShowsMissingMetadata(store, AGORA, NOT_FOUND_TTL_MS, 'refresh')).toHaveLength(1);
  });

  test('serie encontrada SEM capa continua no escopo refresh, nunca selada', async () => {
    const store = makeStore([show(1, 'Obscura')]);

    await enrichMissing(store, dataDir, {
      now: () => AGORA,
      tmdbApiKey: 'chave-de-teste',
      lookup: () => Promise.resolve(found(null)),
    });

    expect(store.rows.get(1)).toMatchObject({ posterFile: null, notFound: false });
    // A rodada automatica nao insiste, mas o botao "so o que falta" reoferece.
    expect(listShowsMissingMetadata(store, AGORA, NOT_FOUND_TTL_MS, 'missing')).toEqual([]);
    expect(listShowsMissingMetadata(store, AGORA, NOT_FOUND_TTL_MS, 'refresh')).toHaveLength(1);
  });

  test('capa que sumiu do CDN (404) grava a linha em vez de re-tentar toda rodada', async () => {
    const store = makeStore([show(1, 'ThunderCats')]);

    const report = await enrichMissing(store, dataDir, {
      now: () => AGORA,
      tmdbApiKey: 'chave-de-teste',
      lookup: () => Promise.resolve(found()),
      download: (url) => Promise.reject(new ImageGoneError(url)),
    });

    // Nao e falha de rede: a linha foi gravada (sem capa) e a serie sai da
    // fila automatica - sem isto, toda abertura do catalogo bateria na mesma
    // URL morta para sempre.
    expect(report.failed).toBe(0);
    expect(store.rows.get(1)).toMatchObject({ posterFile: null, notFound: false });
    expect(listShowsMissingMetadata(store, AGORA, NOT_FOUND_TTL_MS, 'missing')).toEqual([]);
  });

  test('not-found numa serie NOVA continua virando linha marcada', async () => {
    // A fusao nao pode ter estragado o caminho original: sem linha anterior,
    // "nao conheco" ainda tem que virar registro, senao o provedor e consultado
    // de novo a cada abertura do catalogo.
    const store = makeStore([show(1, 'Nunca vista')]);

    await enrichMissing(store, dataDir, {
      now: () => AGORA,
      lookup: () => Promise.resolve<LookupResult>({ status: 'not-found' }),
    });

    expect(store.rows.get(1)).toMatchObject({ notFound: true, posterFile: null });
    expect(listShowsMissingMetadata(store, AGORA)).toEqual([]);
  });
});

describe('createEnricher', () => {
  test('duas chamadas concorrentes viram UMA rodada', async () => {
    // Sem isto, uma tela de canais que recarrega sozinha abriria uma varredura
    // por carga e o provedor responderia 429 para o acervo inteiro.
    const store = makeStore([show(1, 'ThunderCats'), show(2, 'He-Man')]);
    const lookup = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return found(null);
    });
    const enricher = createEnricher(store, dataDir, { now: () => AGORA, lookup });

    const a = enricher.run();
    const b = enricher.run();
    enricher.trigger();

    expect(enricher.running).toBe(true);
    await Promise.all([a, b]);

    expect(lookup).toHaveBeenCalledTimes(2); // duas series, uma busca cada
    expect(enricher.running).toBe(false);
  });

  test('a rodada seguinte, depois que a primeira termina, pega o que sobrou', async () => {
    const store = makeStore([show(1, 'ThunderCats')]);
    let tentativas = 0;
    const enricher = createEnricher(store, dataDir, {
      now: () => AGORA,
      lookup: () => {
        tentativas += 1;
        return Promise.resolve<LookupResult>(
          tentativas === 1 ? { status: 'error', reason: 'timeout' } : found(null),
        );
      },
    });

    await enricher.run();
    expect(store.rows.size).toBe(0);

    await enricher.run();
    expect(store.rows.get(1)?.notFound).toBe(false);
    expect(tentativas).toBe(2);
  });

  test('last e null ate a primeira rodada terminar, depois guarda o resumo', async () => {
    // E daqui que o painel tira "a ultima busca de capa achou N": o controlador
    // nao acompanha a rodada que a rota de canais disparou sozinha.
    const store = makeStore([show(1, 'ThunderCats'), show(2, 'He-Man')]);
    const enricher = createEnricher(store, dataDir, {
      now: () => AGORA,
      lookup: () => Promise.resolve(found(null)),
    });

    expect(enricher.last).toBeNull();

    await enricher.run();
    expect(enricher.last).toMatchObject({ considered: 2, found: 2, notFound: 0, failed: 0 });

    // Rodada seguinte sem nada a fazer: o resumo acompanha, nao congela no
    // melhor resultado.
    await enricher.run();
    expect(enricher.last?.considered).toBe(0);
  });

  test('trigger nao propaga erro para quem chamou', async () => {
    const store = makeStore([show(1, 'ThunderCats')]);
    const enricher = createEnricher(store, dataDir, {
      now: () => AGORA,
      // Explode fora do laco por serie, no proprio listShows: o pior caso.
      lookup: () => Promise.reject(new Error('boom')),
    });

    expect(() => {
      enricher.trigger();
    }).not.toThrow();
    await enricher.run();
  });
});
