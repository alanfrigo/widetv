import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  openStore,
  type EpisodeInput,
  type Store,
} from '../../src/server/library/index-store';
import {
  GrabSpawnError,
  GrabTimeoutError,
  pickBackdropEpisode,
  runThumbs,
  thumbFileName,
  type Grab,
} from '../../src/server/library/thumb-job';

/**
 * O que estes testes protegem, em uma frase: um ffmpeg que falha, ou que devolve
 * uma tela preta, nao pode nem derrubar a rodada nem fazer o mesmo episodio
 * voltar para a fila todo dia.
 *
 * O extrator e injetado: o que esta sob teste e a fila, nao o ffmpeg.
 */

/** JPEG "de verdade": grande o bastante para nao parecer quadro chapado. */
const CHEIO = 'x'.repeat(8 * 1024);
/** Menos de 3 KB: tela preta, fade ou cartela. */
const CHAPADO = 'x'.repeat(500);
/** ffmpeg que terminou sem escrever arquivo nenhum. */
const NADA = '';

function episodeRow(id: string, over: Partial<EpisodeInput> = {}): EpisodeInput {
  return {
    id,
    absolutePath: `/lib/${id}`,
    title: id,
    season: 1,
    episode: 1,
    orderIndex: 0,
    durationMs: 1_200_000,
    videoCodec: 'h264',
    audioCodec: 'aac',
    width: 1920,
    height: 1080,
    faststart: true,
    audioTracks: [],
    subtitleTracks: [],
    mtimeMs: 111,
    size: 1000,
    ...over,
  };
}

interface Chamada {
  inputPath: string;
  atSeconds: number;
  width: number;
  height: number;
}

/**
 * Extrator de mentira: grava o conteudo que o teste mandar, na ordem em que os
 * quadros forem pedidos. `NADA` na lista e o ffmpeg que saiu sem deixar arquivo
 * util; posicao ausente vale um quadro bom.
 */
function fakeGrab(calls: Chamada[], conteudos: string[] = []): Grab {
  return async ({ inputPath, atSeconds, width, height, outputPath }) => {
    const conteudo = conteudos[calls.length] ?? CHEIO;
    calls.push({ inputPath, atSeconds, width, height });
    if (conteudo === NADA) return;
    await writeFile(outputPath, conteudo);
  };
}

let base: string;
let libraryRoot: string;
let dataDir: string;
let store: Store;
let showId: number;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'widetv-thumb-'));
  libraryRoot = join(base, 'acervo');
  dataDir = join(base, 'data');
  await mkdir(join(libraryRoot, 'Serie'), { recursive: true });
  await writeFile(join(libraryRoot, 'Serie', 'ep1.mkv'), 'mkv');
  await writeFile(join(libraryRoot, 'Serie', 'ep2.mkv'), 'mkv');

  store = openStore(':memory:');
  showId = store.upsertShow({
    slug: 'serie',
    name: 'Serie',
    absolutePath: join(libraryRoot, 'Serie'),
  }).id;
  store.upsertEpisodes(showId, [
    episodeRow('Serie/ep1.mkv'),
    episodeRow('Serie/ep2.mkv', { orderIndex: 1 }),
  ]);
  // A arte 16:9 do canal ja existe: os testes de miniatura nao querem o passo
  // dos backdrops no meio do caminho.
  store.setShowBackdrop({ showId, file: `${String(showId)}.jpg`, source: 'tmdb' });
});

afterEach(async () => {
  store.close();
  await rm(base, { recursive: true, force: true });
});

/** Nome do arquivo do quadro do episodio, como a fila o escolheria. */
function fileOf(episodeId: string): string {
  const candidato = store
    .listThumbCandidates({ all: true })
    .find((c) => c.episodeId === episodeId);
  return thumbFileName(candidato!.rowId);
}

describe('runThumbs', () => {
  test('tira um quadro por episodio, em 480x270, e grava o nome no indice', async () => {
    const calls: Chamada[] = [];
    const report = await runThumbs({ store, libraryRoot, dataDir, grab: fakeGrab(calls) });

    expect(report).toMatchObject({ considered: 2, generated: 2, skipped: 0, failed: 0 });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      inputPath: join(libraryRoot, 'Serie/ep1.mkv'),
      // 30% de 1.200.000 ms = 360 s.
      atSeconds: 360,
      width: 480,
      height: 270,
    });

    const file = fileOf('Serie/ep1.mkv');
    expect(store.getEpisode('Serie/ep1.mkv')?.thumbFile).toBe(file);
    expect(await readFile(join(dataDir, 'thumbs', file), 'utf8')).toBe(CHEIO);
    // Sem `.tmp` sobrando: escreveu no temporario e renomeou.
    expect((await readdir(join(dataDir, 'thumbs'))).sort()).toEqual(
      [fileOf('Serie/ep1.mkv'), fileOf('Serie/ep2.mkv')].sort(),
    );
  });

  test('quadro chapado (JPEG minusculo) rende uma segunda tentativa em 55%', async () => {
    const calls: Chamada[] = [];
    // O primeiro episodio cai numa tela preta; o segundo sai bom de primeira.
    const report = await runThumbs({
      store,
      libraryRoot,
      dataDir,
      grab: fakeGrab(calls, [CHAPADO, CHEIO, CHEIO]),
    });

    expect(report.generated).toBe(2);
    expect(report.retried).toBe(1);
    // Tres chamadas para dois episodios: so o que caiu em preto pagou o seek a
    // mais. O caso bom nao custa decodificacao nenhuma extra.
    expect(calls.map((c) => c.atSeconds)).toEqual([360, 660, 360]);
    // Fica com o SEGUNDO resultado, e nao com a tela preta.
    expect(await readFile(join(dataDir, 'thumbs', fileOf('Serie/ep1.mkv')), 'utf8')).toBe(CHEIO);
  });

  test('segunda tentativa tambem chapada ainda vale como quadro', async () => {
    // Desenho quase todo branco existe; recusar aqui deixaria o episodio sem
    // miniatura para sempre por causa de um palpite sobre tamanho de arquivo.
    const calls: Chamada[] = [];
    await runThumbs({
      store,
      libraryRoot,
      dataDir,
      grab: fakeGrab(calls, [CHAPADO, CHAPADO]),
    });

    expect(store.getEpisode('Serie/ep1.mkv')?.thumbFile).toBe(fileOf('Serie/ep1.mkv'));
    expect(await readFile(join(dataDir, 'thumbs', fileOf('Serie/ep1.mkv')), 'utf8')).toBe(CHAPADO);
  });

  test('ffmpeg que falha no ARQUIVO carimba o episodio e NAO tenta de novo na proxima rodada', async () => {
    const falha: Grab = () => Promise.reject(new Error('ffmpeg saiu com 1: moov atom not found'));
    const primeiro = await runThumbs({ store, libraryRoot, dataDir, grab: falha });

    expect(primeiro).toMatchObject({ considered: 2, generated: 0, failed: 2 });
    expect(store.getEpisode('Serie/ep1.mkv')?.thumbFile).toBeNull();
    // O carimbo e o que impede a fila de gastar dois ffmpeg por dia, para
    // sempre, nos mesmos dois arquivos.
    expect(store.getEpisode('Serie/ep1.mkv')?.thumbCheckedAt).not.toBeNull();

    const calls: Chamada[] = [];
    const segundo = await runThumbs({ store, libraryRoot, dataDir, grab: fakeGrab(calls) });
    expect(segundo.considered).toBe(0);
    expect(calls).toHaveLength(0);

    // Mas o botao "refazer todos" ignora o carimbo.
    const reset = await runThumbs({ store, libraryRoot, dataDir, reset: true, grab: fakeGrab(calls) });
    expect(reset.generated).toBe(2);
  });

  test('binario ausente (spawn) aborta a rodada SEM envenenar o acervo', async () => {
    const semFfmpeg: Grab = () => Promise.reject(new GrabSpawnError('spawn ffmpeg ENOENT'));
    await expect(runThumbs({ store, libraryRoot, dataDir, grab: semFfmpeg })).rejects.toThrow(
      'ENOENT',
    );

    // Nenhum episodio carimbado: com o ffmpeg de volta (PATH consertado), a
    // proxima rodada automatica refaz tudo. Carimbar 15 mil linhas por causa
    // de um binario ausente seria a pior resposta possivel.
    expect(store.getEpisode('Serie/ep1.mkv')?.thumbCheckedAt).toBeNull();
    expect(store.getEpisode('Serie/ep2.mkv')?.thumbCheckedAt).toBeNull();
  });

  test('timeout e transitorio: pula sem carimbo e a proxima rodada tenta de novo', async () => {
    let chamadas = 0;
    const lento: Grab = async ({ outputPath }) => {
      chamadas += 1;
      if (chamadas === 1) throw new GrabTimeoutError('ffmpeg passou de 60000 ms e foi morto');
      await writeFile(outputPath, CHEIO);
    };

    const primeira = await runThumbs({ store, libraryRoot, dataDir, grab: lento });
    expect(primeira).toMatchObject({ skipped: 1, generated: 1, failed: 0 });
    expect(store.getEpisode('Serie/ep1.mkv')?.thumbCheckedAt).toBeNull();

    const segunda = await runThumbs({ store, libraryRoot, dataDir, grab: lento });
    expect(segunda.generated).toBe(1);
    expect(store.getEpisode('Serie/ep1.mkv')?.thumbFile).not.toBeNull();
  });

  test('retryFailed reprocessa so quem falhou, sem refazer os prontos', async () => {
    // ep1 falha de arquivo (NADA nas duas tentativas), ep2 sai bem.
    const primeira = await runThumbs({
      store,
      libraryRoot,
      dataDir,
      grab: fakeGrab([], [NADA, NADA, CHEIO]),
    });
    expect(primeira).toMatchObject({ generated: 1, failed: 1 });

    // Rodada normal nao insiste no carimbado...
    const normal = await runThumbs({ store, libraryRoot, dataDir, grab: fakeGrab([]) });
    expect(normal.considered).toBe(0);

    // ...mas a rodada de boot (retryFailed) da a segunda chance so a ele.
    const calls: Chamada[] = [];
    const retry = await runThumbs({
      store,
      libraryRoot,
      dataDir,
      retryFailed: true,
      grab: fakeGrab(calls),
    });
    expect(retry.considered).toBe(1);
    expect(calls).toHaveLength(1);
    expect(store.getEpisode('Serie/ep1.mkv')?.thumbFile).not.toBeNull();
  });

  test('ffmpeg que sai sem escrever nada conta como falha, e nao como quadro vazio', async () => {
    const calls: Chamada[] = [];
    const report = await runThumbs({
      store,
      libraryRoot,
      dataDir,
      grab: fakeGrab(calls, [NADA, NADA, CHEIO, CHEIO]),
    });

    expect(report.failed).toBe(1);
    expect(report.generated).toBe(1);
    expect(store.getEpisode('Serie/ep1.mkv')?.thumbFile).toBeNull();
    // Nem o arquivo vazio nem o temporario ficaram para tras.
    expect(await readdir(join(dataDir, 'thumbs'))).toEqual([fileOf('Serie/ep2.mkv')]);
  });

  test('arquivo sumido do volume e pulado SEM carimbo: nao houve tentativa', async () => {
    await rm(join(libraryRoot, 'Serie', 'ep1.mkv'));
    const calls: Chamada[] = [];
    const report = await runThumbs({ store, libraryRoot, dataDir, grab: fakeGrab(calls) });

    expect(report).toMatchObject({ skipped: 1, generated: 1, failed: 0 });
    expect(calls).toHaveLength(1);
    expect(store.getEpisode('Serie/ep1.mkv')?.thumbCheckedAt).toBeNull();
  });

  test('rodada seguinte so olha quem falta: a fila e retomavel', async () => {
    const calls: Chamada[] = [];
    await runThumbs({ store, libraryRoot, dataDir, grab: fakeGrab(calls) });
    expect(calls).toHaveLength(2);

    // Servidor reiniciou; a rodada do boot nao refaz o que ja esta pronto.
    store.upsertEpisodes(showId, [episodeRow('Serie/ep3.mkv', { orderIndex: 2 })]);
    await writeFile(join(libraryRoot, 'Serie', 'ep3.mkv'), 'mkv');

    const segundo = await runThumbs({ store, libraryRoot, dataDir, grab: fakeGrab(calls) });
    expect(segundo.considered).toBe(1);
    expect(calls).toHaveLength(3);
    expect(calls[2]?.inputPath).toBe(join(libraryRoot, 'Serie/ep3.mkv'));
  });

  test('quadro de episodio que saiu do indice e recolhido do disco', async () => {
    const calls: Chamada[] = [];
    await runThumbs({ store, libraryRoot, dataDir, grab: fakeGrab(calls) });
    const orfao = fileOf('Serie/ep2.mkv');

    // Rescan tirou o episodio (arquivo renomeado no NAS).
    store.pruneEpisodes(showId, ['Serie/ep1.mkv']);
    const report = await runThumbs({ store, libraryRoot, dataDir, grab: fakeGrab(calls) });

    expect(report.removedFiles).toBe(1);
    expect(await readdir(join(dataDir, 'thumbs'))).toEqual([fileOf('Serie/ep1.mkv')]);
    expect(orfao).not.toBe(fileOf('Serie/ep1.mkv'));
  });

  test('cede a vez enquanto houver trabalho com prioridade', async () => {
    const calls: Chamada[] = [];
    let ocupado = true;
    const rodada = runThumbs({
      store,
      libraryRoot,
      dataDir,
      grab: fakeGrab(calls),
      shouldYield: () => ocupado,
      yieldPollMs: 5,
    });

    // Remux rodando: nenhum ffmpeg de miniatura comeca.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toHaveLength(0);

    ocupado = false;
    const report = await rodada;
    expect(report.generated).toBe(2);
  });

  test('progresso conta episodios e termina zerando a serie da vez', async () => {
    const progresso: { done: number; total: number; show: string }[] = [];
    await runThumbs({
      store,
      libraryRoot,
      dataDir,
      grab: fakeGrab([]),
      onProgress: (p) => progresso.push(p),
    });

    expect(progresso[0]).toEqual({ done: 0, total: 2, show: 'Serie' });
    expect(progresso.at(-1)).toEqual({ done: 2, total: 2, show: '' });
  });
});

describe('arte 16:9 tirada de quadro', () => {
  beforeEach(() => {
    // Desfaz o atalho do setup: aqui o canal esta sem arte nenhuma, que e o
    // estado de um servidor sem TMDB_API_KEY.
    store.upsertShowMetadata({
      showId,
      posterFile: null,
      backdropFile: null,
      backdropCheckedAt: null,
      backdropSource: null,
      year: null,
      overview: null,
      source: null,
      fetchedAt: 0,
      notFound: true,
      manual: false,
    });
  });

  test('sai do meio da primeira temporada, em 35%, e em 1280x720', async () => {
    store.upsertEpisodes(showId, [
      episodeRow('Serie/s01e01.mkv', { season: 1, orderIndex: 0 }),
      episodeRow('Serie/s01e02.mkv', { season: 1, orderIndex: 1, durationMs: 600_000 }),
      episodeRow('Serie/s01e03.mkv', { season: 1, orderIndex: 2 }),
      episodeRow('Serie/s02e01.mkv', { season: 2, orderIndex: 3 }),
    ]);
    store.pruneEpisodes(showId, [
      'Serie/s01e01.mkv',
      'Serie/s01e02.mkv',
      'Serie/s01e03.mkv',
      'Serie/s02e01.mkv',
    ]);
    await writeFile(join(libraryRoot, 'Serie', 's01e02.mkv'), 'mkv');

    const calls: Chamada[] = [];
    const report = await runThumbs({ store, libraryRoot, dataDir, grab: fakeGrab(calls) });

    expect(report.backdrops).toBe(1);
    // A arte vem ANTES das miniaturas: e o fundo do hero, a primeira coisa que
    // a tela do catalogo desenha.
    expect(calls[0]).toEqual({
      inputPath: join(libraryRoot, 'Serie/s01e02.mkv'),
      atSeconds: 210,
      width: 1280,
      height: 720,
    });

    const row = store.getShowMetadata(showId)!;
    expect(row.backdropFile).toBe(`${String(showId)}.jpg`);
    // 'frame' e o que permite uma arte do TMDB tomar este lugar depois.
    expect(row.backdropSource).toBe('frame');
    await expect(stat(join(dataDir, 'backdrops', `${String(showId)}.jpg`))).resolves.toBeTruthy();
  });

  test('canal que ja tem arte nao ganha outra', async () => {
    store.setShowBackdrop({ showId, file: `${String(showId)}.jpg`, source: 'tmdb' });
    const calls: Chamada[] = [];
    const report = await runThumbs({ store, libraryRoot, dataDir, grab: fakeGrab(calls) });

    expect(report.backdrops).toBe(0);
    expect(store.getShowMetadata(showId)?.backdropSource).toBe('tmdb');
    // So as miniaturas rodaram.
    expect(calls.every((c) => c.width === 480)).toBe(true);
  });

  test('falha na arte nao derruba a rodada das miniaturas', async () => {
    let primeira = true;
    const calls: Chamada[] = [];
    const grab: Grab = async (options) => {
      if (primeira) {
        primeira = false;
        throw new Error('ffmpeg morreu');
      }
      await fakeGrab(calls)(options);
    };

    const report = await runThumbs({ store, libraryRoot, dataDir, grab });
    expect(report.backdrops).toBe(0);
    expect(report.generated).toBe(2);
    // Sem arte, o canal cai no padrao listrado - que e um desenho previsto.
    expect(store.getShowMetadata(showId)?.backdropFile).toBeNull();
  });
});

describe('pickBackdropEpisode', () => {
  const ep = (season: number | null, orderIndex: number) => ({ season, orderIndex });

  test('meio da primeira temporada, deterministico', () => {
    const episodios = [ep(2, 3), ep(1, 0), ep(1, 2), ep(1, 1)];
    expect(pickBackdropEpisode(episodios)).toEqual(ep(1, 1));
    // A mesma serie da sempre a mesma arte: uma rodada repetida nao muda a cara
    // do catalogo.
    expect(pickBackdropEpisode([...episodios].reverse())).toEqual(ep(1, 1));
  });

  test('serie sem pasta de temporada usa a grade inteira', () => {
    expect(pickBackdropEpisode([ep(null, 0), ep(null, 1), ep(null, 2)])).toEqual(ep(null, 1));
  });

  test('canal vazio nao tem de onde tirar arte', () => {
    expect(pickBackdropEpisode([])).toBeNull();
  });
});
