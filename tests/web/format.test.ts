import { describe, expect, test } from 'vitest';
import type { EpisodeRef } from '../../src/shared/api-types';
import {
  formatChannelMeta,
  formatClock,
  formatDurationMin,
  formatEpisodeLabel,
  initialsOf,
  resolutionBadge,
} from '../../src/web/format';

function ep(over: Partial<EpisodeRef> = {}): EpisodeRef {
  return {
    id: 'x',
    title: 'Titulo',
    season: 2,
    episode: 14,
    durationMs: 1000,
    width: null,
    height: null,
    audioTracks: [],
    subtitleTracks: [],
    ...over,
  };
}

describe('formatEpisodeLabel', () => {
  test('temporada e episodio viram SxxEyy', () => {
    expect(formatEpisodeLabel(ep())).toBe('S02E14');
  });

  test('so episodio vira EP xx', () => {
    expect(formatEpisodeLabel(ep({ season: null }))).toBe('EP 14');
  });

  test('sem numeracao cai no titulo do arquivo', () => {
    expect(formatEpisodeLabel(ep({ season: null, episode: null, title: 'Especial de Natal' }))).toBe(
      'ESPECIAL DE NATAL',
    );
  });

  test('titulo longo e truncado para caber na coluna', () => {
    const label = formatEpisodeLabel(ep({ season: null, episode: null, title: 'a'.repeat(80) }));
    expect(label.length).toBeLessThanOrEqual(32);
  });

  test('temporada acima de 99 nao e truncada', () => {
    expect(formatEpisodeLabel(ep({ season: 100, episode: 1 }))).toBe('S100E01');
  });
});

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

describe('formatClock', () => {
  test('menos de uma hora nao ganha campo de hora', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(9_000)).toBe('0:09');
    expect(formatClock(62_000)).toBe('1:02');
    expect(formatClock(22 * 60_000)).toBe('22:00');
  });

  test('passando de uma hora o campo aparece com minuto de dois digitos', () => {
    expect(formatClock(3_600_000)).toBe('1:00:00');
    expect(formatClock(3_723_000)).toBe('1:02:03');
  });

  test('trunca em vez de arredondar: o relogio nao pode adiantar o video', () => {
    expect(formatClock(1_999)).toBe('0:01');
  });

  test('posicao invalida vira zero em vez de NaN na tela', () => {
    expect(formatClock(Number.NaN)).toBe('0:00');
    expect(formatClock(-10_000)).toBe('0:00');
    expect(formatClock(Number.POSITIVE_INFINITY)).toBe('0:00');
  });
});

describe('formatChannelMeta', () => {
  test('ano e contagem, separados por ponto', () => {
    expect(formatChannelMeta(2025, 22)).toBe('2025 · 22 EP');
  });

  test('sem ano o separador nao fica orfao', () => {
    expect(formatChannelMeta(null, 22)).toBe('22 EP');
  });

  test('serie sem episodio indexado nao mostra numero quebrado', () => {
    expect(formatChannelMeta(1999, 0)).toBe('1999 · 0 EP');
    expect(formatChannelMeta(null, Number.NaN)).toBe('0 EP');
  });
});

describe('initialsOf', () => {
  test('duas palavras viram duas iniciais', () => {
    expect(initialsOf('Os Simpsons')).toBe('OS');
  });

  test('palavra unica vira as duas primeiras letras', () => {
    expect(initialsOf('Friends')).toBe('FR');
  });

  test('pontuacao e numero nao contam como palavra inicial', () => {
    expect(initialsOf('Cavaleiros do Zodiaco')).toBe('CD');
    expect(initialsOf('  ThunderCats  ')).toBe('TH');
  });

  test('nome vazio nao devolve string vazia', () => {
    expect(initialsOf('')).toBe('?');
    expect(initialsOf('---')).toBe('?');
  });
});
