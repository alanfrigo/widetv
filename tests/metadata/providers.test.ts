import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  cleanShowName,
  downloadImage,
  fetchFromItunes,
  fetchFromTmdb,
  fetchFromTvmaze,
  lookupShowMetadata,
  stripHtml,
} from '../../src/server/metadata/providers';

/**
 * Todos os provedores sao exercitados com `fetch` dublado. O objetivo nao e
 * "testar a rede": e fixar as tres decisoes que o resto do sistema depende -
 * quem responde primeiro, o que conta como "nao achei" e o que conta como
 * "falhou", porque so o segundo pode virar registro no indice.
 */

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Duble de fetch que responde por trecho de URL e registra o que foi pedido. */
function stubFetch(routes: Record<string, () => Response | Promise<Response>>): string[] {
  const calls: string[] = [];
  vi.stubGlobal('fetch', (url: string) => {
    calls.push(url);
    for (const [fragment, respond] of Object.entries(routes)) {
      if (url.includes(fragment)) return Promise.resolve(respond());
    }
    throw new Error(`URL inesperada no teste: ${url}`);
  });
  return calls;
}

const TVMAZE_HIT = {
  name: 'ThunderCats',
  premiered: '1985-01-23',
  summary: '<p>Os <b>felinos</b> fogem de Thundera.</p>',
  image: { medium: 'https://img/medium.jpg', original: 'https://img/original.jpg' },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('cleanShowName', () => {
  test('tira o sufixo de ano entre parenteses', () => {
    // O acervo usa "(1989)" para separar remakes; provedor nenhum entende isso.
    expect(cleanShowName('Batman (1989)')).toBe('Batman');
    expect(cleanShowName('Cowboy Bebop (1998-1999)')).toBe('Cowboy Bebop');
  });

  test('nao tira parenteses que fazem parte do nome', () => {
    expect(cleanShowName('Batman (Serie Animada)')).toBe('Batman (Serie Animada)');
    expect(cleanShowName('Doctor Who (2005) Especiais')).toBe('Doctor Who (2005) Especiais');
  });

  test('normaliza espaco', () => {
    expect(cleanShowName('  He-Man   e  os  Mestres ')).toBe('He-Man e os Mestres');
  });
});

describe('stripHtml', () => {
  test('tira as tags e devolve texto puro', () => {
    expect(stripHtml('<p>Os <b>felinos</b> fogem.</p>')).toBe('Os felinos fogem.');
  });

  test('resolve as entidades comuns', () => {
    expect(stripHtml('<p>Tom &amp; Jerry &quot;classico&quot;</p>')).toBe('Tom & Jerry "classico"');
  });

  test('quebra de linha vira espaco, nao cola as palavras', () => {
    expect(stripHtml('<p>Primeira</p><p>Segunda</p>')).toBe('Primeira Segunda');
    expect(stripHtml('Primeira<br>Segunda')).toBe('Primeira Segunda');
  });
});

describe('TVMaze', () => {
  test('devolve capa, ano e sinopse sem HTML', async () => {
    stubFetch({ 'api.tvmaze.com': () => json(TVMAZE_HIT) });

    const result = await fetchFromTvmaze('ThunderCats');

    expect(result).toEqual({
      posterUrl: 'https://img/original.jpg',
      year: 1985,
      overview: 'Os felinos fogem de Thundera.',
      source: 'tvmaze',
    });
  });

  test('cai para a imagem media quando nao ha original', async () => {
    stubFetch({
      'api.tvmaze.com': () => json({ ...TVMAZE_HIT, image: { medium: 'https://img/m.jpg' } }),
    });
    expect((await fetchFromTvmaze('x'))?.posterUrl).toBe('https://img/m.jpg');
  });

  test('404 e "nao conheco", nao erro', async () => {
    stubFetch({ 'api.tvmaze.com': () => json({}, 404) });
    expect(await fetchFromTvmaze('serie que nao existe')).toBeNull();
  });

  test('500 lanca: e temporario e nao pode virar "nao existe"', async () => {
    stubFetch({ 'api.tvmaze.com': () => json({}, 500) });
    await expect(fetchFromTvmaze('x')).rejects.toThrow(/500/);
  });

  test('o nome vai percent-encoded na query', async () => {
    const calls = stubFetch({ 'api.tvmaze.com': () => json(TVMAZE_HIT) });
    await fetchFromTvmaze('Tom & Jerry');
    expect(calls[0]).toContain('q=Tom%20%26%20Jerry');
  });
});

describe('iTunes', () => {
  test('troca a miniatura de 100px pela arte de 600px', async () => {
    stubFetch({
      'itunes.apple.com': () =>
        json({
          resultCount: 1,
          results: [
            {
              artworkUrl100: 'https://is1.mzstatic.com/image/thumb/abc/100x100bb.jpg',
              releaseDate: '1985-01-23T08:00:00Z',
              longDescription: 'Descricao longa.',
            },
          ],
        }),
    });

    expect(await fetchFromItunes('ThunderCats')).toEqual({
      posterUrl: 'https://is1.mzstatic.com/image/thumb/abc/600x600bb.jpg',
      year: 1985,
      overview: 'Descricao longa.',
      source: 'itunes',
    });
  });

  test('sem resultado em tvShow, tenta media=movie', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      calls.push(url);
      if (url.includes('media=tvShow')) return Promise.resolve(json({ resultCount: 0, results: [] }));
      return Promise.resolve(
        json({ resultCount: 1, results: [{ artworkUrl100: 'https://a/100x100.jpg' }] }),
      );
    });

    const result = await fetchFromItunes('Akira');

    expect(calls.some((u) => u.includes('media=movie'))).toBe(true);
    expect(result?.posterUrl).toBe('https://a/600x600.jpg');
  });

  test('nem serie nem filme: null', async () => {
    stubFetch({ 'itunes.apple.com': () => json({ resultCount: 0, results: [] }) });
    expect(await fetchFromItunes('nada')).toBeNull();
  });
});

describe('TMDB', () => {
  test('monta a URL do poster e pede pt-BR', async () => {
    const calls = stubFetch({
      'api.themoviedb.org': () =>
        json({
          results: [
            { poster_path: '/abc.jpg', overview: 'Sinopse em portugues.', first_air_date: '1985-01-23' },
          ],
        }),
    });

    const result = await fetchFromTmdb('ThunderCats', 'chave-secreta');

    expect(result).toEqual({
      posterUrl: 'https://image.tmdb.org/t/p/w500/abc.jpg',
      year: 1985,
      overview: 'Sinopse em portugues.',
      source: 'tmdb',
    });
    expect(calls[0]).toContain('language=pt-BR');
    expect(calls[0]).toContain('api_key=chave-secreta');
  });

  test('lista vazia e null', async () => {
    stubFetch({ 'api.themoviedb.org': () => json({ results: [] }) });
    expect(await fetchFromTmdb('x', 'k')).toBeNull();
  });
});

describe('cadeia de provedores', () => {
  test('TVMaze respondendo com capa encerra a busca', async () => {
    const calls = stubFetch({ 'api.tvmaze.com': () => json(TVMAZE_HIT) });

    const result = await lookupShowMetadata('ThunderCats (1985)');

    expect(result).toEqual({
      status: 'found',
      metadata: {
        posterUrl: 'https://img/original.jpg',
        year: 1985,
        overview: 'Os felinos fogem de Thundera.',
        source: 'tvmaze',
      },
    });
    // Uma chamada so: o iTunes nem foi consultado.
    expect(calls).toHaveLength(1);
    // E o ano entre parenteses nao foi junto na busca.
    expect(calls[0]).toContain('q=ThunderCats');
    expect(calls[0]).not.toContain('1985');
  });

  test('TVMaze sem resultado cai no iTunes', async () => {
    stubFetch({
      'api.tvmaze.com': () => json({}, 404),
      'itunes.apple.com': () =>
        json({ resultCount: 1, results: [{ artworkUrl100: 'https://a/100x100.jpg' }] }),
    });

    const result = await lookupShowMetadata('Serie obscura');

    expect(result.status).toBe('found');
    expect(result.status === 'found' && result.metadata.source).toBe('itunes');
  });

  test('provedor sem capa nao encerra a cadeia, mas o que ele achou nao se perde', async () => {
    stubFetch({
      'api.tvmaze.com': () => json({ ...TVMAZE_HIT, image: null }),
      'itunes.apple.com': () => json({ resultCount: 0, results: [] }),
    });

    const result = await lookupShowMetadata('Serie sem arte');

    expect(result.status).toBe('found');
    expect(result.status === 'found' && result.metadata.posterUrl).toBeNull();
    expect(result.status === 'found' && result.metadata.overview).toBe(
      'Os felinos fogem de Thundera.',
    );
  });

  test('todos dizem que nao conhecem: not-found', async () => {
    stubFetch({
      'api.tvmaze.com': () => json({}, 404),
      'itunes.apple.com': () => json({ resultCount: 0, results: [] }),
    });

    expect(await lookupShowMetadata('nao existe')).toEqual({ status: 'not-found' });
  });

  test('rede fora do ar vira error, nunca not-found', async () => {
    // A diferenca decide se o indice guarda "nao existe" por sete dias ou se
    // tenta de novo na proxima rodada.
    vi.stubGlobal('fetch', () => Promise.reject(new Error('getaddrinfo ENOTFOUND')));

    const result = await lookupShowMetadata('ThunderCats');

    expect(result.status).toBe('error');
    expect(result.status === 'error' && result.reason).toMatch(/ENOTFOUND/);
  });

  test('um provedor fora do ar e outro sem resultado ainda e error', async () => {
    stubFetch({
      'api.tvmaze.com': () => json({}, 503),
      'itunes.apple.com': () => json({ resultCount: 0, results: [] }),
    });
    expect((await lookupShowMetadata('x')).status).toBe('error');
  });

  test('sem TMDB_API_KEY o TMDB nem e consultado', async () => {
    const calls = stubFetch({ 'api.tvmaze.com': () => json(TVMAZE_HIT) });
    await lookupShowMetadata('ThunderCats');
    expect(calls.some((u) => u.includes('themoviedb'))).toBe(false);
  });

  test('com chave, o TMDB vem primeiro', async () => {
    const calls = stubFetch({
      'api.themoviedb.org': () => json({ results: [{ poster_path: '/p.jpg', overview: 'oi' }] }),
      'api.tvmaze.com': () => json(TVMAZE_HIT),
    });

    const result = await lookupShowMetadata('ThunderCats', { tmdbApiKey: 'k' });

    expect(result.status === 'found' && result.metadata.source).toBe('tmdb');
    expect(calls).toHaveLength(1);
  });

  test('TMDB com chave invalida nao impede a capa: a cadeia continua', async () => {
    stubFetch({
      'api.themoviedb.org': () => json({ status_message: 'Invalid API key' }, 401),
      'api.tvmaze.com': () => json(TVMAZE_HIT),
    });

    const result = await lookupShowMetadata('ThunderCats', { tmdbApiKey: 'errada' });

    expect(result.status === 'found' && result.metadata.source).toBe('tvmaze');
  });

  test('nome que sobra vazio depois da limpeza nao vira request', async () => {
    const calls = stubFetch({ '': () => json(TVMAZE_HIT) });
    expect(await lookupShowMetadata('   ')).toEqual({ status: 'not-found' });
    expect(calls).toHaveLength(0);
  });
});

describe('downloadImage', () => {
  test('devolve os bytes da capa', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(new Uint8Array([1, 2, 3]))));
    expect(Array.from(await downloadImage('https://img/a.jpg'))).toEqual([1, 2, 3]);
  });

  test('status ruim lanca', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('', { status: 403 })));
    await expect(downloadImage('https://img/a.jpg')).rejects.toThrow(/403/);
  });

  test('corpo vazio lanca em vez de gravar um arquivo de 0 byte', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(new Uint8Array([]))));
    await expect(downloadImage('https://img/a.jpg')).rejects.toThrow(/vazia/);
  });
});
