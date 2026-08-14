import { describe, expect, test } from 'vitest';
import type { ChannelSummary, EpisodeRef } from '../../src/shared/api-types';
import { formatChannelNumber, formatEpisodeLabel, formatTuneLine, formatVolumeBar } from '../../src/web/osd';

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

function ch(over: Partial<ChannelSummary> = {}): ChannelSummary {
  return { number: 7, name: 'ThunderCats', episodeCount: 130, ...over };
}

describe('formatChannelNumber', () => {
  test('preenche com zero ate dois digitos, como TV antiga', () => {
    expect(formatChannelNumber(7)).toBe('07');
  });

  test('nao mutila canal de tres digitos', () => {
    expect(formatChannelNumber(250)).toBe('250');
  });
});

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

  test('titulo longo e truncado para caber no OSD', () => {
    const label = formatEpisodeLabel(
      ep({ season: null, episode: null, title: 'a'.repeat(80) }),
    );
    expect(label.length).toBeLessThanOrEqual(32);
  });

  test('temporada acima de 99 nao e truncada', () => {
    expect(formatEpisodeLabel(ep({ season: 100, episode: 1 }))).toBe('S100E01');
  });
});

describe('formatTuneLine', () => {
  test('junta canal, serie e episodio em maiuscula', () => {
    expect(formatTuneLine(ch(), ep())).toBe('07  THUNDERCATS  S02E14');
  });

  test('sem episodio ainda, mostra so canal e serie', () => {
    expect(formatTuneLine(ch(), null)).toBe('07  THUNDERCATS');
  });
});

describe('formatVolumeBar', () => {
  test('volume cheio enche a barra', () => {
    expect(formatVolumeBar(1, false)).toBe('VOL [##########]');
  });

  test('volume zero esvazia a barra', () => {
    expect(formatVolumeBar(0, false)).toBe('VOL [----------]');
  });

  test('meio volume enche metade', () => {
    expect(formatVolumeBar(0.5, false)).toBe('VOL [#####-----]');
  });

  test('mudo tem rotulo proprio e mantem o nivel visivel', () => {
    expect(formatVolumeBar(0.5, true)).toBe('MUDO [#####-----]');
  });

  test('valor fora da faixa e limitado em vez de quebrar a barra', () => {
    expect(formatVolumeBar(2, false)).toBe('VOL [##########]');
    expect(formatVolumeBar(-1, false)).toBe('VOL [----------]');
  });
});
