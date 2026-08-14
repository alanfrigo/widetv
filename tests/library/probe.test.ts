import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { ProbeError, probeFile } from '../../src/server/library/probe.js';

const execFileAsync = promisify(execFile);

/** ffmpeg e ffprobe sao pre-requisito real destes testes, nada e mockado. */
function hasBinary(name: string): boolean {
  const result = spawnSync(name, ['-version'], { stdio: 'ignore' });
  return result.error === undefined && result.status === 0;
}

const HAS_FFMPEG = hasBinary('ffmpeg') && hasBinary('ffprobe');

const NOME_DIFICIL = 'Pica-Pau (1957) - "Episódio 02" & Cia.mp4';

let dir = '';
/** Fifo sem escritor: o ffprobe de verdade bloqueia nele, entao o timeout e deterministico. */
let hasFifo = false;

/** Caminho de um arquivo dentro do diretorio temporario da suite. */
function fixture(name: string): string {
  return path.join(dir, name);
}

async function runFfmpeg(args: readonly string[]): Promise<void> {
  await execFileAsync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
}

/** Copia um mp4 enfiando uma caixa `free` de 4 KB logo depois do ftyp. */
async function inserirCaixaFree(origem: string, destino: string): Promise<void> {
  const bytes = await readFile(fixture(origem));
  const ftypSize = bytes.readUInt32BE(0);
  const free = Buffer.alloc(4096);
  free.writeUInt32BE(free.length, 0);
  free.write('free', 4, 'latin1');
  await writeFile(
    fixture(destino),
    Buffer.concat([bytes.subarray(0, ftypSize), free, bytes.subarray(ftypSize)]),
  );
}

/** Escreve um executavel que imprime `stdout` fixo, no lugar do ffprobe. */
async function writeStub(name: string, stdout: string): Promise<void> {
  const script = `#!/bin/sh\ncat <<'FIM_DO_STUB'\n${stdout}\nFIM_DO_STUB\n`;
  await writeFile(fixture(name), script, { encoding: 'utf8', mode: 0o755 });
}

beforeAll(async () => {
  if (!HAS_FFMPEG) return;
  dir = await mkdtemp(path.join(tmpdir(), 'probe-test-'));

  // 1s de cor solida com audio, moov depois do mdat (default do muxer mp4).
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=25:d=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    fixture('plain.mp4'),
  ]);

  // Sem trilha de audio.
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'color=c=blue:s=160x120:r=25:d=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    fixture('mudo.mp4'),
  ]);

  // Mesmo conteudo do plain.mp4, mas com o moov movido para o inicio.
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=25:d=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    '-movflags', '+faststart',
    fixture('faststart.mp4'),
  ]);

  // Container que nao e MP4/MOV: nao tem atomo moov nenhum.
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'color=c=green:s=160x120:r=25:d=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    fixture('clipe.mkv'),
  ]);

  // O acervo novo: mkv com dois audios (por default + eng) e duas legendas
  // subrip (uma forced default). Espelha o que vem dos releases dual-audio.
  await writeFile(fixture('pt.srt'), '1\n00:00:00,000 --> 00:00:01,000\nola\n\n', 'utf8');
  await writeFile(fixture('en.srt'), '1\n00:00:00,000 --> 00:00:01,000\nhello\n\n', 'utf8');
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=25:d=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-f', 'lavfi', '-i', 'sine=frequency=880:duration=1',
    '-i', fixture('pt.srt'),
    '-i', fixture('en.srt'),
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:s', '-map', '4:s',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-c:s', 'srt',
    '-metadata:s:a:0', 'language=por', '-metadata:s:a:0', 'title=Brazilian',
    '-metadata:s:a:1', 'language=eng', '-metadata:s:a:1', 'title=English',
    '-metadata:s:s:0', 'language=por', '-metadata:s:s:0', 'title=Forcada',
    '-metadata:s:s:1', 'language=eng',
    '-disposition:a:0', 'default', '-disposition:a:1', '0',
    '-disposition:s:0', 'default+forced', '-disposition:s:1', '0',
    fixture('trilhas.mkv'),
  ]);

  await writeFile(fixture('leia-me.txt'), 'isto aqui nao e video nenhum\n', 'utf8');

  // Stream cru: ffprobe abre, mas nao sabe a duracao nem no format nem no stream.
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'color=c=white:s=64x64:r=25:d=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-f', 'h264',
    fixture('sem-duracao.h264'),
  ]);

  // O caso real do acervo: espaco, acento, parenteses, aspas e &.
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'color=c=yellow:s=160x120:r=25:d=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    fixture(NOME_DIFICIL),
  ]);

  // Mp4 sem faststart com uma caixa `free` de 4 KB entre o ftyp e o mdat:
  // obriga a leitura a andar caixa a caixa, pulando pelo tamanho declarado.
  await inserirCaixaFree('plain.mp4', 'com-free.mp4');

  // So audio, com capa embutida: a capa e um stream de video com disposition
  // attached_pic e nao pode ser confundida com o video do episodio.
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-f', 'lavfi', '-i', 'color=c=red:s=64x64:r=1:d=1',
    '-map', '0:a', '-map', '1:v',
    '-c:a', 'aac', '-c:v', 'mjpeg', '-frames:v', '1', '-disposition:v:0', 'attached_pic',
    fixture('so-audio-com-capa.m4a'),
  ]);

  // Stubs de ffprobe: cobrem ramos de parse que o binario real nao produz sob
  // encomenda (JSON quebrado, duracao zero, format sem duracao). Continuam
  // sendo processo de verdade, chamados pela opcao publica `ffprobePath`.
  await writeStub('stub-json-invalido.sh', 'nao sou json {');
  await writeStub(
    'stub-duracao-zero.sh',
    JSON.stringify({ format: { duration: '0.000000' }, streams: [] }),
  );
  await writeStub(
    'stub-sem-format.sh',
    JSON.stringify({
      format: {},
      streams: [{ codec_type: 'video', codec_name: 'hevc', width: 1920, height: 1080, duration: '1320.500000' }],
    }),
  );

  try {
    await execFileAsync('mkfifo', [fixture('travado.fifo')]);
    hasFifo = true;
  } catch {
    hasFifo = false;
  }
}, 120_000);

afterAll(async () => {
  if (dir !== '') await rm(dir, { recursive: true, force: true });
});

test.skipIf(!HAS_FFMPEG)('devolve a duracao em ms de um arquivo real', async () => {
  const result = await probeFile(fixture('plain.mp4'));

  expect(result.durationMs).toBeGreaterThan(900);
  expect(result.durationMs).toBeLessThan(1100);
});

test.skipIf(!HAS_FFMPEG)('devolve codecs e dimensoes do arquivo', async () => {
  const result = await probeFile(fixture('plain.mp4'));

  expect(result.videoCodec).toBe('h264');
  expect(result.audioCodec).toBe('aac');
  expect(result.width).toBe(320);
  expect(result.height).toBe(240);
});

test.skipIf(!HAS_FFMPEG)('audioCodec e null quando o arquivo nao tem trilha de audio', async () => {
  const result = await probeFile(fixture('mudo.mp4'));

  expect(result.videoCodec).toBe('h264');
  expect(result.audioCodec).toBeNull();
});

test.skipIf(!HAS_FFMPEG)('lista as trilhas de audio com lang, title, codec e default', async () => {
  const result = await probeFile(fixture('trilhas.mkv'));

  expect(result.audioTracks).toEqual([
    { index: 0, lang: 'por', title: 'Brazilian', codec: 'aac', isDefault: true },
    { index: 1, lang: 'eng', title: 'English', codec: 'aac', isDefault: false },
  ]);
});

test.skipIf(!HAS_FFMPEG)('lista as legendas com index relativo, forced e default', async () => {
  const result = await probeFile(fixture('trilhas.mkv'));

  // O index e relativo entre legendas (casa com -map 0:s:N), nao o index do
  // container - la elas sao os streams 3 e 4.
  expect(result.subtitleTracks).toEqual([
    { index: 0, lang: 'por', title: 'Forcada', codec: 'subrip', isDefault: true, forced: true },
    { index: 1, lang: 'eng', title: null, codec: 'subrip', isDefault: false, forced: false },
  ]);
});

test.skipIf(!HAS_FFMPEG)('arquivo sem trilhas extras devolve listas vazias, nunca undefined', async () => {
  const result = await probeFile(fixture('mudo.mp4'));

  expect(result.audioTracks).toEqual([]);
  expect(result.subtitleTracks).toEqual([]);
});

test.skipIf(!HAS_FFMPEG)('audio unico tambem entra em audioTracks', async () => {
  const result = await probeFile(fixture('plain.mp4'));

  expect(result.audioTracks).toHaveLength(1);
  expect(result.audioTracks[0]).toMatchObject({ index: 0, codec: 'aac' });
});

test.skipIf(!HAS_FFMPEG)('faststart e true quando o moov vem antes do mdat', async () => {
  const result = await probeFile(fixture('faststart.mp4'));

  expect(result.faststart).toBe(true);
});

test.skipIf(!HAS_FFMPEG)('faststart e false quando o mdat vem antes do moov', async () => {
  const result = await probeFile(fixture('plain.mp4'));

  expect(result.faststart).toBe(false);
});

test.skipIf(!HAS_FFMPEG)('faststart e true para container que nao e MP4/MOV', async () => {
  const result = await probeFile(fixture('clipe.mkv'));

  expect(result.videoCodec).toBe('h264');
  expect(result.faststart).toBe(true);
});

test.skipIf(!HAS_FFMPEG)('arquivo inexistente lanca ProbeError com o caminho', async () => {
  const missing = fixture('nao-existe.mp4');

  const error = await probeFile(missing).catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(ProbeError);
  expect((error as ProbeError).filePath).toBe(missing);
  expect((error as ProbeError).message).toContain(missing);
});

test.skipIf(!HAS_FFMPEG)('arquivo que nao e video lanca ProbeError', async () => {
  const notVideo = fixture('leia-me.txt');

  const error = await probeFile(notVideo).catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(ProbeError);
  expect((error as ProbeError).filePath).toBe(notVideo);
});

test.skipIf(!HAS_FFMPEG)('arquivo sem duracao nenhuma lanca ProbeError', async () => {
  const noDuration = fixture('sem-duracao.h264');

  const error = await probeFile(noDuration).catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(ProbeError);
  expect((error as ProbeError).filePath).toBe(noDuration);
});

test.skipIf(!HAS_FFMPEG)('timeout mata o ffprobe e lanca ProbeError', async (ctx) => {
  if (!hasFifo) ctx.skip('sem mkfifo neste sistema');
  const stuck = fixture('travado.fifo');
  const startedAt = Date.now();

  const error = await probeFile(stuck, { timeoutMs: 400 }).catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(ProbeError);
  expect((error as ProbeError).message).toContain('timeout');
  expect(Date.now() - startedAt).toBeLessThan(3_000);
}, 10_000);

test.skipIf(!HAS_FFMPEG)('nome com espaco, acento, parenteses e aspas funciona', async () => {
  const result = await probeFile(fixture(NOME_DIFICIL));

  expect(result.durationMs).toBeGreaterThan(900);
  expect(result.videoCodec).toBe('h264');
  expect(result.width).toBe(160);
  expect(result.faststart).toBe(false);
});

test.skipIf(!HAS_FFMPEG)('JSON invalido na saida do ffprobe lanca ProbeError', async () => {
  const target = fixture('plain.mp4');

  const error = await probeFile(target, {
    ffprobePath: fixture('stub-json-invalido.sh'),
  }).catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(ProbeError);
  expect((error as ProbeError).filePath).toBe(target);
});

test.skipIf(!HAS_FFMPEG)('duracao zero e erro, nao resultado valido', async () => {
  const target = fixture('plain.mp4');

  const error = await probeFile(target, {
    ffprobePath: fixture('stub-duracao-zero.sh'),
  }).catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(ProbeError);
  expect((error as ProbeError).message).toContain('duracao invalida');
});

test.skipIf(!HAS_FFMPEG)('sem format.duration cai para a duracao do stream de video', async () => {
  const result = await probeFile(fixture('plain.mp4'), {
    ffprobePath: fixture('stub-sem-format.sh'),
  });

  expect(result.durationMs).toBe(1_320_500);
  expect(result.videoCodec).toBe('hevc');
  expect(result.audioCodec).toBeNull();
  expect(result.width).toBe(1920);
  expect(result.height).toBe(1080);
});

test.skipIf(!HAS_FFMPEG)('caixa free antes do mdat nao confunde a deteccao', async () => {
  const result = await probeFile(fixture('com-free.mp4'));

  expect(result.durationMs).toBeGreaterThan(900);
  expect(result.faststart).toBe(false);
});

test.skipIf(!HAS_FFMPEG)('capa embutida nao vira stream de video', async () => {
  const result = await probeFile(fixture('so-audio-com-capa.m4a'));

  expect(result.audioCodec).toBe('aac');
  expect(result.videoCodec).toBeNull();
  expect(result.width).toBeNull();
  expect(result.height).toBeNull();
});

test.skipIf(!HAS_FFMPEG)('falha ao ler os atomos tambem vira ProbeError', async () => {
  // O stub responde JSON valido para um arquivo que nao existe: quem falha e a
  // leitura dos atomos, e mesmo assim o erro que sai do modulo e ProbeError.
  const missing = fixture('sumiu-no-meio.mp4');

  const error = await probeFile(missing, {
    ffprobePath: fixture('stub-sem-format.sh'),
  }).catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(ProbeError);
  expect((error as ProbeError).filePath).toBe(missing);
});

test.skipIf(!HAS_FFMPEG)('ffprobePath inexistente lanca ProbeError', async () => {
  const target = fixture('plain.mp4');

  const error = await probeFile(target, {
    ffprobePath: fixture('nao-tem-esse-binario'),
  }).catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(ProbeError);
  expect((error as ProbeError).filePath).toBe(target);
});
