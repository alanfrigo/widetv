import type { EpisodeRow } from '../library/index-store';
import { buildTimeline } from '../schedule/clock';

/**
 * Cache da grade por canal.
 *
 * Existe por causa de `GET /api/now`: ele resolve o que esta no ar em TODOS os
 * canais, e sem cache cada request carrega os episodios de ~460 series do
 * SQLite (com JSON.parse de trilhas linha a linha) so para somar duracoes que
 * nao mudaram desde o request anterior. O catalogo pede isso a cada abertura.
 *
 * A invalidacao e por versao do indice, e nao por tempo: a grade so muda quando
 * um scan mexe em serie ou episodio, e `Store.indexVersion()` sabe exatamente
 * quando isso aconteceu - inclusive quando quem mexeu foi o `scan.js` avulso,
 * em outro processo. Uma versao nova joga o mapa inteiro fora em vez de tentar
 * descobrir QUAL canal mudou: um scan tipicamente mexe em muitos, e reconstruir
 * uma grade custa uma consulta.
 *
 * Metadata (capa, arte, sinopse) NAO entra aqui de proposito: ela chega pela
 * rede depois do scan, sem tocar no indice, e um cache invalidado por versao a
 * congelaria sem capa ate o proximo rescan.
 */

/** Grade de um canal, pronta para `resolveSlot`. */
export interface ChannelGrid {
  /** Episodios na ordem da grade. */
  episodes: EpisodeRow[];
  /** Somas prefixas de `episodes`; o ultimo valor e a duracao do ciclo. */
  timeline: ReturnType<typeof buildTimeline>;
  /** Temporadas presentes, crescente; `[]` quando a serie nao usa pastas. */
  seasons: number[];
}

/** So o que o cache precisa da fonte de canais. */
export interface GridSource {
  listEpisodes(showId: number): EpisodeRow[];
  listSeasons(showId: number): number[];
  indexVersion(): number;
}

/**
 * Le a grade direto da fonte, sem cache.
 * @returns null quando a serie nao tem episodio - canal vazio e estado normal.
 */
export function readGrid(source: GridSource, showId: number): ChannelGrid | null {
  const episodes = source.listEpisodes(showId);
  if (episodes.length === 0) return null;
  return {
    episodes,
    timeline: buildTimeline(episodes),
    seasons: source.listSeasons(showId),
  };
}

export interface TimelineCache {
  /** Mesmo contrato de `readGrid`, servido de memoria quando possivel. */
  get(showId: number): ChannelGrid | null;
  /** Quantas grades estao guardadas. E por onde o teste confere a invalidacao. */
  readonly size: number;
}

export function createTimelineCache(source: GridSource): TimelineCache {
  // Guarda tambem o canal VAZIO (como null): sem isso, uma serie sem episodio
  // seria reconsultada a cada request para receber a mesma resposta.
  const grids = new Map<number, ChannelGrid | null>();
  let version = source.indexVersion();

  function sync(): void {
    const current = source.indexVersion();
    if (current === version) return;
    version = current;
    grids.clear();
  }

  return {
    get(showId): ChannelGrid | null {
      sync();
      const cached = grids.get(showId);
      if (cached !== undefined || grids.has(showId)) return cached ?? null;

      const grid = readGrid(source, showId);
      grids.set(showId, grid);
      return grid;
    },

    get size(): number {
      return grids.size;
    },
  };
}
