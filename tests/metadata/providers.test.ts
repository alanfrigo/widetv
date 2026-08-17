import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  cleanShowName,
  downloadImage,
  fetchFromItunes,
  fetchFromTmdb,
  fetchFromTvmaze,
  imageUrlAllowed,
  lookupShowMetadata,
  searchShowCandidates,
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
      backdropUrl: null,
      year: 1985,
      overview: 'Os felinos fogem de Thundera.',
      source: 'tvmaze',
    });
  });

  test('nunca devolve arte 16:9: o provedor nao tem uma', async () => {
    stubFetch({ 'api.tvmaze.com': () => json(TVMAZE_HIT) });
    expect((await fetchFromTvmaze('ThunderCats'))?.backdropUrl).toBeNull();
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
      backdropUrl: null,
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
  test('monta as URLs de poster e arte 16:9 e pede pt-BR', async () => {
    const calls = stubFetch({
      'api.themoviedb.org': () =>
        json({
          results: [
            {
              poster_path: '/abc.jpg',
              backdrop_path: '/wide.jpg',
              overview: 'Sinopse em portugues.',
              first_air_date: '1985-01-23',
            },
          ],
        }),
    });

    const result = await fetchFromTmdb('ThunderCats', 'chave-secreta');

    expect(result).toEqual({
      posterUrl: 'https://image.tmdb.org/t/p/w500/abc.jpg',
      backdropUrl: 'https://image.tmdb.org/t/p/w1280/wide.jpg',
      year: 1985,
      overview: 'Sinopse em portugues.',
      source: 'tmdb',
    });
    expect(calls[0]).toContain('language=pt-BR');
    expect(calls[0]).toContain('api_key=chave-secreta');
    // As duas artes saem da MESMA resposta: nada de request extra por causa do fundo.
    expect(calls).toHaveLength(1);
  });

  test('serie sem backdrop_path devolve backdropUrl null, sem afetar a capa', async () => {
    stubFetch({
      'api.themoviedb.org': () => json({ results: [{ poster_path: '/abc.jpg' }] }),
    });

    const result = await fetchFromTmdb('ThunderCats', 'k');
    expect(result?.backdropUrl).toBeNull();
    expect(result?.posterUrl).toBe('https://image.tmdb.org/t/p/w500/abc.jpg');
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
        backdropUrl: null,
        year: 1985,
        overview: 'Os felinos fogem de Thundera.',
        source: 'tvmaze',
      },
      // Ninguem caiu no caminho: a busca foi completa.
      providerFailed: false,
      failureReason: null,
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
    // E o resultado sai marcado como INCOMPLETO: o unico provedor com arte 16:9
    // nao respondeu, entao quem grava nao pode selar a serie como "sem arte".
    expect(result.status === 'found' && result.providerFailed).toBe(true);
  });

  test('providerFailed e false quando o TMDB simplesmente nao conhece a serie', async () => {
    // Diferente de "caiu": o TMDB respondeu, e a resposta foi "nao tenho". Isso
    // e definitivo, e a serie pode sair da fila da arte 16:9 para sempre.
    stubFetch({
      'api.themoviedb.org': () => json({ results: [] }),
      'api.tvmaze.com': () => json(TVMAZE_HIT),
    });

    const result = await lookupShowMetadata('ThunderCats', { tmdbApiKey: 'k' });

    expect(result.status === 'found' && result.metadata.source).toBe('tvmaze');
    expect(result.status === 'found' && result.providerFailed).toBe(false);
  });

  test('provedor que cai antes de um fallback SEM capa tambem marca providerFailed', async () => {
    // O outro caminho de `found`: ninguem trouxe capa, e o que sobrou veio do
    // acumulador. A falha anterior nao pode se perder nesse ramo.
    stubFetch({
      'api.themoviedb.org': () => json({}, 503),
      'api.tvmaze.com': () => json({ ...TVMAZE_HIT, image: null }),
      'itunes.apple.com': () => json({ resultCount: 0, results: [] }),
    });

    const result = await lookupShowMetadata('ThunderCats', { tmdbApiKey: 'k' });

    expect(result.status).toBe('found');
    expect(result.status === 'found' && result.providerFailed).toBe(true);
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

describe('searchShowCandidates', () => {
  test('junta os tres provedores e mantem a ordem da cadeia', async () => {
    const fetchDouble = vi.fn(async (url: string) => {
      if (url.includes('themoviedb')) {
        return json({
          results: [
            {
              id: 1,
              name: 'Serie TMDB',
              first_air_date: '1989-12-17',
              overview: 'a',
              poster_path: '/p.jpg',
              backdrop_path: '/b.jpg',
            },
          ],
        });
      }
      if (url.includes('tvmaze')) {
        return json([
          {
            show: {
              id: 2,
              name: 'Serie TVMaze',
              premiered: '1990-01-01',
              summary: '<p>b</p>',
              image: { original: 'https://static.tvmaze.com/x.jpg' },
            },
          },
        ]);
      }
      return json({ results: [] });
    });

    const candidates = await searchShowCandidates('serie', {
      fetch: fetchDouble,
      tmdbApiKey: 'chave',
    });

    expect(candidates.map((c) => c.source)).toEqual(['tmdb', 'tvmaze']);
    expect(candidates[0]?.posterUrl).toBe('https://image.tmdb.org/t/p/w500/p.jpg');
    expect(candidates[0]?.backdropUrl).toBe('https://image.tmdb.org/t/p/w1280/b.jpg');
    expect(candidates[1]?.overview).toBe('b');
    expect(candidates[1]?.year).toBe(1990);
  });

  test('provedor que cai nao zera a lista dos outros', async () => {
    const fetchDouble = vi.fn(async (url: string) => {
      if (url.includes('tvmaze')) throw new Error('rede fora');
      if (url.includes('themoviedb')) {
        return json({ results: [{ id: 1, name: 'Serie', first_air_date: '2000-01-01' }] });
      }
      return json({ results: [] });
    });

    const candidates = await searchShowCandidates('serie', {
      fetch: fetchDouble,
      tmdbApiKey: 'chave',
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.source).toBe('tmdb');
  });

  test('termo vazio nao chama provedor nenhum', async () => {
    const fetchDouble = vi.fn();
    expect(await searchShowCandidates('   ', { fetch: fetchDouble })).toEqual([]);
    expect(fetchDouble).not.toHaveBeenCalled();
  });
});

describe('imageUrlAllowed', () => {
  test('aceita so os hosts dos provedores, em https', () => {
    expect(imageUrlAllowed('https://image.tmdb.org/t/p/w500/x.jpg')).toBe(true);
    expect(imageUrlAllowed('https://static.tvmaze.com/uploads/x.jpg')).toBe(true);
    expect(imageUrlAllowed('https://is1-ssl.mzstatic.com/image/x.jpg')).toBe(true);
  });

  test('recusa host interno, http e lixo', () => {
    expect(imageUrlAllowed('http://image.tmdb.org/x.jpg')).toBe(false);
    expect(imageUrlAllowed('https://169.254.169.254/latest/meta-data/')).toBe(false);
    expect(imageUrlAllowed('https://evil.com/image.tmdb.org/x.jpg')).toBe(false);
    expect(imageUrlAllowed('file:///etc/passwd')).toBe(false);
    expect(imageUrlAllowed('nao e url')).toBe(false);
  });

  // Casos abaixo nao vem do brief original: cobrem truques classicos de host
  // parecido, que sao exatamente o que a allowlist existe para barrar.
  test('recusa host com o nome do provedor colado como sufixo ou subdominio falso', () => {
    // Subdominio de um dominio que o atacante controla.
    expect(imageUrlAllowed('https://image.tmdb.org.evil.com/x.jpg')).toBe(false);
    // Sufixo colado sem ponto: nao pode casar com o `.mzstatic.com`.
    expect(imageUrlAllowed('https://evilmzstatic.com/x.jpg')).toBe(false);
  });

  test('recusa truque de userinfo com o host de verdade antes do arroba', () => {
    // O host real desta URL e "evil.com"; "image.tmdb.org" aqui e so o
    // usuario do Basic Auth, nunca o destino da requisicao.
    expect(imageUrlAllowed('https://image.tmdb.org@evil.com/x.jpg')).toBe(false);
  });

  test('host em maiusculas ainda e o provedor de verdade: aceita', () => {
    // DNS e case-insensitive e o parser de URL normaliza para minusculas;
    // recusar aqui so quebraria uma URL legitima sem ganhar seguranca nenhuma.
    expect(imageUrlAllowed('https://IMAGE.TMDB.ORG/t/p/w500/x.jpg')).toBe(true);
  });

  test('ponto final no host nao bate com a allowlist: recusa', () => {
    // "image.tmdb.org." e o mesmo host em DNS, mas a comparacao e exata e por
    // texto - fica de fora por seguranca, nao ha motivo pratico para aceitar.
    expect(imageUrlAllowed('https://image.tmdb.org./x.jpg')).toBe(false);
  });
});
