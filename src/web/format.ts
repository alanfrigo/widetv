import type { EpisodeRef } from '@shared/api-types';

/**
 * Formatacao de texto da interface.
 *
 * Tudo aqui e funcao pura: recebe dado do contrato e devolve string. Quem
 * escreve na tela e o `main.ts`. Junto num modulo so porque e a mesma regra em
 * telas diferentes - o selo de resolucao aparece no hero da serie e na linha do
 * episodio, o rotulo do episodio aparece na lista e no overlay do player.
 */

/** Largura util do rotulo quando o arquivo nao traz numeracao. */
const MAX_LABEL = 32;

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

export type ResolutionBadge = '4K' | '1080p' | '720p' | 'SD';

/** Faixas generosas: acervo caseiro tem corte de barra preta e reencode torto. */
const UHD_MIN_HEIGHT = 2000;
const FHD_MIN_HEIGHT = 1050;
const HD_MIN_HEIGHT = 700;

function usable(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

/**
 * Selo de resolucao a partir do que o probe descobriu.
 *
 * A altura manda: material anamorfico e 4:3 tem largura que nao corresponde a
 * qualidade (1440x1080 e 1080p, nao 720p). So quando ela falta e que a largura
 * entra, convertida por 16:9 - chute honesto, melhor do que nenhum selo.
 *
 * @returns null quando nao ha nada em que se basear; inventar "SD" ali seria
 *          mentir sobre arquivo que ninguem mediu.
 */
export function resolutionBadge(
  width?: number | null,
  height?: number | null,
): ResolutionBadge | null {
  const tall = usable(height);
  const wide = usable(width);
  const lines = tall ?? (wide === null ? null : (wide * 9) / 16);
  if (lines === null) return null;

  if (lines >= UHD_MIN_HEIGHT) return '4K';
  if (lines >= FHD_MIN_HEIGHT) return '1080p';
  if (lines >= HD_MIN_HEIGHT) return '720p';
  return 'SD';
}

/**
 * Duracao arredondada ao minuto. Nunca "0 MIN" para episodio que existe: um
 * arquivo de 40 segundos e curto, nao vazio.
 */
export function formatDurationMin(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return '0 MIN';
  return `${Math.max(1, Math.round(durationMs / 60_000))} MIN`;
}

/**
 * Relogio do player: `m:ss` e, so quando precisa, `h:mm:ss`.
 *
 * Tempo negativo ou NaN vira `0:00` em vez de `NaN:aN`: o player pergunta a
 * posicao antes da metadata chegar, e um relogio quebrado na tela parece bug do
 * app, nao arquivo sem duracao.
 */
export function formatClock(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);

  const ss = String(seconds).padStart(2, '0');
  if (hours === 0) return `${minutes}:${ss}`;
  return `${hours}:${String(minutes).padStart(2, '0')}:${ss}`;
}

/**
 * Linha secundaria do card e do hero: `2025 · 22 EP`.
 * Sem ano conhecido sobra so a contagem - o ponto separador nao pode ficar orfao.
 */
export function formatChannelMeta(year: number | null, episodeCount: number): string {
  const count = Number.isFinite(episodeCount) && episodeCount > 0 ? Math.floor(episodeCount) : 0;
  const episodes = `${count} EP`;
  return year === null || !Number.isFinite(year) ? episodes : `${year} · ${episodes}`;
}

/**
 * Iniciais para a capa que nao existe. Duas letras no maximo: a arte de
 * fallback e um quadrado, e tres letras ja saem pequenas demais para ler de
 * longe.
 */
export function initialsOf(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 0);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}
