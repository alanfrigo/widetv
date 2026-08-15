import { describe, expect, test } from 'vitest';
import type { AudioTrackRef, EpisodeRef } from '../../src/shared/api-types';
import {
  audiosBadge,
  channelLabel,
  channelNumberLabel,
  episodeCode,
  episodeHeadline,
  episodesLabel,
  formatChannelMeta,
  formatClock,
  formatDurationMin,
  formatEpisodeLabel,
  formatLeftBadge,
  formatRemaining,
  formatRuntime,
  formatUpNext,
  initialsOf,
  joinMeta,
  languagesBadge,
  resolutionBadge,
  resultsLabel,
} from '../../src/web/format';

function aud(over: Partial<AudioTrackRef> = {}): AudioTrackRef {
  return { index: 0, lang: 'por', title: null, codec: 'eac3', isDefault: false, ...over };
}

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
    thumbUrl: null,
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
    expect(formatDurationMin(22 * 60_000)).toBe('22 min');
  });

  test('arredonda para o minuto mais proximo', () => {
    expect(formatDurationMin(22 * 60_000 + 29_000)).toBe('22 min');
    expect(formatDurationMin(22 * 60_000 + 31_000)).toBe('23 min');
  });

  test('episodio curto nunca vira zero minuto', () => {
    expect(formatDurationMin(20_000)).toBe('1 min');
  });

  test('duracao desconhecida nao mente sobre o tempo', () => {
    expect(formatDurationMin(0)).toBe('0 min');
    expect(formatDurationMin(-5)).toBe('0 min');
    expect(formatDurationMin(Number.NaN)).toBe('0 min');
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

describe('rotulo do episodio no redesenho', () => {
  test('o codigo e a numeracao do arquivo', () => {
    expect(episodeCode(ep())).toBe('S02E14');
    expect(episodeCode(ep({ season: null }))).toBe('EP 14');
  });

  test('sem numeracao nao ha codigo para inventar', () => {
    expect(episodeCode(ep({ season: null, episode: null }))).toBeNull();
  });

  test('o cabecalho junta codigo e titulo', () => {
    expect(episodeHeadline(ep({ title: 'O roubo do século' }))).toBe(
      'S02E14 · O roubo do século',
    );
  });

  test('sem codigo o titulo nao aparece duas vezes', () => {
    expect(episodeHeadline(ep({ season: null, episode: null, title: 'Especial' }))).toBe(
      'Especial',
    );
  });
});

describe('canal', () => {
  test('o selo do card tem sempre dois digitos', () => {
    expect(channelNumberLabel(7)).toBe('07');
    expect(channelNumberLabel(84)).toBe('84');
    expect(channelNumberLabel(120)).toBe('120');
  });

  test('a pilula repete o mesmo numero', () => {
    expect(channelLabel(7)).toBe('Canal 07');
  });
});

describe('tempo do redesenho', () => {
  test('o que falta do episodio', () => {
    expect(formatRemaining(4 * 60_000)).toBe('faltam 4 min');
    expect(formatRemaining(60_000)).toBe('faltam 1 min');
  });

  test('o ultimo minuto nao vira "faltam 0 min"', () => {
    expect(formatRemaining(10_000)).toBe('falta menos de 1 min');
    expect(formatRemaining(0)).toBe('falta menos de 1 min');
    expect(formatRemaining(Number.NaN)).toBe('falta menos de 1 min');
  });

  test('o "a seguir" conta em minutos', () => {
    expect(formatUpNext(7 * 60_000)).toBe('em 7 min');
    expect(formatUpNext(5_000)).toBe('em instantes');
  });

  test('o selo de retomada nunca some para zero', () => {
    expect(formatLeftBadge(12 * 60_000)).toBe('12 min');
    expect(formatLeftBadge(3_000)).toBe('1 min');
  });

  test('a soma da temporada vira horas e minutos', () => {
    expect(formatRuntime(9 * 3_600_000 + 12 * 60_000)).toBe('9h 12min');
    expect(formatRuntime(48 * 60_000)).toBe('48min');
    expect(formatRuntime(2 * 3_600_000)).toBe('2h');
  });

  test('sem duracao medida o aside nao anuncia "0min"', () => {
    expect(formatRuntime(0)).toBeNull();
    expect(formatRuntime(-1)).toBeNull();
  });
});

describe('contagens e selos', () => {
  test('singular nao vira "1 episódios"', () => {
    expect(episodesLabel(1)).toBe('1 episódio');
    expect(episodesLabel(142)).toBe('142 episódios');
  });

  test('a busca conta o que achou', () => {
    expect(resultsLabel(3)).toBe('3 resultados');
    expect(resultsLabel(1)).toBe('1 resultado');
    expect(resultsLabel(0)).toBe('nenhum resultado');
  });

  test('o selo de audios so aparece quando ha escolha', () => {
    expect(audiosBadge(3)).toBe('3 áudios');
    expect(audiosBadge(1)).toBeNull();
    expect(audiosBadge(0)).toBeNull();
  });

  test('o selo de idiomas conta linguas, nao faixas', () => {
    // Estereo e 5.1 em portugues sao uma lingua so.
    expect(languagesBadge([aud({ index: 0 }), aud({ index: 1 })])).toBeNull();
    expect(languagesBadge([aud({ lang: 'por' }), aud({ lang: 'eng' })])).toBe('2 idiomas');
    // 'pt' e 'por' sao o mesmo idioma marcado de dois jeitos.
    expect(languagesBadge([aud({ lang: 'pt-BR' }), aud({ lang: 'por' })])).toBeNull();
  });

  test('faixa sem tag de idioma nao inventa lingua', () => {
    expect(languagesBadge([aud({ lang: null }), aud({ lang: 'und' })])).toBeNull();
  });
});

describe('joinMeta', () => {
  test('junta com ponto o que existe', () => {
    expect(joinMeta(['1989', '142 episódios', '1080p'])).toBe('1989 · 142 episódios · 1080p');
  });

  test('o que falta nao deixa separador orfao', () => {
    expect(joinMeta([null, '142 episódios', undefined, ''])).toBe('142 episódios');
    expect(joinMeta([null, undefined])).toBe('');
  });
});
