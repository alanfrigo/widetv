import { describe, expect, test } from 'vitest';
import { parseRangeHeader } from '../../src/server/stream/range';

const SIZE = 1000;

describe('parseRangeHeader', () => {
  test('sem header serve o arquivo inteiro', () => {
    expect(parseRangeHeader(undefined, SIZE)).toEqual({ kind: 'full' });
  });

  test('faixa fechada vira start e end inclusivos', () => {
    expect(parseRangeHeader('bytes=0-499', SIZE)).toEqual({ kind: 'partial', start: 0, end: 499 });
  });

  test('faixa aberta no fim vai ate o ultimo byte', () => {
    expect(parseRangeHeader('bytes=500-', SIZE)).toEqual({ kind: 'partial', start: 500, end: 999 });
  });

  test('sufixo pede os ultimos N bytes', () => {
    expect(parseRangeHeader('bytes=-300', SIZE)).toEqual({ kind: 'partial', start: 700, end: 999 });
  });

  test('sufixo maior que o arquivo devolve o arquivo inteiro como faixa', () => {
    expect(parseRangeHeader('bytes=-5000', SIZE)).toEqual({ kind: 'partial', start: 0, end: 999 });
  });

  test('end alem do fim e truncado, nao rejeitado', () => {
    expect(parseRangeHeader('bytes=900-99999', SIZE)).toEqual({ kind: 'partial', start: 900, end: 999 });
  });

  test('start alem do fim e insatisfazivel', () => {
    expect(parseRangeHeader('bytes=1000-', SIZE)).toEqual({ kind: 'unsatisfiable' });
  });

  test('start maior que end e insatisfazivel', () => {
    expect(parseRangeHeader('bytes=500-400', SIZE)).toEqual({ kind: 'unsatisfiable' });
  });

  test('sufixo zero e insatisfazivel', () => {
    expect(parseRangeHeader('bytes=-0', SIZE)).toEqual({ kind: 'unsatisfiable' });
  });

  test('arquivo vazio nao aceita nenhuma faixa', () => {
    expect(parseRangeHeader('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' });
  });

  test('unidade diferente de bytes e ignorada', () => {
    expect(parseRangeHeader('items=0-10', SIZE)).toEqual({ kind: 'full' });
  });

  test('header malformado e ignorado em vez de derrubar o request', () => {
    expect(parseRangeHeader('bytes=abc', SIZE)).toEqual({ kind: 'full' });
    expect(parseRangeHeader('bytes=', SIZE)).toEqual({ kind: 'full' });
    expect(parseRangeHeader('bytes=-', SIZE)).toEqual({ kind: 'full' });
    expect(parseRangeHeader('lixo', SIZE)).toEqual({ kind: 'full' });
  });

  test('multiplas faixas nao sao suportadas: serve so a primeira', () => {
    // Multipart byteranges nao vale a complexidade para reproducao de video.
    expect(parseRangeHeader('bytes=0-99,200-299', SIZE)).toEqual({
      kind: 'partial',
      start: 0,
      end: 99,
    });
  });

  test('espacos em volta sao tolerados', () => {
    expect(parseRangeHeader('bytes = 10 - 20 ', SIZE)).toEqual({
      kind: 'partial',
      start: 10,
      end: 20,
    });
  });

  test('numero absurdo nao vira NaN nem Infinity', () => {
    const r = parseRangeHeader('bytes=99999999999999999999-', SIZE);
    expect(r).toEqual({ kind: 'unsatisfiable' });
  });
});
