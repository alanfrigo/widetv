import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { backdropFileName, backdropsDir } from '../metadata/service';
import { resolveWithinRoot } from '../stream/direct';

import type { Store, ThumbCandidate } from './index-store';

/**
 * Quadros tirados do proprio video: a miniatura 16:9 de cada episodio e, quando
 * nenhum provedor tem uma, a arte 16:9 do canal.
 *
 * Nenhum provedor de metadata tem imagem por episodio de acervo caseiro, e o
 * desenho e feito delas - a lista de episodios e uma coluna de miniaturas, e as
 * faixas "No ar agora" e "Continuar assistindo" mostram literalmente o frame do
 * episodio. A saida e o ffmpeg, em segundo plano.
 *
 * ## Um por vez, e por que
 *
 * Concorrencia 1 e `-threads 1`. Este processo e o MESMO que esta entregando
 * video: dois ffmpeg competindo por CPU nao aparecem como "o servidor esta
 * ocupado", aparecem como travada na TV de quem esta assistindo. Um acervo de
 * 15 mil episodios sao 15 mil invocacoes, e a unica coisa que nao pode
 * acontecer e elas atropelarem o unico trabalho que tem hora marcada.
 *
 * ## Convivencia com o remux
 *
 * Os dois querem CPU e os dois rodam ao fim do mesmo scan. A escolha aqui e
 * PRIORIDADE PARA O REMUX, e nao fila unica compartilhada: enquanto o remux
 * roda, esta fila espera entre um episodio e o outro (`shouldYield`), e volta
 * sozinha quando ele termina. Justificativa: o remux e o que torna um MKV
 * TOCAVEL - sem ele o episodio simplesmente nao abre no navegador -, enquanto o
 * quadro e ilustracao, e a tela ja tem um desenho previsto para quando ele
 * falta. Uma fila unica inverteria isso na pratica: uma rodada de 15 mil
 * miniaturas na frente seguraria por horas a conversao que faz o acervo tocar.
 *
 * A espera e entre itens, nunca no meio de um: quando o remux comeca com uma
 * extracao em voo, os dois processos convivem pelo tempo de UM quadro (menos de
 * um segundo). Matar o ffmpeg no meio so trocaria isso por um arquivo pela
 * metade.
 *
 * ## Retomavel
 *
 * O servidor reinicia no meio de uma rodada de horas. Por isso o estado mora no
 * banco, uma linha por episodio, e nao numa lista em memoria: a rodada seguinte
 * pergunta ao indice quem ainda nao foi TENTADO e continua de onde parou.
 */

/** Miniatura do episodio: 16:9 do tamanho que a lista desenha. */
const THUMB_WIDTH = 480;
const THUMB_HEIGHT = 270;

/** Arte do canal: mesmo 16:9, no tamanho de um hero de tela cheia. */
const BACKDROP_WIDTH = 1280;
const BACKDROP_HEIGHT = 720;

/** Onde procurar o quadro do episodio, em fracao da duracao. */
const EPISODE_SEEK = 0.3;
/** Segunda tentativa, quando a primeira sai chapada. */
const EPISODE_RETRY_SEEK = 0.55;
/** Onde procurar a arte do canal. */
const BACKDROP_SEEK = 0.35;

/**
 * Abaixo disto o JPEG nao tem imagem nenhuma: tela preta, fade, cartela de
 * abertura. Um quadro de verdade em 480x270 nao sai com 3 KB nem no desenho
 * mais chapado que existe.
 */
const FLAT_FRAME_BYTES = 3 * 1024;

/** Um quadro nao demora; este teto e para o arquivo doente em disco de rede. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** De quanto em quanto tempo a fila reconsulta se o remux ainda esta rodando. */
const YIELD_POLL_MS = 2_000;

export interface ThumbReport {
  /** Episodios que a rodada olhou. */
  considered: number;
  generated: number;
  /** Ja tinham quadro, ou o arquivo sumiu do volume. */
  skipped: number;
  failed: number;
  /** Quantos precisaram da segunda tentativa por terem saido chapados. */
  retried: number;
  /** Artes 16:9 de canal tiradas de quadro nesta rodada. */
  backdrops: number;
  /** Arquivos orfaos removidos de `<DATA_DIR>/thumbs`. */
  removedFiles: number;
  durationMs: number;
}

export interface ThumbProgress {
  done: number;
  total: number;
  /** Serie do episodio sendo extraido; e o que a tela mostra. */
  show: string;
}

/** Assinatura do extrator, injetavel para testar o job sem ffmpeg. */
export type Grab = (options: {
  inputPath: string;
  /** Instante do quadro, em segundos. */
  atSeconds: number;
  width: number;
  height: number;
  outputPath: string;
}) => Promise<void>;

export interface ThumbJobOptions {
  store: Store;
  libraryRoot: string;
  /** DATA_DIR do servidor; os quadros vivem em `<dataDir>/thumbs`. */
  dataDir: string;
  /** true refaz o quadro de TODO episodio, inclusive os que ja tem. */
  reset?: boolean;
  ffmpegPath?: string;
  timeoutMs?: number;
  /** Extrator; injetavel para teste. */
  grab?: Grab;
  /**
   * "Tem trabalho mais importante rodando agora?" Consultado ENTRE episodios; o
   * controlador liga isto ao remux. Ausente = nada tem prioridade.
   */
  shouldYield?: () => boolean;
  /** De quanto em quanto tempo `shouldYield` e reconsultado. Injetavel para teste. */
  yieldPollMs?: number;
  onProgress?: (progress: ThumbProgress) => void;
  now?: () => number;
  log?: (message: string) => void;
}

export function thumbsDir(dataDir: string): string {
  return join(dataDir, 'thumbs');
}

/**
 * Nome do arquivo do quadro. O rowid e um inteiro: nao ha o que escapar, e ele
 * some junto com a linha - mesma escolha que a capa faz com `showId`.
 */
export function thumbFileName(rowId: number): string {
  return `${String(rowId)}.jpg`;
}

/**
 * Roda o ffmpeg gravando UM quadro em `outputPath`.
 *
 * `-ss` vem ANTES do `-i` de proposito: assim o ffmpeg salta direto para perto
 * do instante pedido em vez de decodificar o episodio inteiro ate chegar la. E
 * a diferenca entre 0,2 s e varios minutos por arquivo, e o preco (cair no
 * keyframe mais proximo) nao existe para o que se quer aqui - uma imagem
 * qualquer daquele trecho.
 *
 * Mesma disciplina do extrator de legenda: SIGKILL no timeout, 'exit' e nao
 * 'close', stderr curto na mensagem.
 */
export function ffmpegGrab(ffmpegPath: string, timeoutMs: number): Grab {
  return async ({ inputPath, atSeconds, width, height, outputPath }) => {
    const child = spawn(
      ffmpegPath,
      [
        '-nostdin',
        '-v', 'error',
        '-y',
        '-ss', atSeconds.toFixed(3),
        '-i', inputPath,
        // Um nucleo so: veja o cabecalho. O servidor esta entregando video.
        '-threads', '1',
        '-frames:v', '1',
        '-an', '-sn', '-dn',
        // Preenche o 16:9 e corta o excedente, em vez de deixar tarja. Acervo
        // antigo e 4:3, e a lista de episodios desenha uma caixa 16:9: escalar
        // sem cortar entregaria uma imagem com duas faixas pretas dentro de uma
        // moldura que ja tem fundo proprio.
        '-vf', `scale=${String(width)}:${String(height)}:force_original_aspect_ratio=increase,crop=${String(width)}:${String(height)}`,
        '-q:v', '4',
        '-f', 'image2',
        outputPath,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 2_000) stderr += chunk;
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      child.stderr.destroy();
    }, timeoutMs);

    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', (error) => {
          // Binario ausente no PATH cai aqui, sem nunca ter havido processo.
          child.stderr.destroy();
          reject(error);
        });
        child.once('exit', (code, signal) => {
          if (timedOut) {
            reject(new Error(`ffmpeg passou de ${String(timeoutMs)} ms e foi morto`));
          } else if (code === 0) {
            resolve();
          } else {
            reject(
              new Error(
                `ffmpeg saiu com ${String(code ?? signal)}: ${stderr.replace(/\s+/g, ' ').trim().slice(0, 300)}`,
              ),
            );
          }
        });
      });
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Tamanho do arquivo, ou 0 quando ele nem chegou a existir. */
async function sizeOf(path: string): Promise<number> {
  try {
    const info = await stat(path);
    return info.size;
  } catch {
    return 0;
  }
}

interface GrabAttempt {
  /** Precisou da segunda tentativa. */
  retried: boolean;
}

/**
 * Grava o quadro em `targetPath`, com a heuristica do quadro chapado.
 *
 * Escreve num temporario e renomeia: rename e atomico no mesmo filesystem,
 * entao a rota nunca serve meio JPEG - nem quando a tela pede a imagem no exato
 * instante em que ela esta sendo escrita.
 *
 * A segunda tentativa custa um seek a mais nos poucos arquivos que caem em
 * preto, e nada nos outros: o tamanho do arquivo ja esta na mao depois da
 * primeira, e ler o tamanho e mais barato do que decodificar qualquer coisa.
 */
async function grabTo(
  grab: Grab,
  options: {
    inputPath: string;
    durationMs: number;
    seek: number;
    retrySeek: number;
    width: number;
    height: number;
    targetPath: string;
  },
): Promise<GrabAttempt> {
  const tmpPath = `${options.targetPath}.${randomUUID()}.tmp`;
  const seconds = (fraction: number): number =>
    Math.max(0, (options.durationMs / 1000) * fraction);

  try {
    await grab({
      inputPath: options.inputPath,
      atSeconds: seconds(options.seek),
      width: options.width,
      height: options.height,
      outputPath: tmpPath,
    });

    let retried = false;
    if ((await sizeOf(tmpPath)) < FLAT_FRAME_BYTES) {
      retried = true;
      await grab({
        inputPath: options.inputPath,
        atSeconds: seconds(options.retrySeek),
        width: options.width,
        height: options.height,
        outputPath: tmpPath,
      });
    }

    // Nem a segunda tentativa produziu arquivo: nao ha o que renomear, e um
    // JPEG de zero byte no lugar do quadro seria pior que nenhum.
    if ((await sizeOf(tmpPath)) === 0) {
      throw new Error('ffmpeg terminou sem escrever quadro nenhum');
    }

    await rename(tmpPath, options.targetPath);
    return { retried };
  } catch (error) {
    await unlink(tmpPath).catch(() => undefined);
    throw error;
  }
}

/** Espera enquanto houver trabalho com prioridade. Volta na hora quando nao ha. */
async function waitForTurn(options: ThumbJobOptions): Promise<void> {
  const { shouldYield } = options;
  if (shouldYield === undefined) return;
  while (shouldYield()) {
    await new Promise((resolve) => setTimeout(resolve, options.yieldPollMs ?? YIELD_POLL_MS));
  }
}

/**
 * O episodio do MEIO da primeira temporada.
 *
 * Deterministico de proposito: a mesma serie da sempre a mesma arte, entao uma
 * rodada repetida nao muda a cara do catalogo. O meio, e nao o primeiro, porque
 * episodio de estreia costuma abrir com cartela ou creditos - e a primeira
 * temporada, e nao qualquer uma, porque e a que menos entrega o final da serie.
 */
export function pickBackdropEpisode<T extends { season: number | null; orderIndex: number }>(
  episodes: readonly T[],
): T | null {
  if (episodes.length === 0) return null;

  const seasons = episodes
    .map((episode) => episode.season)
    .filter((season): season is number => season !== null);
  const first = seasons.length === 0 ? null : Math.min(...seasons);

  // Serie sem pasta de temporada usa a grade inteira: e a mesma ordem que o
  // canal toca.
  const pool = first === null ? [...episodes] : episodes.filter((e) => e.season === first);
  const ordered = [...pool].sort((a, b) => a.orderIndex - b.orderIndex);
  return ordered[Math.floor(ordered.length / 2)] ?? null;
}

/**
 * Arte 16:9 de quem nao tem nenhuma, tirada de um quadro.
 *
 * Roda ANTES das miniaturas: sao poucas (uma por canal) e sao o fundo do hero,
 * a primeira coisa que a tela do catalogo desenha. As 15 mil miniaturas vem
 * depois porque cada uma so aparece quando a pessoa abre aquela serie.
 */
async function runBackdrops(
  options: ThumbJobOptions,
  grab: Grab,
  report: ThumbReport,
): Promise<void> {
  const { store, libraryRoot } = options;
  const log = options.log ?? ((): void => undefined);
  // Mesmo diretorio e mesmo nome de arquivo da arte baixada do provedor: a
  // rota do canal serve os dois sem saber a diferenca, e uma arte do TMDB que
  // chegue depois escreve por cima desta - que e exatamente a regra.
  const dir = backdropsDir(options.dataDir);

  const shows = store.listShowsWithoutBackdrop();
  if (shows.length === 0) return;
  await mkdir(dir, { recursive: true });

  for (const show of shows) {
    await waitForTurn(options);

    const chosen = pickBackdropEpisode(store.listEpisodes(show.id));
    if (chosen === null) continue;

    const inputPath = resolveWithinRoot(libraryRoot, chosen.id);
    if (inputPath === null) continue;

    try {
      await grabTo(grab, {
        inputPath,
        durationMs: chosen.durationMs,
        seek: BACKDROP_SEEK,
        retrySeek: EPISODE_RETRY_SEEK,
        width: BACKDROP_WIDTH,
        height: BACKDROP_HEIGHT,
        targetPath: join(dir, backdropFileName(show.id)),
      });
      // `frame` e o que permite uma arte do TMDB tomar este lugar depois. O
      // contrario nunca acontece: quadro nao substitui arte de provedor.
      store.setShowBackdrop({
        showId: show.id,
        file: backdropFileName(show.id),
        source: 'frame',
      });
      report.backdrops += 1;
    } catch (error) {
      // Um canal sem hero cai no padrao listrado, que e um desenho previsto:
      // nada aqui pode derrubar a rodada das miniaturas.
      log(
        `arte de quadro de "${show.name}" falhou: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }
}

/** Um episodio da fila. Nunca lanca: falha vira carimbo e contador. */
async function thumbOne(
  candidate: ThumbCandidate,
  options: ThumbJobOptions,
  grab: Grab,
  dir: string,
  now: () => number,
  report: ThumbReport,
): Promise<void> {
  const { store } = options;
  const log = options.log ?? ((): void => undefined);

  const inputPath = resolveWithinRoot(options.libraryRoot, candidate.episodeId);
  if (inputPath === null) {
    // Caminho que sai da raiz nao muda de ideia amanha: carimba para a fila nao
    // reoferecer o mesmo episodio em toda rodada.
    store.setEpisodeThumb({ episodeId: candidate.episodeId, file: null, checkedAt: now() });
    report.failed += 1;
    return;
  }

  try {
    await stat(inputPath);
  } catch {
    // Arquivo sumido do volume depois do scan e situacao normal num NAS - e o
    // proximo scan tira a linha do indice. Sem carimbo: nao houve tentativa.
    report.skipped += 1;
    return;
  }

  const file = thumbFileName(candidate.rowId);
  try {
    const { retried } = await grabTo(grab, {
      inputPath,
      durationMs: candidate.durationMs,
      seek: EPISODE_SEEK,
      retrySeek: EPISODE_RETRY_SEEK,
      width: THUMB_WIDTH,
      height: THUMB_HEIGHT,
      targetPath: join(dir, file),
    });
    if (retried) report.retried += 1;
    store.setEpisodeThumb({ episodeId: candidate.episodeId, file, checkedAt: now() });
    report.generated += 1;
  } catch (error) {
    // ffmpeg ausente do PATH, arquivo corrompido, codec que este build nao
    // decodifica: tudo isso e um episodio sem miniatura, nunca uma rodada
    // interrompida. O carimbo (sem arquivo) e o que impede a fila de tentar de
    // novo amanha, e no dia seguinte, com o mesmo resultado.
    store.setEpisodeThumb({ episodeId: candidate.episodeId, file: null, checkedAt: now() });
    report.failed += 1;
    log(
      `quadro de ${candidate.episodeId} falhou: ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}

/**
 * Uma rodada inteira: artes de canal que faltam, depois as miniaturas.
 *
 * Nunca lanca por causa de um episodio, pelo mesmo motivo do scan: um arquivo
 * doente nao pode abortar os outros 14.999.
 */
export async function runThumbs(options: ThumbJobOptions): Promise<ThumbReport> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const { store } = options;
  const grab =
    options.grab ??
    ffmpegGrab(options.ffmpegPath ?? 'ffmpeg', options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  const dir = thumbsDir(options.dataDir);
  await mkdir(dir, { recursive: true });

  const report: ThumbReport = {
    considered: 0,
    generated: 0,
    skipped: 0,
    failed: 0,
    retried: 0,
    backdrops: 0,
    removedFiles: 0,
    durationMs: 0,
  };

  await runBackdrops(options, grab, report);

  // A lista sai do banco de uma vez, e a partir daqui nenhuma consulta fica
  // aberta: cada ffmpeg roda com o SQLite livre para o resto do servidor.
  const pending = store.listThumbCandidates({ all: options.reset ?? false });
  report.considered = pending.length;

  let done = 0;
  for (const candidate of pending) {
    options.onProgress?.({ done, total: pending.length, show: candidate.showName });
    done += 1;
    await waitForTurn(options);
    await thumbOne(candidate, options, grab, dir, now, report);
  }
  options.onProgress?.({ done, total: pending.length, show: '' });

  // Coleta de orfaos: linha removida no rescan (serie que saiu do disco,
  // episodio renomeado) deixa o JPEG dela ocupando espaco para sempre. Inclui
  // .tmp de rodada interrompida.
  const keep = new Set(store.listThumbFiles());
  for (const entry of await readdir(dir)) {
    if (keep.has(entry)) continue;
    try {
      await unlink(join(dir, entry));
      report.removedFiles += 1;
    } catch {
      // Sumiu no meio do caminho: o objetivo (nao existir) foi atingido.
    }
  }

  // Uma vez, no fim: o cache de timeline carrega `thumbFile` junto do episodio,
  // e sem isto a faixa "No ar agora" so mostraria as miniaturas novas depois do
  // proximo scan.
  if (report.generated > 0) store.bumpIndexVersion();

  report.durationMs = now() - startedAt;
  return report;
}
