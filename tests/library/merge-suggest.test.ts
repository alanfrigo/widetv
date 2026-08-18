import { describe, expect, test } from 'vitest';

import type { ShowRow } from '../../src/server/library/index-store';
import { suggestMerges } from '../../src/server/library/merge-suggest';

function show(id: number, slug: string, name: string): ShowRow {
  return { id, slug, name, channelNumber: id, absolutePath: `/lib/${name}` };
}

describe('suggestMerges', () => {
  test('mesmo nome vira sugestao, com o maior acervo como alvo', () => {
    const shows = [
      show(1, 'os-simpsons', 'Os Simpsons'),
      show(2, 'os-simpsons-a1b2c3', 'Os Simpsons'),
    ];
    const counts = new Map([
      [1, 300],
      [2, 20],
    ]);

    expect(suggestMerges(shows, counts)).toEqual([
      { reason: 'nome-identico', showIds: [1, 2] },
    ]);
  });

  test('anos explicitos diferentes nao sao sugeridos', () => {
    const shows = [show(1, 'doctor-who-1963', 'Doctor Who (1963)'), show(2, 'doctor-who-2005', 'Doctor Who (2005)')];

    expect(suggestMerges(shows, new Map())).toEqual([]);
  });

  test('slug com sufixo de digest agrupa mesmo com nome diferente', () => {
    const shows = [show(1, 'tom-e-jerry', 'Tom e Jerry'), show(2, 'tom-e-jerry-9f8e7d', 'Tom & Jerry')];

    expect(suggestMerges(shows, new Map())).toEqual([
      { reason: 'slug-parecido', showIds: [1, 2] },
    ]);
  });

  test('serie sozinha nao vira sugestao', () => {
    expect(suggestMerges([show(1, 'a', 'A')], new Map())).toEqual([]);
  });
});
