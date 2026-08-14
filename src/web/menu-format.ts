/**
 * Formatacao das linhas do menu widescreen.
 *
 * O rotulo do episodio nao mora aqui de proposito: `formatEpisodeLabel` do
 * `osd.ts` ja resolve a numeracao capenga do acervo caseiro e e a mesma regra
 * nos dois modos. Aqui ficam so as duas coisas que o menu acrescenta: o selo de
 * resolucao e a duracao em minutos.
 */

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
