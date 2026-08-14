import type { ChannelSummary, EpisodeRef, NowPlaying } from '@shared/api-types';

import type { EpisodeRow, ShowRow } from '../library/index-store';
import { buildTimeline, channelPhaseOffsetMs, resolveSlot } from '../schedule/clock';

/**
 * Traducao entre o acervo em disco e a grade ao vivo.
 *
 * Recebe uma fonte estreita em vez do `Store` inteiro: e o que permite testar
 * a grade com dados em memoria, sem SQLite, e o que impede este modulo de
 * ganhar acesso a escrita sem querer.
 */
export interface ChannelSource {
  listShows(): ShowRow[];
  getShowByChannel(channelNumber: number): ShowRow | null;
  listEpisodes(showId: number): EpisodeRow[];
}

/** Reduz a linha do banco ao que o contrato publico expoe. */
function toRef(row: EpisodeRow): EpisodeRef {
  return {
    id: row.id,
    title: row.title,
    season: row.season,
    episode: row.episode,
    durationMs: row.durationMs,
    width: row.width,
    height: row.height,
    audioTracks: row.audioTracks,
    subtitleTracks: row.subtitleTracks,
  };
}

function toSummary(show: ShowRow, episodeCount: number): ChannelSummary {
  return { number: show.channelNumber, name: show.name, episodeCount };
}

export function listChannels(source: ChannelSource): ChannelSummary[] {
  return source
    .listShows()
    .map((show) => toSummary(show, source.listEpisodes(show.id).length))
    .filter((channel) => channel.episodeCount > 0)
    .sort((a, b) => a.number - b.number);
}

/**
 * Onde o canal esta agora.
 *
 * @param epochMs  instante zero global da grade
 * @param nowMs    relogio do servidor; entra por parametro para o resultado ser reproduzivel
 * @returns `null` quando o canal nao existe ou nao tem episodio - nunca lanca por isso,
 *          porque um canal vazio e um estado normal do acervo, nao um erro de programa.
 */
export function resolveNowPlaying(
  source: ChannelSource,
  channelNumber: number,
  epochMs: number,
  nowMs: number,
): NowPlaying | null {
  const show = source.getShowByChannel(channelNumber);
  if (show === null) return null;

  const episodes = source.listEpisodes(show.id);
  if (episodes.length === 0) return null;

  const timeline = buildTimeline(episodes);
  const cycleMs = timeline[timeline.length - 1]!;

  // Desloca o inicio do canal por um valor estavel derivado do slug, para que
  // canais distintos nao estejam todos no episodio 1 no mesmo instante.
  const phase = channelPhaseOffsetMs(show.slug, cycleMs);
  const slot = resolveSlot(episodes, epochMs - phase, nowMs, timeline);

  return {
    channel: toSummary(show, episodes.length),
    episode: toRef(episodes[slot.index]!),
    offsetMs: slot.offsetMs,
    serverTimeMs: nowMs,
    endsAtMs: slot.endsAtMs,
    next: toRef(episodes[slot.nextIndex]!),
  };
}

/**
 * Episodios do canal na ordem da grade, para o catalogo sob demanda.
 * @returns null quando o canal nao existe; [] quando existe sem episodios.
 */
export function listChannelEpisodes(
  source: ChannelSource,
  channelNumber: number,
): EpisodeRef[] | null {
  const show = source.getShowByChannel(channelNumber);
  if (show === null) return null;
  return source.listEpisodes(show.id).map(toRef);
}
