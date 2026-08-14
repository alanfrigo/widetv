import { describe, expect, test } from 'vitest';
import { decideOnEnded } from '../../src/web/vod';

describe('decideOnEnded', () => {
  test('no meio da serie, emenda no proximo episodio', () => {
    expect(decideOnEnded(0, 3)).toEqual({ type: 'next', index: 1 });
    expect(decideOnEnded(1, 3)).toEqual({ type: 'next', index: 2 });
  });

  test('no ultimo episodio, volta para a grade ao vivo', () => {
    expect(decideOnEnded(2, 3)).toEqual({ type: 'backToLive' });
  });

  test('episodio unico volta para a grade', () => {
    expect(decideOnEnded(0, 1)).toEqual({ type: 'backToLive' });
  });

  test('lista vazia volta para a grade em vez de tocar indice inexistente', () => {
    expect(decideOnEnded(0, 0)).toEqual({ type: 'backToLive' });
  });

  test('indice fora da lista volta para a grade', () => {
    expect(decideOnEnded(9, 3)).toEqual({ type: 'backToLive' });
    expect(decideOnEnded(-1, 3)).toEqual({ type: 'backToLive' });
  });
});
