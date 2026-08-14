import { describe, expect, test } from 'vitest';

import type { ProbeResult } from '../../src/server/library/probe-types';
import { type SummaryInput, summarize } from '../../src/server/cli/survey';

/**
 * O veredito do survey e o que decide se o projeto precisa de transcode, entao
 * ele tem que classificar por "o navegador consegue decodificar isto", nao por
 * "isto e h264".
 *
 * AV1 e o caso mais favoravel que existe aqui: o Chrome decodifica por software
 * em qualquer maquina e o ExoPlayer decodifica nativo. Marcar AV1 como risco
 * levaria a construir um transcoder que ninguem precisa.
 */

function probe(videoCodec: string | null): ProbeResult {
  return {
    durationMs: 1_320_000,
    videoCodec,
    audioCodec: 'aac',
    width: 640,
    height: 480,
    faststart: true,
    audioTracks: [],
    subtitleTracks: [],
  };
}

function input(codecs: readonly (string | null)[]): SummaryInput {
  const files = codecs.map((_, i) => ({
    showSlug: 'serie',
    showName: 'Serie',
    relativePath: `serie/ep${i}.mp4`,
    absolutePath: `/lib/serie/ep${i}.mp4`,
    extension: '.mp4',
  }));
  return {
    root: '/lib',
    allFiles: files,
    probed: files.map((file, i) => ({ file, probe: probe(codecs[i] ?? null) })),
    failures: [],
    sampleRequested: null,
  };
}

describe('veredito de codec', () => {
  test('acervo todo em AV1 e risco baixo, nao alto', () => {
    const v = summarize(input(Array.from({ length: 20 }, () => 'av1'))).verdicts.unsupported;
    expect(v.level).toBe('baixo');
    expect(v.count).toBe(0);
  });

  test.each(['h264', 'av1', 'vp9', 'vp8'])('%s conta como reproduzivel', (codec) => {
    const v = summarize(input([codec])).verdicts.unsupported;
    expect(v.count).toBe(0);
  });

  test.each(['mpeg4', 'msmpeg4v3', 'wmv3', 'vc1', 'rv40', 'mpeg2video'])(
    '%s conta como nao reproduzivel',
    (codec) => {
      const v = summarize(input([codec])).verdicts.unsupported;
      expect(v.count).toBe(1);
      expect(v.labels).toContain(codec);
    },
  );

  test('h265 fica fora do balde de nao suportados: tem veredito proprio', () => {
    const report = summarize(input(['hevc', 'hevc', 'av1'])).verdicts;
    expect(report.unsupported.count).toBe(0);
    expect(report.h265.count).toBe(2);
  });

  test('passa de 5 por cento de codec nao reproduzivel e vira risco alto', () => {
    const codecs = [...Array.from({ length: 90 }, () => 'av1'), ...Array.from({ length: 10 }, () => 'wmv3')];
    expect(summarize(input(codecs)).verdicts.unsupported.level).toBe('alto');
  });

  test('menos de 5 por cento continua risco baixo', () => {
    const codecs = [...Array.from({ length: 99 }, () => 'av1'), 'wmv3'];
    expect(summarize(input(codecs)).verdicts.unsupported.level).toBe('baixo');
  });

  test('sem nada medido o veredito e indeterminado, nao "baixo"', () => {
    expect(summarize(input([])).verdicts.unsupported.level).toBe('indeterminado');
  });

  test('codec ausente nao e contado como nao reproduzivel', () => {
    // Arquivo sem stream de video e um problema de acervo, nao de codec.
    expect(summarize(input([null])).verdicts.unsupported.count).toBe(0);
  });
});
