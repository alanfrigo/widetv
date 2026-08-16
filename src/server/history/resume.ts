import type { ResumeEntry } from '@shared/api-types';

import { backdropUrlOf, posterUrlOf, toRef } from '../channels/service';
import type {
  EpisodeRow,
  ShowMetadataRow,
  ShowRow,
  WatchHistoryEntry,
} from '../library/index-store';

/**
 * "Continuar assistindo" resolvido pelo servidor.
 *
 * O historico cru so guarda id de episodio e numero de canal. Montar a faixa a
 * partir dele obrigaria o cliente a pedir os episodios de cada canal do
 * historico so para descobrir um titulo - com 20 linhas de canais distintos,
 * 20 requests antes de a primeira capa aparecer.
 */

/** Fonte estreita: so o que a faixa precisa do Store. */
export interface ResumeSource {
  listWatchHistory(limit: number): WatchHistoryEntry[];
  getEpisode(id: string): EpisodeRow | null;
  getShowByChannel(channelNumber: number): ShowRow | null;
  getShowMetadata(showId: number): ShowMetadataRow | null;
}

/**
 * Teto da faixa. Vinte cabe numa fileira que rola sem virar uma segunda tela de
 * historico - o historico completo continua em `GET /api/history`.
 */
export const RESUME_LIMIT = 20;

/**
 * Quantas linhas cruas ler para conseguir montar `limit` cards.
 *
 * A consulta traz o historico inteiro, e daqui saem os vistos e os episodios
 * repetidos da mesma serie. Numa maratona, as vinte linhas mais recentes sao
 * facilmente vinte episodios do MESMO desenho - ler so `limit` devolveria uma
 * faixa com um card. A folga e generosa porque a leitura e local e barata.
 */
const SCAN_FACTOR = 10;

/**
 * As ultimas posicoes salvas, da mais recente para a mais antiga.
 *
 * Tres coisas ficam de fora:
 *
 * - entrada cujo episodio ou canal sumiu num rescan, porque retomar um arquivo
 *   que nao existe mais nao significa nada e um card sem titulo parece falha do
 *   servidor;
 * - episodio ja marcado como visto, que e o que "continuar" exclui por
 *   definicao;
 * - segunda linha da MESMA serie. A faixa responde "onde eu estou em cada
 *   serie", e sem isto uma maratona de sabado ocuparia os vinte cards com o
 *   mesmo desenho e esconderia todo o resto.
 *
 * O `limit` e cortado dos dois lados (na consulta e no laco) porque a fonte e
 * uma interface: quem a implementar diferente nao pode estourar o contrato.
 */
export function listResume(source: ResumeSource, limit: number = RESUME_LIMIT): ResumeEntry[] {
  const entries: ResumeEntry[] = [];
  const seenShows = new Set<number>();

  for (const row of source.listWatchHistory(limit * SCAN_FACTOR)) {
    if (row.watchedAt !== null) continue;

    const episode = source.getEpisode(row.episodeId);
    if (episode === null) continue;

    const show = source.getShowByChannel(row.channelNumber);
    if (show === null) continue;

    // A lista chega ordenada por `updated_at` desc, entao a primeira linha de
    // cada serie ja e a mais recente dela: basta ignorar as seguintes.
    if (seenShows.has(show.id)) continue;
    seenShows.add(show.id);

    const metadata = source.getShowMetadata(show.id);
    entries.push({
      channelNumber: show.channelNumber,
      channelName: show.name,
      posterUrl: posterUrlOf(show.channelNumber, metadata),
      backdropUrl: backdropUrlOf(show.channelNumber, metadata),
      episode: toRef(episode),
      positionMs: row.positionMs,
      durationMs: row.durationMs,
      updatedAt: row.updatedAt,
    });

    if (entries.length === limit) break;
  }

  return entries;
}
