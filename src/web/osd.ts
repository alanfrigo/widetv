import type { ChannelSummary, EpisodeRef } from '@shared/api-types';

/**
 * Formatacao do display de fosforo verde.
 *
 * So texto: quem desenha na tela e o `main.ts`. Separado assim porque o
 * formato e a unica parte com regra de negocio (numeracao ausente, titulo
 * longo, volume fora da faixa) e da para testar sem DOM.
 */

/** Largura util do OSD em caracteres. */
const MAX_LABEL = 32;
const VOLUME_STEPS = 10;

export function formatChannelNumber(channel: number): string {
  return String(channel).padStart(2, '0');
}

/**
 * Rotulo do episodio. Nome de arquivo de acervo caseiro raramente traz
 * numeracao confiavel, entao o titulo e a saida de emergencia.
 */
export function formatEpisodeLabel(episode: EpisodeRef): string {
  const { season, episode: number } = episode;

  if (season !== null && number !== null) {
    return `S${String(season).padStart(2, '0')}E${String(number).padStart(2, '0')}`;
  }
  if (number !== null) {
    return `EP ${String(number).padStart(2, '0')}`;
  }
  return episode.title.toUpperCase().slice(0, MAX_LABEL);
}

export function formatTuneLine(channel: ChannelSummary, episode: EpisodeRef | null): string {
  const head = `${formatChannelNumber(channel.number)}  ${channel.name.toUpperCase()}`;
  return episode === null ? head : `${head}  ${formatEpisodeLabel(episode)}`;
}

export function formatVolumeBar(level: number, muted: boolean): string {
  const clamped = Math.min(1, Math.max(0, level));
  const filled = Math.round(clamped * VOLUME_STEPS);
  const bar = '#'.repeat(filled) + '-'.repeat(VOLUME_STEPS - filled);
  return `${muted ? 'MUDO' : 'VOL'} [${bar}]`;
}
