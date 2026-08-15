import { API } from '@shared/api-types';
import type { ChannelSummary, EpisodeRef, NowPlaying } from '@shared/api-types';

import type { EpisodeRow, ShowMetadataRow, ShowRow } from '../library/index-store';
import { channelPhaseOffsetMs, resolveSlot } from '../schedule/clock';

import { readGrid, type TimelineCache } from './timeline-cache';

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
  /** Quantos episodios cada serie tem, de uma vez, para a listagem do catalogo. */
  countEpisodesByShow(): Map<number, number>;
  /** Temporadas de uma serie, crescente; `[]` quando nao usa pastas. */
  listSeasons(showId: number): number[];
  /** As temporadas de todas as series de uma vez, para a listagem do catalogo. */
  listSeasonsByShow(): Map<number, number[]>;
  /** Capa/arte/ano/sinopse da serie; null quando a busca ainda nao rodou. */
  getShowMetadata(showId: number): ShowMetadataRow | null;
  /** Ha serie sem metadata? Gatilho barato da listagem, resolvido no banco. */
  hasShowsWithoutMetadata(): boolean;
  /** Muda quando a grade muda; e o que invalida o cache de timeline. */
  indexVersion(): number;
}

/**
 * Reduz a linha do banco ao que o contrato publico expoe.
 *
 * As faixas de audio sao as do arquivo FONTE: e a lista de dublagens que
 * existem de verdade, e o `index` delas e o `N` que o `?audio=N` do stream
 * entende. A gemea AAC que o remux acrescenta e detalhe de implementacao e
 * nao aparece aqui - o cliente troca de dublagem trocando de arquivo, nunca
 * escolhendo faixa dentro dele.
 */
export function toRef(row: EpisodeRow): EpisodeRef {
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
    // Sai da COLUNA, sem `stat` no disco - mesma razao da capa logo abaixo:
    // isto roda uma vez por episodio em `/api/channels/:n/episodes` e duas
    // vezes por canal em `/api/now`, e uma chamada sincrona ao filesystem por
    // linha custaria mais do que vale. A coluna so ganha o nome do arquivo
    // DEPOIS de ele existir, e a rota do quadro confere o arquivo de verdade
    // antes de servir - um 404 la e mais barato que a lentidao aqui.
    thumbUrl: row.thumbFile === null ? null : API.thumb(row.id),
  };
}

/**
 * As duas artes saem das colunas `poster_file`/`backdrop_file`, e nao de um
 * `stat` no disco: estas funcoes rodam a cada `GET /api/channels` e 460
 * chamadas sincronas ao filesystem por request custariam mais do que valem. A
 * linha so ganha o nome do arquivo DEPOIS de ele ter sido escrito, e a rota da
 * imagem confere o arquivo de verdade antes de servir - um 404 la e mais barato
 * que a lentidao aqui.
 */
export function posterUrlOf(channelNumber: number, metadata: ShowMetadataRow | null): string | null {
  // `?v=`: a URL e estavel e a rota manda cache de um dia - sem a versao, uma
  // arte rebuscada ("refazer tudo", TMDB substituindo o quadro) ficaria presa
  // no cache do navegador por ate 24h e o botao pareceria nao funcionar.
  return metadata?.posterFile == null
    ? null
    : `${API.poster(channelNumber)}?v=${String(metadata.fetchedAt)}`;
}

export function backdropUrlOf(
  channelNumber: number,
  metadata: ShowMetadataRow | null,
): string | null {
  return metadata?.backdropFile == null
    ? null
    : `${API.backdrop(channelNumber)}?v=${String(metadata.backdropCheckedAt ?? metadata.fetchedAt)}`;
}

function toSummary(
  show: ShowRow,
  episodeCount: number,
  metadata: ShowMetadataRow | null,
  seasons: number[],
): ChannelSummary {
  return {
    number: show.channelNumber,
    name: show.name,
    episodeCount,
    posterUrl: posterUrlOf(show.channelNumber, metadata),
    backdropUrl: backdropUrlOf(show.channelNumber, metadata),
    year: metadata?.year ?? null,
    overview: metadata?.overview ?? null,
    seasons,
  };
}

/**
 * O catalogo inteiro.
 *
 * Contagem e temporadas saem de UMA consulta cada, para o acervo todo.
 * Perguntar serie a serie seriam ~460 idas ao banco por request - e, no caso da
 * contagem, materializar os ~14 mil episodios do acervo (com JSON.parse de
 * trilhas linha a linha) para usar so o `length` de cada lista. Esta rota abre
 * junto com o catalogo, toda vez.
 *
 * Serie sem episodio nao entra em nenhum dos dois mapas: `?? 0` e `?? []`
 * cobrem esse caso, e o filtro logo abaixo tira o canal da listagem - e o mesmo
 * resultado de quando a contagem vinha de `listEpisodes().length`.
 */
export function listChannels(source: ChannelSource): ChannelSummary[] {
  const counts = source.countEpisodesByShow();
  const seasons = source.listSeasonsByShow();
  return source
    .listShows()
    .map((show) =>
      toSummary(
        show,
        counts.get(show.id) ?? 0,
        source.getShowMetadata(show.id),
        seasons.get(show.id) ?? [],
      ),
    )
    .filter((channel) => channel.episodeCount > 0)
    .sort((a, b) => a.number - b.number);
}

/**
 * Onde o canal esta agora.
 *
 * @param epochMs  instante zero global da grade
 * @param nowMs    relogio do servidor; entra por parametro para o resultado ser reproduzivel
 * @param cache    grade ja montada; ausente le tudo da fonte
 * @returns `null` quando o canal nao existe ou nao tem episodio - nunca lanca por isso,
 *          porque um canal vazio e um estado normal do acervo, nao um erro de programa.
 */
export function resolveNowPlaying(
  source: ChannelSource,
  channelNumber: number,
  epochMs: number,
  nowMs: number,
  cache?: TimelineCache,
): NowPlaying | null {
  const show = source.getShowByChannel(channelNumber);
  if (show === null) return null;

  const grid = cache === undefined ? readGrid(source, show.id) : cache.get(show.id);
  if (grid === null) return null;

  const { episodes, timeline } = grid;
  const cycleMs = timeline[timeline.length - 1]!;

  // Desloca o inicio do canal por um valor estavel derivado do slug, para que
  // canais distintos nao estejam todos no episodio 1 no mesmo instante.
  const phase = channelPhaseOffsetMs(show.slug, cycleMs);
  const slot = resolveSlot(episodes, epochMs - phase, nowMs, timeline);

  return {
    // A metadata fica FORA do cache: ela chega pela rede depois do scan, sem
    // mexer no indice, e cachea-la junto seguraria a capa ate o proximo rescan.
    channel: toSummary(show, episodes.length, source.getShowMetadata(show.id), grid.seasons),
    episode: toRef(episodes[slot.index]!),
    offsetMs: slot.offsetMs,
    serverTimeMs: nowMs,
    endsAtMs: slot.endsAtMs,
    next: toRef(episodes[slot.nextIndex]!),
  };
}

/**
 * O que esta no ar em todos os canais, na MESMA ordem de `listChannels`.
 *
 * Canal sem episodio sai do array em vez de virar `null`: a faixa "No ar agora"
 * so desenha o que tem o que tocar, e um buraco no meio da lista obrigaria todo
 * cliente a filtrar antes de renderizar.
 *
 * Ordena aqui em vez de confiar na ordem da fonte porque `listChannels` tambem
 * ordena: as duas respostas alimentam a mesma tela, e uma divergencia de ordem
 * emparelharia o canal errado com o episodio errado.
 */
export function listNowPlaying(
  source: ChannelSource,
  epochMs: number,
  nowMs: number,
  cache?: TimelineCache,
): NowPlaying[] {
  const shows = [...source.listShows()].sort((a, b) => a.channelNumber - b.channelNumber);
  const playing: NowPlaying[] = [];
  for (const show of shows) {
    const now = resolveNowPlaying(source, show.channelNumber, epochMs, nowMs, cache);
    if (now !== null) playing.push(now);
  }
  return playing;
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
