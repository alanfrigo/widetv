import { execFile, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import {
  formatReport,
  parseArgs,
  pickSample,
  runSurvey,
  summarize,
  type ProbedFile,
  type SurveyFile,
  type SurveyReport,
} from '../../src/server/cli/survey.js';
import type { ProbeResult } from '../../src/server/library/probe-types.js';

/** Acervo sintetico: cada serie com a quantidade de episodios pedida. */
function library(sizes: readonly [string, number][]): SurveyFile[] {
  const files: SurveyFile[] = [];
  for (const [show, count] of sizes) {
    for (let i = 1; i <= count; i += 1) {
      files.push({
        showSlug: show.toLowerCase(),
        showName: show,
        relativePath: `${show}/ep${String(i)}.mp4`,
        absolutePath: `/acervo/${show}/ep${String(i)}.mp4`,
        extension: '.mp4',
      });
    }
  }
  return files;
}

describe('parseArgs', () => {
  test('sem raiz, explica o uso em vez de rodar contra nada', () => {
    expect(() => parseArgs([])).toThrow(/raiz/i);
  });

  test('le --sample e --json em qualquer ordem, antes ou depois da raiz', () => {
    expect(parseArgs(['/acervo', '--sample', '200', '--json', 'r.json'])).toEqual({
      root: '/acervo',
      sample: 200,
      jsonPath: 'r.json',
    });
    expect(parseArgs(['--json', 'r.json', '--sample', '200', '/acervo'])).toEqual({
      root: '/acervo',
      sample: 200,
      jsonPath: 'r.json',
    });
    expect(parseArgs(['/acervo'])).toEqual({
      root: '/acervo',
      sample: null,
      jsonPath: null,
    });
  });

  test('recusa valor invalido em vez de virar NaN e varrer o acervo inteiro', () => {
    expect(() => parseArgs(['/acervo', '--sample', 'abc'])).toThrow(/--sample/);
    expect(() => parseArgs(['/acervo', '--sample', '0'])).toThrow(/--sample/);
    expect(() => parseArgs(['/acervo', '--sample', '-3'])).toThrow(/--sample/);
    expect(() => parseArgs(['/acervo', '--sample', '1.5'])).toThrow(/--sample/);
    expect(() => parseArgs(['/acervo', '--sample'])).toThrow(/--sample/);
    expect(() => parseArgs(['/acervo', '--json'])).toThrow(/--json/);
    expect(() => parseArgs(['/acervo', '--turbo'])).toThrow(/--turbo/);
    expect(() => parseArgs(['/acervo', '/outro'])).toThrow(/raiz/i);
  });
});

/** Arquivo analisado com sucesso; os defaults sao o caso feliz do acervo. */
function ok(file: SurveyFile, probe: Partial<ProbeResult> = {}): ProbedFile {
  return {
    file,
    probe: {
      durationMs: 600_000,
      videoCodec: 'h264',
      audioCodec: 'aac',
      width: 1280,
      height: 720,
      faststart: true,
      audioTracks: [],
      subtitleTracks: [],
      ...probe,
    },
  };
}

describe('pickSample', () => {
  test('amostra maior ou igual ao acervo devolve tudo, na ordem original', () => {
    const files = library([['A', 3], ['B', 2]]);
    expect(pickSample(files, 5)).toEqual(files);
    expect(pickSample(files, 99)).toEqual(files);
  });

  test('devolve exatamente n arquivos distintos, na ordem original, espalhados', () => {
    const files = library([['A', 20]]);
    const sample = pickSample(files, 4);

    expect(sample).toHaveLength(4);
    expect(new Set(sample.map((f) => f.relativePath)).size).toBe(4);
    // Ordem original preservada, para o progresso nao pular para tras.
    const indices = sample.map((f) => files.indexOf(f));
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
    // Nao pode ser "os 4 primeiros": isso mediria so o comeco da serie.
    expect(indices).not.toEqual([0, 1, 2, 3]);
    expect(indices.at(-1)).toBeGreaterThan(10);
  });

  test('com n >= numero de series, nenhuma serie fica de fora', () => {
    // O codec e quase constante dentro de uma serie: perder uma serie inteira
    // e perder um codec inteiro da conta. A serie gigante nao pode comer a cota.
    const files = library([['Gigante', 300], ['Curta', 2], ['Rara', 1]]);
    const sample = pickSample(files, 10);

    expect(sample).toHaveLength(10);
    expect(new Set(sample.map((f) => f.showSlug))).toEqual(
      new Set(['gigante', 'curta', 'rara']),
    );
    // O resto da cota vai para quem tem mais arquivos.
    expect(sample.filter((f) => f.showSlug === 'gigante')).toHaveLength(8);
  });

  test('com n menor que o numero de series, mede n series espalhadas ate o fim', () => {
    const files = library(
      Array.from({ length: 300 }, (_, i) => [`S${String(i).padStart(3, '0')}`, 3] as [string, number]),
    );
    const sample = pickSample(files, 200);

    expect(sample).toHaveLength(200);
    const slugs = sample.map((f) => f.showSlug);
    expect(new Set(slugs).size).toBe(200);
    // Espalhado ate o fim do acervo, nao as 200 primeiras series.
    expect(slugs.at(-1)).toBe('s299');
    expect(slugs).not.toContain('s001');
  });

  test('e deterministico e devolve exatamente n em qualquer distribuicao', () => {
    const files = library([['A', 1], ['B', 7], ['C', 2], ['D', 13], ['E', 1], ['F', 5]]);
    for (let n = 1; n <= files.length + 2; n += 1) {
      const primeira = pickSample(files, n);
      const segunda = pickSample(files, n);
      expect(segunda).toEqual(primeira);
      expect(primeira).toHaveLength(Math.min(n, files.length));
      expect(new Set(primeira.map((f) => f.relativePath)).size).toBe(primeira.length);
    }
  });
});

describe('summarize', () => {
  test('conta series, arquivos do acervo e arquivos que passaram pelo probe', () => {
    const files = library([['A', 3], ['B', 2]]);
    const report = summarize({
      root: '/acervo',
      allFiles: files,
      probed: [ok(files[0]!), ok(files[3]!)],
      failures: [{ path: '/acervo/A/ep2.mp4', reason: 'ffprobe falhou' }],
      sampleRequested: 3,
    });

    expect(report.root).toBe('/acervo');
    expect(report.shows).toBe(2);
    expect(report.files).toBe(5);
    expect(report.probed).toBe(2);
    // Amostrados = analisados + falhados, para a conta fechar com --sample.
    expect(report.sampled).toBe(3);
    expect(report.sampleRequested).toBe(3);
  });

  test('distribui codec de video e de audio com contagem e percentual', () => {
    const files = library([['A', 4]]);
    const report = summarize({
      root: '/acervo',
      allFiles: files,
      probed: [
        ok(files[0]!, { videoCodec: 'h264', audioCodec: 'aac' }),
        ok(files[1]!, { videoCodec: 'h264', audioCodec: 'aac' }),
        ok(files[2]!, { videoCodec: 'hevc', audioCodec: 'ac3' }),
        ok(files[3]!, { videoCodec: null, audioCodec: null }),
      ],
      failures: [],
      sampleRequested: null,
    });

    // Maior primeiro; o balde de ausente fica sempre no fim, mesmo empatado.
    expect(report.videoCodecs).toEqual([
      { label: 'h264', count: 2, percent: 50 },
      { label: 'hevc', count: 1, percent: 25 },
      { label: '(sem stream)', count: 1, percent: 25 },
    ]);
    expect(report.audioCodecs).toEqual([
      { label: 'aac', count: 2, percent: 50 },
      { label: 'ac3', count: 1, percent: 25 },
      { label: '(sem stream)', count: 1, percent: 25 },
    ]);
  });

  test('distribui container sobre o acervo inteiro, nao so sobre a amostra', () => {
    // A extensao nao precisa de ffprobe: da para contar os 14 mil arquivos.
    const files = library([['A', 4]]).map((file, i) => ({
      ...file,
      extension: i < 3 ? '.mp4' : '.mkv',
    }));
    const report = summarize({
      root: '/acervo',
      allFiles: files,
      probed: [ok(files[0]!)],
      failures: [],
      sampleRequested: 1,
    });

    expect(report.containers).toEqual([
      { label: '.mp4', count: 3, percent: 75 },
      { label: '.mkv', count: 1, percent: 25 },
    ]);
  });

  test('agrupa resolucao pela altura, na ordem de leitura, com as bordas certas', () => {
    const files = library([['A', 7]]);
    const alturas = [480, 481, 720, 721, 1080, 1081, null];
    const report = summarize({
      root: '/acervo',
      allFiles: files,
      probed: files.map((file, i) => ok(file, { height: alturas[i] ?? null })),
      failures: [],
      sampleRequested: null,
    });

    expect(report.resolutions).toEqual([
      { label: '<=480p', count: 1, percent: 14.3 },
      { label: '720p', count: 2, percent: 28.6 },
      { label: '1080p', count: 2, percent: 28.6 },
      { label: 'acima de 1080p', count: 1, percent: 14.3 },
      { label: '(sem stream)', count: 1, percent: 14.3 },
    ]);
  });

  test('conta quem tem faststart e o percentual que precisa de remux', () => {
    const files = library([['A', 4]]);
    const report = summarize({
      root: '/acervo',
      allFiles: files,
      probed: [
        ok(files[0]!, { faststart: true }),
        ok(files[1]!, { faststart: true }),
        ok(files[2]!, { faststart: true }),
        ok(files[3]!, { faststart: false }),
      ],
      failures: [],
      sampleRequested: null,
    });

    expect(report.faststart).toEqual({ yes: 3, no: 1, percentNeedingRemux: 25 });
  });

  test('soma a duracao medida e tira a mediana, com numero par ou impar de itens', () => {
    const base = { root: '/acervo', failures: [], sampleRequested: null } as const;
    const tres = library([['A', 3]]);
    const impar = summarize({
      ...base,
      allFiles: tres,
      probed: [
        ok(tres[0]!, { durationMs: 1_000 }),
        ok(tres[1]!, { durationMs: 5_000 }),
        ok(tres[2]!, { durationMs: 3_000 }),
      ],
    });
    expect(impar.totalDurationMs).toBe(9_000);
    expect(impar.medianDurationMs).toBe(3_000);

    const quatro = library([['A', 4]]);
    const par = summarize({
      ...base,
      allFiles: quatro,
      probed: [
        ok(quatro[0]!, { durationMs: 4_000 }),
        ok(quatro[1]!, { durationMs: 1_000 }),
        ok(quatro[2]!, { durationMs: 3_000 }),
        ok(quatro[3]!, { durationMs: 2_000 }),
      ],
    });
    expect(par.totalDurationMs).toBe(10_000);
    expect(par.medianDurationMs).toBe(2_500);
  });

  test('com amostra, estima a duracao do acervo; sem amostra nao inventa estimativa', () => {
    const files = library([['A', 10]]);
    const amostrado = summarize({
      root: '/acervo',
      allFiles: files,
      probed: [
        ok(files[0]!, { durationMs: 1_000 }),
        ok(files[3]!, { durationMs: 2_000 }),
        ok(files[6]!, { durationMs: 3_000 }),
        ok(files[9]!, { durationMs: 4_000 }),
      ],
      failures: [],
      sampleRequested: 4,
    });
    // media de 2500 ms x 10 arquivos.
    expect(amostrado.estimatedTotalDurationMs).toBe(25_000);

    const completo = summarize({
      root: '/acervo',
      allFiles: files.slice(0, 2),
      probed: [ok(files[0]!, { durationMs: 1_000 }), ok(files[1]!, { durationMs: 3_000 })],
      failures: [],
      sampleRequested: null,
    });
    expect(completo.estimatedTotalDurationMs).toBeNull();
  });

  test('sem --sample nao extrapola, mesmo com arquivo que falhou no probe', () => {
    // "extrapolado da amostra" so pode aparecer quando houve amostra; senao a
    // linha mente sobre o que foi medido.
    const files = library([['A', 4]]);
    const report = summarize({
      root: '/acervo',
      allFiles: files,
      probed: [ok(files[0]!), ok(files[1]!), ok(files[2]!)],
      failures: [{ path: '/acervo/A/ep4.mp4', reason: 'ffprobe falhou' }],
      sampleRequested: null,
    });
    expect(report.estimatedTotalDurationMs).toBeNull();
  });

  test('leva as falhas para o relatorio sem deixa-las no denominador', () => {
    const files = library([['A', 3]]);
    const falhas = [
      { path: '/acervo/A/ep2.mp4', reason: 'ffprobe falhou: sem duracao' },
      { path: '/acervo/A/ep3.mp4', reason: 'ffprobe falhou: timeout' },
    ];
    const report = summarize({
      root: '/acervo',
      allFiles: files,
      probed: [ok(files[0]!)],
      failures: falhas,
      sampleRequested: null,
    });

    expect(report.failures).toEqual(falhas);
    expect(report.videoCodecs).toEqual([{ label: 'h264', count: 1, percent: 100 }]);
  });
});

describe('veredito', () => {
  /** Acervo de 40 arquivos com `n` deles em h265 (grafia `codec`). */
  function comH265(n: number, codec = 'hevc'): SurveyReport {
    const files = library([['A', 40]]);
    return summarize({
      root: '/acervo',
      allFiles: files,
      probed: files.map((file, i) => ok(file, { videoCodec: i < n ? codec : 'h264' })),
      failures: [],
      sampleRequested: null,
    });
  }

  test('h265: alto a partir do limiar, baixo abaixo dele, indeterminado sem medicao', () => {
    expect(comH265(0).verdicts.h265).toEqual({ level: 'baixo', count: 0, percent: 0 });
    expect(comH265(1).verdicts.h265).toEqual({ level: 'baixo', count: 1, percent: 2.5 });
    expect(comH265(2).verdicts.h265).toEqual({ level: 'alto', count: 2, percent: 5 });
    // `h265` e `hevc` sao o mesmo codec com dois nomes.
    expect(comH265(8, 'h265').verdicts.h265).toEqual({ level: 'alto', count: 8, percent: 20 });

    // Zero arquivo analisado nao pode virar "risco baixo": isso seria mentira.
    const vazio = summarize({
      root: '/acervo',
      allFiles: library([['A', 3]]),
      probed: [],
      failures: [{ path: '/acervo/A/ep1.mp4', reason: 'ffprobe falhou' }],
      sampleRequested: null,
    });
    expect(vazio.verdicts.h265).toEqual({ level: 'indeterminado', count: 0, percent: 0 });
  });

  test('codec que o navegador nao decodifica tem veredito proprio', () => {
    // O balde conta o que o navegador NAO toca. av1 e h264 ficam de fora porque
    // tocam; hevc tambem, porque tem veredito separado. Sobra o mpeg4, que e o
    // unico caso aqui que exigiria transcode de verdade.
    const files = library([['A', 10]]);
    const codecs = ['av1', 'av1', 'mpeg4', 'h264', 'h264', 'h264', 'h264', 'hevc', 'h264', 'h264'];
    const report = summarize({
      root: '/acervo',
      allFiles: files,
      probed: files.map((file, i) => ok(file, { videoCodec: codecs[i] ?? null })),
      failures: [],
      sampleRequested: null,
    });

    expect(report.verdicts.unsupported).toEqual({
      level: 'alto',
      count: 1,
      percent: 10,
      labels: ['mpeg4'],
    });
    expect(comH265(2).verdicts.unsupported).toEqual({
      level: 'baixo',
      count: 0,
      percent: 0,
      labels: [],
    });
  });

  test('faststart: percentual que precisa de remux, indeterminado sem medicao', () => {
    const files = library([['A', 10]]);
    const comRemux = (n: number): SurveyReport =>
      summarize({
        root: '/acervo',
        allFiles: files,
        probed: files.map((file, i) => ok(file, { faststart: i >= n })),
        failures: [],
        sampleRequested: null,
      });

    expect(comRemux(0).verdicts.faststart).toEqual({ level: 'baixo', count: 0, percent: 0 });
    expect(comRemux(3).verdicts.faststart).toEqual({ level: 'alto', count: 3, percent: 30 });

    const vazio = summarize({
      root: '/acervo',
      allFiles: files,
      probed: [],
      failures: [],
      sampleRequested: null,
    });
    expect(vazio.verdicts.faststart).toEqual({ level: 'indeterminado', count: 0, percent: 0 });
  });
});

describe('formatReport', () => {
  function relatorio(codecs: readonly string[], faststart: readonly boolean[]): SurveyReport {
    const files = library([['A', codecs.length]]);
    return summarize({
      root: '/acervo',
      allFiles: files,
      probed: files.map((file, i) =>
        ok(file, { videoCodec: codecs[i] ?? null, faststart: faststart[i] ?? true }),
      ),
      failures: [],
      sampleRequested: null,
    });
  }

  test('fecha com uma linha de veredito por risco, no formato do contrato', () => {
    const alto = formatReport(
      relatorio(['hevc', 'h264', 'h264', 'h264'], [true, false, true, true]),
    );
    expect(alto).toMatch(/^H265 DIRECT PLAY: risco alto\b/m);
    expect(alto).toMatch(/^FASTSTART: 25% precisam de remux\b/m);

    const limpo = relatorio(
      Array.from({ length: 40 }, () => 'h264'),
      Array.from({ length: 40 }, () => true),
    );
    expect(formatReport(limpo)).toMatch(/^H265 DIRECT PLAY: risco baixo\b/m);
    expect(formatReport(limpo)).toMatch(/^FASTSTART: 0% precisam de remux\b/m);
  });

  test('imprime totais, distribuicoes, duracao e a lista de falhas', () => {
    const files = library([['A', 3], ['B', 1]]).map((file, i) => ({
      ...file,
      extension: i === 3 ? '.mkv' : '.mp4',
    }));
    const texto = formatReport(
      summarize({
        root: '/acervo',
        allFiles: files,
        probed: [
          ok(files[0]!, { durationMs: 1_320_000, height: 480, width: 640 }),
          ok(files[1]!, {
            durationMs: 1_380_000,
            videoCodec: 'hevc',
            audioCodec: 'ac3',
            height: 1080,
            width: 1920,
            faststart: false,
          }),
        ],
        failures: [{ path: '/acervo/A/ep3.mp4', reason: 'ffprobe falhou: timeout' }],
        sampleRequested: 3,
      }),
    );

    expect(texto).toContain('/acervo');
    expect(texto).toMatch(/series:\s+2/);
    expect(texto).toMatch(/arquivos:\s+4/);
    expect(texto).toMatch(/analisados:\s+2/);
    expect(texto).toMatch(/h264\s+1\s+50%/);
    expect(texto).toMatch(/aac\s+1\s+50%/);
    // Container conta o acervo inteiro: 3 de 4 sao .mp4.
    expect(texto).toMatch(/\.mp4\s+3\s+75%/);
    expect(texto).toMatch(/<=480p\s+1\s+50%/);
    // Total 45m e mediana de 22m30s.
    expect(texto).toMatch(/45m/);
    expect(texto).toMatch(/22m 30s/);
    expect(texto).toContain('/acervo/A/ep3.mp4');
    expect(texto).toContain('ffprobe falhou: timeout');
    // Nao pode parecer que o acervo inteiro foi medido.
    expect(texto).toMatch(/amostra/i);
  });
});

const execFileAsync = promisify(execFile);

describe('runSurvey, concorrencia', () => {
  let raiz = '';

  beforeAll(async () => {
    raiz = await mkdtemp(join(tmpdir(), 'survey-conc-'));
    await mkdir(join(raiz, 'Serie A'), { recursive: true });
    await mkdir(join(raiz, 'Serie B'), { recursive: true });
    for (let i = 1; i <= 10; i += 1) {
      const nome = `Ep ${String(i).padStart(2, '0')}.mp4`;
      await writeFile(join(raiz, 'Serie A', nome), '');
      await writeFile(join(raiz, 'Serie B', nome), '');
    }
  });

  afterAll(async () => {
    if (raiz !== '') await rm(raiz, { recursive: true, force: true });
  });

  test('respeita o limite de concorrencia e nao embaralha o relatorio', async () => {
    let emVoo = 0;
    let pico = 0;
    const report = await runSurvey({
      root: raiz,
      sample: null,
      concurrency: 3,
      probe: async (filePath: string) => {
        emVoo += 1;
        pico = Math.max(pico, emVoo);
        await new Promise((resolve) => setTimeout(resolve, 5));
        emVoo -= 1;
        // Duas falhas em pontas opostas do acervo, para checar a ordem.
        if (filePath.endsWith('Serie A/Ep 01.mp4') || filePath.endsWith('Serie B/Ep 10.mp4')) {
          throw new Error(`ffprobe falhou em ${filePath}`);
        }
        return {
          durationMs: 60_000,
          videoCodec: 'h264',
          audioCodec: 'aac',
          width: 640,
          height: 480,
          faststart: true,
          audioTracks: [],
          subtitleTracks: [],
        };
      },
    });

    expect(pico).toBe(3);
    expect(report.files).toBe(20);
    expect(report.probed).toBe(18);
    // Ordem do acervo, nao a ordem em que os probes terminaram.
    expect(report.failures.map((f) => f.path.replace(raiz, ''))).toEqual([
      '/Serie A/Ep 01.mp4',
      '/Serie B/Ep 10.mp4',
    ]);
  });

  test('sem pedir nada, a concorrencia e o numero de CPUs', async () => {
    let emVoo = 0;
    let pico = 0;
    await runSurvey({
      root: raiz,
      sample: null,
      probe: async () => {
        emVoo += 1;
        pico = Math.max(pico, emVoo);
        await new Promise((resolve) => setTimeout(resolve, 5));
        emVoo -= 1;
        return {
          durationMs: 60_000,
          videoCodec: 'h264',
          audioCodec: 'aac',
          width: 640,
          height: 480,
          faststart: true,
          audioTracks: [],
          subtitleTracks: [],
        };
      },
    });

    expect(pico).toBe(Math.min(cpus().length, 20));
  });
});

/** ffmpeg de verdade: o survey so vale se falar com o binario real. */
function hasBinary(name: string): boolean {
  const result = spawnSync(name, ['-version'], { stdio: 'ignore' });
  return result.error === undefined && result.status === 0;
}

const HAS_FFMPEG = hasBinary('ffmpeg') && hasBinary('ffprobe');

let acervo = '';

async function clipe(args: readonly string[]): Promise<void> {
  await execFileAsync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', ...args]);
}

describe.skipIf(!HAS_FFMPEG)('runSurvey, ponta a ponta', () => {
  beforeAll(async () => {
    acervo = await mkdtemp(join(tmpdir(), 'survey-'));
    await mkdir(join(acervo, 'Gato Feliz'), { recursive: true });
    await mkdir(join(acervo, 'Rato', 'Temporada 1'), { recursive: true });

    const cor = (c: string) => ['-f', 'lavfi', '-i', `color=c=${c}:s=320x240:r=10:d=1`];
    // Padrao do ffmpeg: moov no fim, ou seja, precisa de remux.
    await clipe([...cor('red'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      join(acervo, 'Gato Feliz', 'Gato Ep 01.mp4')]);
    await clipe([...cor('blue'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', join(acervo, 'Gato Feliz', 'Gato Ep 02.mp4')]);
    await clipe([...cor('green'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      join(acervo, 'Rato', 'Temporada 1', 'Rato S01E01.mkv')]);
    // Extensao de video com lixo dentro: o probe falha e o survey tem que contar.
    await writeFile(join(acervo, 'Rato', 'quebrado.mp4'), 'isto nao e video\n', 'utf8');
  }, 120_000);

  afterAll(async () => {
    if (acervo !== '') await rm(acervo, { recursive: true, force: true });
  });

  test('mede o acervo real e separa o que falhou', async () => {
    const report = await runSurvey({ root: acervo, sample: null });

    expect(report.shows).toBe(2);
    expect(report.files).toBe(4);
    expect(report.probed).toBe(3);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.path).toContain('quebrado.mp4');
    expect(report.videoCodecs).toEqual([{ label: 'h264', count: 3, percent: 100 }]);
    expect(report.containers).toEqual([
      { label: '.mp4', count: 3, percent: 75 },
      { label: '.mkv', count: 1, percent: 25 },
    ]);
    expect(report.resolutions).toEqual([{ label: '<=480p', count: 3, percent: 100 }]);
    // So o mp4 sem +faststart precisa de remux; mkv nao se aplica.
    expect(report.faststart).toEqual({ yes: 2, no: 1, percentNeedingRemux: 33.3 });
    expect(report.totalDurationMs).toBeGreaterThan(2_000);
    expect(report.verdicts.h265).toEqual({ level: 'baixo', count: 0, percent: 0 });
  }, 60_000);

  test('com amostra mede so a amostra, avisa o progresso e estima o acervo', async () => {
    const passos: [number, number][] = [];
    const report = await runSurvey({
      root: acervo,
      sample: 2,
      onProgress: (done, total) => passos.push([done, total]),
    });

    expect(report.files).toBe(4);
    expect(report.sampled).toBe(2);
    expect(report.sampleRequested).toBe(2);
    // Uma amostra por serie: a serie pequena nao pode sumir da conta.
    expect(report.probed + report.failures.length).toBe(2);
    expect(report.estimatedTotalDurationMs).toBeGreaterThan(report.totalDurationMs);
    expect(passos.at(-1)).toEqual([2, 2]);
  }, 60_000);

  test('CLI: relatorio no stdout, progresso no stderr, --json grava o arquivo', async () => {
    const raiz = fileURLToPath(new URL('../../', import.meta.url));
    const destino = join(acervo, 'relatorio.json');
    const { stdout, stderr } = await execFileAsync(
      join(raiz, 'node_modules', '.bin', 'tsx'),
      [join(raiz, 'src', 'server', 'cli', 'survey.ts'), acervo, '--json', destino],
      { cwd: raiz },
    );

    // Quem redireciona o stdout leva so o relatorio, sem barra de progresso.
    expect(stdout).toMatch(/^H265 DIRECT PLAY: risco baixo/m);
    expect(stdout).toMatch(/^FASTSTART: 33.3% precisam de remux/m);
    expect(stdout).not.toContain('\r');
    expect(stderr).toContain('4/4');

    const salvo = JSON.parse(await readFile(destino, 'utf8')) as {
      verdicts: { h265: { level: string } };
      files: number;
    };
    expect(salvo.files).toBe(4);
    expect(salvo.verdicts.h265.level).toBe('baixo');
  }, 120_000);

  test('CLI: raiz inexistente sai com codigo 1 e sem relatorio no stdout', async () => {
    const raiz = fileURLToPath(new URL('../../', import.meta.url));
    const falha = await execFileAsync(
      join(raiz, 'node_modules', '.bin', 'tsx'),
      [join(raiz, 'src', 'server', 'cli', 'survey.ts'), join(acervo, 'nao-existe')],
      { cwd: raiz },
    ).catch((error: unknown) => error as { code?: number; stdout: string; stderr: string });

    expect(falha).toMatchObject({ code: 1 });
    expect(falha.stdout).toBe('');
    expect(falha.stderr).toContain('nao-existe');
  }, 120_000);
});
