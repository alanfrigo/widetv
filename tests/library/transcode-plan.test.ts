import { describe, expect, test } from 'vitest';

import type { AudioTrackRef } from '../../src/shared/api-types';
import {
  isLegacyVideo,
  planTranscode,
  transcodeOutputPath,
} from '../../src/server/library/transcode-plan';

function track(index: number, codec: string | null): AudioTrackRef {
  return { index, lang: 'por', title: null, codec, isDefault: index === 0 };
}

function plan(videoCodec: string | null, tracks: AudioTrackRef[] = [track(0, 'mp3')]) {
  return planTranscode({ relativePath: 'Serie/ep1.avi', videoCodec, audioTracks: tracks });
}

describe('quem entra na fila', () => {
  test('mpeg4 (DivX/XviD) entra: nao toca em navegador nenhum', () => {
    expect(isLegacyVideo('mpeg4')).toBe(true);
    expect(plan('mpeg4')).not.toBeNull();
  });

  test.each(['msmpeg4v3', 'mpeg2video', 'wmv3', 'vc1', 'h263', 'flv1', 'svq3'])(
    '%s tambem entra',
    (codec) => {
      expect(isLegacyVideo(codec)).toBe(true);
    },
  );

  /**
   * Lista de INCLUSAO, e nao "tudo que nao e h264". Recodificar um destes seria
   * degradar de graca um arquivo que ja toca.
   */
  test.each(['h264', 'avc1', 'av1', 'av01', 'vp8', 'vp9'])('%s NAO entra: ja toca', (codec) => {
    expect(isLegacyVideo(codec)).toBe(false);
    expect(plan(codec)).toBeNull();
  });

  test('hevc NAO entra: toca onde ha decoder de hardware, inclusive na TV', () => {
    expect(isLegacyVideo('hevc')).toBe(false);
    expect(plan('hevc')).toBeNull();
  });

  test('sem probe de video nao ha o que planejar', () => {
    expect(isLegacyVideo(null)).toBe(false);
    expect(plan(null)).toBeNull();
  });

  test('codec em maiuscula e o mesmo codec', () => {
    expect(isLegacyVideo('MPEG4')).toBe(true);
  });
});

describe('receita do ffmpeg', () => {
  test('video vira h264 com a qualidade escolhida para perda irreversivel', () => {
    const result = plan('mpeg4');
    expect(result?.args.slice(0, 12)).toEqual([
      '-map', '0:V:0',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '20',
      '-tune', 'animation',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    ]);
    expect(result?.args).toContain('-pix_fmt');
    expect(result?.args).toContain('yuv420p');
  });

  test('mp3 e aac saem COPIADOS: a unica coisa que nao precisava mudar', () => {
    const result = plan('mpeg4', [track(0, 'mp3'), track(1, 'aac')]);
    expect(result?.audioCopied).toBe(2);
    expect(result?.audioTranscoded).toBe(0);
    expect(result?.args).toContain('-c:a:0');
    expect(result?.args[result.args.indexOf('-c:a:0') + 1]).toBe('copy');
    expect(result?.args[result.args.indexOf('-c:a:1') + 1]).toBe('copy');
    expect(result?.args).not.toContain('libmp3lame');
  });

  test('audio que o MP4 nao carrega vira AAC', () => {
    const result = plan('mpeg4', [track(0, 'pcm_s16le')]);
    expect(result?.audioTranscoded).toBe(1);
    expect(result?.args[result.args.indexOf('-c:a:0') + 1]).toBe('aac');
  });

  test('TODAS as dublagens vao junto: o acervo antigo e dual', () => {
    const result = plan('mpeg4', [track(0, 'mp3'), track(1, 'mp3')]);
    const maps = result?.args.filter((_, i) => result.args[i - 1] === '-map') ?? [];
    expect(maps).toEqual(['0:V:0', '0:a:0', '0:a:1']);
  });

  test('o indice de mapeamento vem da faixa FONTE, nao da posicao na lista', () => {
    // Uma faixa removida do probe (index 0 e 2) nao pode virar `0:a:0` e
    // `0:a:1` - isso mudaria silenciosamente qual dublagem entrou no arquivo.
    const result = plan('mpeg4', [track(0, 'mp3'), track(2, 'mp3')]);
    const maps = result?.args.filter((_, i) => result.args[i - 1] === '-map') ?? [];
    expect(maps).toEqual(['0:V:0', '0:a:0', '0:a:2']);
  });

  test('sem faixa no indice, pega o que houver em vez de gerar arquivo mudo', () => {
    const result = plan('mpeg4', []);
    expect(result?.args).toContain('0:a?');
  });

  test('faststart: sem ele o navegador baixa tudo antes do primeiro quadro', () => {
    expect(plan('mpeg4')?.args.slice(-2)).toEqual(['-movflags', '+faststart']);
  });
});

describe('destino', () => {
  test('escreve ao LADO do original, nunca por cima', () => {
    expect(transcodeOutputPath('/lib/Serie/Episodio 01.avi')).toBe(
      '/lib/Serie/Episodio 01.h264.mp4',
    );
  });

  test('ponto no nome do episodio nao vira extensao', () => {
    expect(transcodeOutputPath('/lib/Serie/S01E01 - Dr. No.avi')).toBe(
      '/lib/Serie/S01E01 - Dr. No.h264.mp4',
    );
  });

  test('arquivo sem extensao ganha a saida mesmo assim', () => {
    expect(transcodeOutputPath('/lib/Serie/episodio')).toBe('/lib/Serie/episodio.h264.mp4');
  });
});
