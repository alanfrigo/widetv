import { describe, expect, test } from 'vitest';
import { parseDisplayMode } from '../../src/web/display-mode';

/**
 * O modo novo so entra quando o servidor pede exatamente por ele. Qualquer
 * duvida - servidor velho, resposta estranha, campo faltando - vale CRT, que e
 * o modo que sempre funcionou.
 */
describe('parseDisplayMode', () => {
  test('"widescreen" exato liga o modo novo', () => {
    expect(parseDisplayMode('widescreen')).toBe('widescreen');
  });

  test('"crt" continua crt', () => {
    expect(parseDisplayMode('crt')).toBe('crt');
  });

  test('caixa diferente nao vale: o contrato serve minuscula', () => {
    expect(parseDisplayMode('Widescreen')).toBe('crt');
    expect(parseDisplayMode('WIDESCREEN')).toBe('crt');
  });

  test('espaco em volta nao vale', () => {
    expect(parseDisplayMode(' widescreen')).toBe('crt');
    expect(parseDisplayMode('widescreen ')).toBe('crt');
  });

  test('campo ausente cai em crt', () => {
    expect(parseDisplayMode(undefined)).toBe('crt');
  });

  test('null cai em crt', () => {
    expect(parseDisplayMode(null)).toBe('crt');
  });

  test('tipo errado cai em crt', () => {
    expect(parseDisplayMode(42)).toBe('crt');
    expect(parseDisplayMode(true)).toBe('crt');
  });

  test('objeto inteiro no lugar do campo cai em crt', () => {
    expect(parseDisplayMode({ displayMode: 'widescreen' })).toBe('crt');
    expect(parseDisplayMode(['widescreen'])).toBe('crt');
  });

  test('valor desconhecido cai em crt, sem lancar', () => {
    expect(parseDisplayMode('holograma')).toBe('crt');
    expect(parseDisplayMode('')).toBe('crt');
  });
});
