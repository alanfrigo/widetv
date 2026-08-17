import { stat } from 'node:fs/promises';
import { cpus } from 'node:os';

import { mergeDuplicateShows } from './dedupe';
import type { EpisodeInput, Store } from './index-store';
import { probeFile } from './probe';
import type { ProbeResult } from './probe-types';
import { scanLibrary, type ScannedEpisode } from './scanner';
import { applyShowOverrides, channelNumberFixes } from './overrides.js';

/**
 * Orquestracao do scan: caminha o acervo, mede o que mudou e grava o indice.
 *
 * E o unico lugar caro do sistema - 14 mil arquivos, um ffprobe cada - entao
 * roda fora do caminho de request e evita reprocessar o que ja conhece.
 */

export interface ScanFailure {
  path: string;
  reason: string;
}

export interface ScanReport {
  shows: number;
  episodes: number;
  /** Arquivos que precisaram de ffprobe nesta rodada. */
  probed: number;
  /** Arquivos aproveitados do cache por mtime e tamanho. */
  cached: number;
  removedEpisodes: number;
  removedShows: number;
  failed: ScanFailure[];
  durationMs: number;
}

export interface ScanProgress {
  done: number;
  total: number;
  show: string;
}

export interface ScanJobOptions {
  root: string;
  store: Store;
  /** Injetavel para teste; por padrao chama o ffprobe de verdade. */
  probe?: (filePath: string) => Promise<ProbeResult>;
  /** Caminho do binario do ffprobe quando ele nao esta no PATH (launchd, container). */
  ffprobePath?: string;
  concurrency?: number;
  onProgress?: (progress: ScanProgress) => void;
  /** Repassado ao scanner: junta pastas de release da mesma serie. Default: true. */
  smartGrouping?: boolean;
  /**
   * false ignora o probe cacheado por (mtime, tamanho) e reabre TODO arquivo.
   * E o modo "scan completo" do painel: quando o indice esta torto, o cache e
   * justamente o que estava errado. Default: true.
   */
  useCache?: boolean;
}

interface Measured {
  episode: ScannedEpisode;
  probe: ProbeResult;
  mtimeMs: number;
  size: number;
  fromCache: boolean;
}

/** Roda `worker` sobre `items` com no maximo `limit` em voo. */
async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!);
    }
  });

  await Promise.all(runners);
  return results;
}

/**
 * O scan nao escreve o quadro do episodio: quem escreve e a fila de miniaturas,
 * e o indice preserva a coluna quando o rescan reencontra o MESMO arquivo. Por
 * isso o tipo de escrita e mais estreito que a linha lida.
 */
function toRow(measured: Measured, showId: number): EpisodeInput {
  const { episode, probe, mtimeMs, size } = measured;
  return {
    id: episode.relativePath,
    absolutePath: episode.absolutePath,
    title: episode.title,
    season: episode.season,
    episode: episode.episode,
    orderIndex: episode.orderIndex,
    durationMs: probe.durationMs,
    videoCodec: probe.videoCodec,
    audioCodec: probe.audioCodec,
    width: probe.width,
    height: probe.height,
    faststart: probe.faststart,
    audioTracks: probe.audioTracks,
    subtitleTracks: probe.subtitleTracks,
    mtimeMs,
    size,
  };
}

export async function runScan(options: ScanJobOptions): Promise<ScanReport> {
  const startedAt = Date.now();
  const { root, store } = options;
  const probe =
    options.probe ??
    ((filePath: string) => probeFile(filePath, { ffprobePath: options.ffprobePath ?? 'ffprobe' }));
  const concurrency = options.concurrency ?? Math.max(2, cpus().length);
  const useCache = options.useCache ?? true;

  // Canais duplicados de scanners antigos saem ANTES de tocar o disco. O prune
  // do fim so acontece em rodada perfeita: uma raiz sem permissao ou um volume
  // desmontado lancam ja na caminhada, e a duplicata sobreviveria para sempre.
  // Aqui ela morre mesmo no scan que vai falhar dez linhas abaixo.
  const mergedShows = mergeDuplicateShows(store);

  // A curadoria entra ANTES da gravacao: alias funde as pastas, o nome manual
  // substitui o derivado. Depois deste ponto o resto do job nao sabe que
  // existe painel nenhum - ele so grava a lista de series que recebeu.
  const scanned = await scanLibrary(root, { smartGrouping: options.smartGrouping ?? true });
  const shows = applyShowOverrides(scanned, store.listShowAliases(), store.listShowOverrides());
  const total = shows.reduce((sum, show) => sum + show.episodes.length, 0);

  const failed: ScanFailure[] = [];
  const keptSlugs: string[] = [];
  // Series cujos arquivos falharam TODOS nesta rodada (permissao, I/O). Elas
  // nao viram canal novo, mas tambem nao podem ser podadas: prune aqui
  // transformaria uma ACL errada no NAS em canal apagado e renumerado.
  const protectedSlugs: string[] = [];
  let probed = 0;
  let cached = 0;
  let removedEpisodes = 0;
  let episodes = 0;
  let done = 0;

  for (const show of shows) {
    const measured = await mapWithLimit(show.episodes, concurrency, async (episode) => {
      try {
        const info = await stat(episode.absolutePath);

        // O par (mtime, tamanho) e o que decide se vale reabrir o arquivo.
        // `useCache: false` nem pergunta ao indice: e o scan completo, que
        // existe justamente para desconfiar do que esta gravado.
        const hit = useCache
          ? store.getCachedProbe(episode.relativePath, info.mtimeMs, info.size)
          : null;
        const result = hit ?? (await probe(episode.absolutePath));

        return {
          episode,
          probe: result,
          mtimeMs: info.mtimeMs,
          size: info.size,
          fromCache: hit !== null,
        } satisfies Measured;
      } catch (error) {
        failed.push({
          path: episode.absolutePath,
          reason: error instanceof Error ? error.message : String(error),
        });
        return null;
      } finally {
        done += 1;
        options.onProgress?.({ done, total, show: show.name });
      }
    });

    const usable = measured.filter((m): m is Measured => m !== null);
    for (const item of usable) {
      if (item.fromCache) cached += 1;
      else probed += 1;
    }

    // Serie sem nenhum arquivo legivel nao vira canal: um canal vazio quebra o
    // relogio da grade. Mas o scanner SO chega aqui com episodio em disco,
    // entao usable vazio significa falha de leitura, nao pasta removida - o
    // canal que ja existe no indice fica como esta ate uma rodada limpa.
    if (usable.length === 0) {
      protectedSlugs.push(show.slug);
      continue;
    }

    const row = store.upsertShow({
      slug: show.slug,
      name: show.name,
      absolutePath: show.absolutePath,
    });
    keptSlugs.push(show.slug);

    const rows = usable.map((item) => toRow(item, row.id));
    store.upsertEpisodes(row.id, rows);
    removedEpisodes += store.pruneEpisodes(
      row.id,
      rows.map((r) => r.id),
    );
    episodes += rows.length;
  }

  // Um canal fundido na limpeza de duplicatas e um canal que sumiu do painel:
  // conta como removido, que e o que a pessoa ve.
  const removedShows = mergedShows + store.pruneShows([...keptSlugs, ...protectedSlugs]);

  // Serie apagada e recriada (pasta que sumiu e voltou) renasce num canal
  // qualquer: o contador nunca recicla numero. Isto devolve o numero escolhido.
  for (const fix of channelNumberFixes(store.listShows(), store.listShowOverrides())) {
    store.setChannelNumber(fix.showId, fix.channelNumber);
  }

  return {
    shows: keptSlugs.length,
    episodes,
    probed,
    cached,
    removedEpisodes,
    removedShows,
    failed,
    durationMs: Date.now() - startedAt,
  };
}
