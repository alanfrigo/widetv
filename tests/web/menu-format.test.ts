import { describe, expect, test } from 'vitest';
import { formatDurationMin, resolutionBadge } from '../../src/web/menu-format';

describe('resolutionBadge', () => {
  test('4K pelo par completo', () => {
    expect(resolutionBadge(3840, 2160)).toBe('4K');
  });

  test('1080p pelo par completo', () => {
    expect(resolutionBadge(1920, 1080)).toBe('1080p');
  });

  test('720p pelo par completo', () => {
    expect(resolutionBadge(1280, 720)).toBe('720p');
  });

  test('acervo antigo 704x396 e SD', () => {
    expect(resolutionBadge(704, 396)).toBe('SD');
  });

  test('so a largura: a altura sai do 16:9', () => {
    expect(resolutionBadge(3840, null)).toBe('4K');
    expect(resolutionBadge(1920, null)).toBe('1080p');
    expect(resolutionBadge(1280, null)).toBe('720p');
    expect(resolutionBadge(640, null)).toBe('SD');
  });

  test('so a altura manda direto', () => {
    expect(resolutionBadge(null, 2160)).toBe('4K');
    expect(resolutionBadge(null, 1080)).toBe('1080p');
    expect(resolutionBadge(null, 720)).toBe('720p');
    expect(resolutionBadge(null, 480)).toBe('SD');
  });

  test('sem nenhuma das duas nao inventa selo', () => {
    expect(resolutionBadge(null, null)).toBeNull();
    expect(resolutionBadge()).toBeNull();
    expect(resolutionBadge(undefined, undefined)).toBeNull();
  });

  test('altura manda quando as duas existem: material anamorfico nao vira 4K', () => {
    // 1440x1080 e 4:3 em 1080 linhas; pela largura cairia em 720p.
    expect(resolutionBadge(1440, 1080)).toBe('1080p');
  });

  test('faixa 2K de cinema conta como 1080p, nao como 4K', () => {
    expect(resolutionBadge(1998, 1080)).toBe('1080p');
  });

  test('1080 cortado por barra preta ainda conta como 1080p', () => {
    expect(resolutionBadge(1920, 1052)).toBe('1080p');
  });

  test('numero invalido e tratado como ausente', () => {
    expect(resolutionBadge(0, 0)).toBeNull();
    expect(resolutionBadge(-1, null)).toBeNull();
    expect(resolutionBadge(Number.NaN, Number.NaN)).toBeNull();
    expect(resolutionBadge(1920, 0)).toBe('1080p');
  });
});

describe('formatDurationMin', () => {
  test('meia hora de desenho vira o numero redondo', () => {
    expect(formatDurationMin(22 * 60_000)).toBe('22 MIN');
  });

  test('arredonda para o minuto mais proximo', () => {
    expect(formatDurationMin(22 * 60_000 + 29_000)).toBe('22 MIN');
    expect(formatDurationMin(22 * 60_000 + 31_000)).toBe('23 MIN');
  });

  test('episodio curto nunca vira zero minuto', () => {
    expect(formatDurationMin(20_000)).toBe('1 MIN');
  });

  test('duracao desconhecida nao mente sobre o tempo', () => {
    expect(formatDurationMin(0)).toBe('0 MIN');
    expect(formatDurationMin(-5)).toBe('0 MIN');
    expect(formatDurationMin(Number.NaN)).toBe('0 MIN');
  });
});
