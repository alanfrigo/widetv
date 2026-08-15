import { randomUUID } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ShowMetadataRow, ShowRow } from '../library/index-store';
import {
  downloadImage,
  lookupShowMetadata,
  type ChainOptions,
  type LookupResult,
} from './providers';

/**
 * Enriquecimento do acervo com capa, ano e sinopse.
 *
 * Isto e I/O de rede no meio de um servidor de video: a regra que organiza o
 * modulo e que NENHUM request de usuario pode esperar por ele. `GET
 * /api/channels` no maximo *dispara* uma rodada e devolve o que ja existe no
 * indice; a capa aparece na proxima carga da tela.
 *
 * A trava de "ja rodando" nao e otimizacao. Sem ela, uma tela de canais que
 * recarrega a cada poucos segundos abriria uma rodada nova por carga, e 460
 * series x N rodadas simultaneas viram um flood na API do provedor - que
 * responde 429 e transforma um acervo inteiro em "nao encontrado".
 */

/** So leitura: e o que as rotas precisam para decidir se ha trabalho a fazer. */
export interface MetadataReader {
  listShows(): ShowRow[];
  getShowMetadata(showId: number): ShowMetadataRow | null;
}

/** Fonte estreita: este modulo so precisa das series e da tabela de metadata. */
export interface MetadataStore extends MetadataReader {
  upsertShowMetadata(row: ShowMetadataRow): void;
}

/** Quanto tempo um "nao encontrado" vale antes de valer a pena tentar de novo. */
export const NOT_FOUND_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Duas buscas em voo. O gargalo aqui nao e a nossa CPU, e a educacao com uma
 * API publica de graca: paralelismo alto so rende 429.
 */
const DEFAULT_CONCURRENCY = 2;

export interface EnrichOptions extends ChainOptions {
  concurrency?: number;
  /** Injetavel para teste. Default: `Date.now`. */
  now?: () => number;
  notFoundTtlMs?: number;
  /** Injetavel para teste; por padrao percorre a cadeia de provedores. */
  lookup?: (showName: string) => Promise<LookupResult>;
  /** Injetavel para teste; por padrao baixa a imagem de verdade. */
  download?: (url: string) => Promise<Uint8Array>;
  log?: (message: string) => void;
}

export interface EnrichReport {
  /** Series que estavam sem metadata (ou com not_found vencido) nesta rodada. */
  considered: number;
  found: number;
  /** Quantas ganharam arquivo de capa em disco. */
  posters: number;
  notFound: number;
  /** Falhas de rede: nada foi gravado, serao tentadas de novo. */
  failed: number;
}

/** Nome do arquivo de capa da serie. O id e numerico: nao ha o que escapar. */
export function posterFileName(showId: number): string {
  return `${String(showId)}.jpg`;
}

export function postersDir(dataDir: string): string {
  return join(dataDir, 'posters');
}

/**
 * Series que valem uma busca agora: as que nunca foram buscadas e as marcadas
 * como inexistentes ha mais de `ttlMs`. Uma serie ja encontrada nunca volta -
 * capa nao muda, e reconsultar 460 series a cada boot seria abuso.
 */
export function listShowsMissingMetadata(
  store: MetadataReader,
  nowMs: number,
  ttlMs: number = NOT_FOUND_TTL_MS,
): ShowRow[] {
  return store.listShows().filter((show) => {
    const row = store.getShowMetadata(show.id);
    if (row === null) return true;
    return row.notFound && nowMs - row.fetchedAt >= ttlMs;
  });
}

/** Ha alguma serie sem NENHUMA metadata? E o gatilho barato da rota de canais. */
export function hasShowsWithoutMetadata(store: MetadataReader): boolean {
  return store.listShows().some((show) => store.getShowMetadata(show.id) === null);
}

/** Roda `worker` sobre `items` com no maximo `limit` em voo. */
async function mapWithLimit<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await worker(items[index]!);
    }
  });
  await Promise.all(runners);
}

/**
 * Grava a capa em `<dataDir>/posters/<showId>.jpg`.
 *
 * Temporario + rename, como o cache de legenda: rename e atomico no mesmo
 * filesystem, entao a rota nunca serve um JPEG pela metade - nem quando a
 * pagina pede a capa no exato instante em que ela esta sendo baixada.
 */
async function writePoster(dir: string, showId: number, bytes: Uint8Array): Promise<string> {
  const fileName = posterFileName(showId);
  const target = join(dir, fileName);
  const tmp = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, bytes);
    await rename(tmp, target);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
  return fileName;
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function enrichOne(
  store: MetadataStore,
  dir: string,
  show: ShowRow,
  options: EnrichOptions,
  report: EnrichReport,
): Promise<void> {
  const now = options.now ?? Date.now;
  const lookup = options.lookup ?? ((name: string) => lookupShowMetadata(name, options));
  const download = options.download ?? ((url: string) => downloadImage(url, options));
  const log = options.log ?? ((): void => undefined);

  let result: LookupResult;
  try {
    result = await lookup(show.name);
  } catch (error) {
    // Provedor que lanca em vez de devolver `error` cai aqui: mesmo tratamento,
    // porque a diferenca que importa e "gravou" x "nao gravou".
    result = { status: 'error', reason: detail(error) };
  }

  if (result.status === 'error') {
    report.failed += 1;
    log(`metadata de "${show.name}" falhou: ${result.reason}`);
    return;
  }

  if (result.status === 'not-found') {
    report.notFound += 1;
    store.upsertShowMetadata({
      showId: show.id,
      posterFile: null,
      year: null,
      overview: null,
      source: null,
      fetchedAt: now(),
      notFound: true,
    });
    return;
  }

  const { metadata } = result;
  let posterFile: string | null = null;

  if (metadata.posterUrl !== null) {
    try {
      await mkdir(dir, { recursive: true });
      posterFile = await writePoster(dir, show.id, await download(metadata.posterUrl));
      report.posters += 1;
    } catch (error) {
      // A capa e a razao de ser disto tudo. Gravar a linha sem ela sela o show
      // como "ja resolvido" e a imagem nunca mais seria tentada; sem linha, a
      // proxima rodada tenta de novo.
      report.failed += 1;
      log(`capa de "${show.name}" falhou: ${detail(error)}`);
      return;
    }
  }

  report.found += 1;
  store.upsertShowMetadata({
    showId: show.id,
    posterFile,
    year: metadata.year,
    overview: metadata.overview,
    source: metadata.source,
    fetchedAt: now(),
    notFound: false,
  });
}

async function runEnrich(
  store: MetadataStore,
  dataDir: string,
  options: EnrichOptions,
  inFlight: Set<number>,
): Promise<EnrichReport> {
  const now = options.now ?? Date.now;
  const ttlMs = options.notFoundTtlMs ?? NOT_FOUND_TTL_MS;
  const dir = postersDir(dataDir);

  const pending = listShowsMissingMetadata(store, now(), ttlMs).filter(
    (show) => !inFlight.has(show.id),
  );
  const report: EnrichReport = {
    considered: pending.length,
    found: 0,
    posters: 0,
    notFound: 0,
    failed: 0,
  };
  if (pending.length === 0) return report;

  for (const show of pending) inFlight.add(show.id);
  try {
    await mapWithLimit(pending, options.concurrency ?? DEFAULT_CONCURRENCY, (show) =>
      enrichOne(store, dir, show, options, report),
    );
  } finally {
    for (const show of pending) inFlight.delete(show.id);
  }

  return report;
}

/**
 * Uma passada: busca metadata de toda serie que ainda nao tem.
 *
 * Nunca lanca por causa de uma serie: falha de rede vira contador no relatorio,
 * porque uma serie fora do ar nao pode abortar as outras 459.
 */
export function enrichMissing(
  store: MetadataStore,
  dataDir: string,
  options: EnrichOptions = {},
): Promise<EnrichReport> {
  return runEnrich(store, dataDir, options, new Set<number>());
}

export interface Enricher {
  /** Roda agora. Se uma rodada ja esta em andamento, devolve ELA, nao outra. */
  run(): Promise<EnrichReport>;
  /** Dispara sem esperar e sem propagar erro. E o que a rota de canais usa. */
  trigger(): void;
  readonly running: boolean;
}

/**
 * Enriquecedor com trava de "ja rodando".
 *
 * A trava e a propria promessa em andamento: chamadas concorrentes recebem a
 * mesma, entao nao ha duas varreduras do acervo ao mesmo tempo. O conjunto
 * `inFlight` cobre a segunda metade do problema - um show ja sendo buscado nao
 * entra na rodada seguinte, mesmo que ela comece antes desta terminar.
 */
export function createEnricher(
  store: MetadataStore,
  dataDir: string,
  options: EnrichOptions = {},
): Enricher {
  const inFlight = new Set<number>();
  let current: Promise<EnrichReport> | null = null;

  function run(): Promise<EnrichReport> {
    current ??= runEnrich(store, dataDir, options, inFlight).finally(() => {
      current = null;
    });
    return current;
  }

  return {
    run,
    trigger(): void {
      void run().catch((error: unknown) => {
        (options.log ?? ((): void => undefined))(`enriquecimento falhou: ${detail(error)}`);
      });
    },
    get running(): boolean {
      return current !== null;
    },
  };
}
