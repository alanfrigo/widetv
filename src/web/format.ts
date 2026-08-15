import type { AudioTrackRef, EpisodeRef } from '@shared/api-types';

import { normalizeLang } from './tracks';

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

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * `S01E08` / `EP 08`.
 *
 * @returns null quando o arquivo nao traz numeracao nenhuma - e o que separa o
 *          `SxxExx · Titulo` do titulo sozinho, sem repetir o nome duas vezes.
 */
export function episodeCode(episode: EpisodeRef): string | null {
  const { season, episode: number } = episode;
  if (season !== null && number !== null) return `S${pad2(season)}E${pad2(number)}`;
  if (number !== null) return `EP ${pad2(number)}`;
  return null;
}

/**
 * Rotulo do episodio. Nome de arquivo de acervo caseiro raramente traz
 * numeracao confiavel, entao o titulo e a saida de emergencia.
 */
export function formatEpisodeLabel(episode: EpisodeRef): string {
  return episodeCode(episode) ?? episode.title.toUpperCase().slice(0, MAX_LABEL);
}

/** Linha do overlay e do painel de trilhas: `S01E08 · O roubo do seculo`. */
export function episodeHeadline(episode: EpisodeRef): string {
  const code = episodeCode(episode);
  return code === null ? episode.title : `${code} · ${episode.title}`;
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
 * Duracao arredondada ao minuto. Nunca "0 min" para episodio que existe: um
 * arquivo de 40 segundos e curto, nao vazio.
 */
export function formatDurationMin(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return '0 min';
  return `${Math.max(1, Math.round(durationMs / 60_000))} min`;
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

/* --- canal ---------------------------------------------------------------- */

/** Numero do canal com dois digitos: e o selo do card e o miolo da pilula. */
export function channelNumberLabel(channelNumber: number): string {
  const value = Number.isFinite(channelNumber) ? Math.max(0, Math.trunc(channelNumber)) : 0;
  return pad2(value);
}

/** Pilula de canal, do hero ao overlay do player: `Canal 07`. */
export function channelLabel(channelNumber: number): string {
  return `Canal ${channelNumberLabel(channelNumber)}`;
}

/* --- tempo ---------------------------------------------------------------- */

function minutesOf(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.round(ms / 60_000);
}

/**
 * Quanto falta do episodio, para o card do "No ar agora" e para a linha da
 * lista. Abaixo de meio minuto o numero arredondado seria zero, e "faltam 0
 * min" parece um episodio que ja acabou.
 */
export function formatRemaining(ms: number): string {
  const minutes = minutesOf(ms);
  return minutes <= 0 ? 'falta menos de 1 min' : `faltam ${minutes} min`;
}

/** Quando o proximo entra no ar, no bloco "A seguir" do player. */
export function formatUpNext(ms: number): string {
  const minutes = minutesOf(ms);
  return minutes <= 0 ? 'em instantes' : `em ${minutes} min`;
}

/** Selo de tempo restante do card de "Continuar assistindo": `12 min`. */
export function formatLeftBadge(ms: number): string {
  return `${Math.max(1, minutesOf(ms))} min`;
}

/**
 * Soma de uma temporada: `9h 12min`, `48min`.
 *
 * @returns null quando nao ha duracao medida - o aside mostra so a contagem em
 *          vez de anunciar "0min" de conteudo.
 */
export function formatRuntime(ms: number): string | null {
  const total = minutesOf(ms);
  if (total <= 0) return null;

  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (hours === 0) return `${minutes}min`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}min`;
}

/* --- contagens ------------------------------------------------------------ */

function plural(value: number, one: string, many: string): string {
  const count = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  return `${count} ${count === 1 ? one : many}`;
}

export function episodesLabel(count: number): string {
  return plural(count, 'episódio', 'episódios');
}

export function seasonsLabel(count: number): string {
  return plural(count, 'temporada', 'temporadas');
}

export function channelsLabel(count: number): string {
  return plural(count, 'canal', 'canais');
}

/** Aside da faixa do acervo enquanto a busca esta ligada. */
export function resultsLabel(count: number): string {
  const found = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  return found === 0 ? 'nenhum resultado' : plural(found, 'resultado', 'resultados');
}

/**
 * Selo `N audios` da linha de episodio.
 *
 * @returns null com uma faixa so: um selo dizendo "1 audio" nao informa nada e
 *          rouba espaco da linha.
 */
export function audiosBadge(count: number): string | null {
  return count >= 2 ? `${count} áudios` : null;
}

/**
 * Selo de idiomas do hero e da tela da serie.
 *
 * Conta idiomas DISTINTOS e nao faixas: dois audios em portugues (estereo e
 * 5.1) sao uma lingua so. Faixa sem tag nao entra - o probe nao sabe o idioma
 * dela, e chutar dois idiomas onde ha um seria inventar acervo.
 *
 * @returns null com menos de dois idiomas conhecidos.
 */
export function languagesBadge(tracks: readonly AudioTrackRef[]): string | null {
  const langs = new Set<string>();
  for (const track of tracks) {
    const lang = normalizeLang(track.lang);
    if (lang !== null) langs.add(lang);
  }
  return langs.size >= 2 ? `${langs.size} idiomas` : null;
}

/**
 * Junta partes de uma linha de meta com o ponto separador, pulando o que nao se
 * sabe. Sem isto, ano desconhecido deixaria um `·` orfao na frente do titulo.
 */
export function joinMeta(parts: readonly (string | null | undefined)[]): string {
  return parts.filter((part): part is string => typeof part === 'string' && part !== '').join(' · ');
}
