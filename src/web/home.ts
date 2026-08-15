import type { ChannelSummary } from '@shared/api-types';

import { channelsLabel, resultsLabel } from './format';

/**
 * Decisoes da tela do catalogo, sem DOM.
 *
 * O que mora aqui: o filtro da busca, os textos que ficam a direita de cada
 * faixa e a frase do hero. Sao regras curtas, mas sao regras - deixa-las dentro
 * de um handler de `input` esconderia o unico lugar onde da para verificar que
 * buscar "simpsons" acha "Os Simpsons".
 */

/**
 * Texto comparavel: sem acento, sem caixa e sem espaco sobrando.
 *
 * O acervo tem "Os Cavaleiros do Zodíaco" e ninguem digita o acento na busca.
 * `NFD` separa a letra do sinal e o intervalo apaga so o sinal, entao "ç" vira
 * "c" e o resto do nome continua inteiro.
 */
export function foldText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Acervo filtrado pela busca. Sem consulta, a lista inteira - a busca e local e
 * nunca bate na rede: o catalogo ja esta todo em memoria.
 */
export function filterChannels(
  channels: readonly ChannelSummary[],
  query: string,
): ChannelSummary[] {
  const wanted = foldText(query);
  if (wanted === '') return [...channels];
  // Digitar o numero do canal tambem acha: quem decorou "canal 12" nao deveria
  // ter de lembrar o nome da serie.
  return channels.filter(
    (channel) =>
      foldText(channel.name).includes(wanted) || String(channel.number) === wanted,
  );
}

/** Aside da faixa do acervo: a ordem quando nao ha busca, a contagem quando ha. */
export function shelfAside(query: string, results: number): string {
  return foldText(query) === '' ? 'A → Z' : resultsLabel(results);
}

/** Aside da faixa do ao vivo: quantos canais tem grade agora. */
export function liveAside(count: number): string {
  return channelsLabel(count);
}

/** Recado no lugar dos cards quando a busca nao acha nada. */
export function emptySearchText(query: string): string {
  return `Nada no acervo com "${query.trim()}".`;
}

export interface HeroNow {
  /** Numero do episodio no ar; null quando o arquivo nao traz numeracao. */
  episodeNumber: number | null;
  /** Ha quanto tempo ele comecou, ja projetado com o relogio local. */
  elapsedMs: number;
}

/** Fecho da frase do hero: e o que este app tem de diferente, e vale repetir. */
const HERO_TAIL =
  'A grade é a mesma para qualquer aparelho da casa: entrar no canal é chegar no meio, como televisão.';

function elapsedText(elapsedMs: number): string {
  const minutes = Number.isFinite(elapsedMs) && elapsedMs > 0 ? Math.floor(elapsedMs / 60_000) : 0;
  if (minutes <= 0) return 'há menos de um minuto';
  return minutes === 1 ? 'há um minuto' : `há ${minutes} minutos`;
}

/**
 * Paragrafo do hero.
 *
 * @param now  null quando `/api/now` nao respondeu (ou a rota ainda nem existe
 *             no servidor): sobra o fecho, que continua verdadeiro.
 */
export function heroSentence(now: HeroNow | null): string {
  if (now === null) return HERO_TAIL;
  const which = now.episodeNumber === null ? 'um episódio' : `o episódio ${now.episodeNumber}`;
  return `Está tocando ${which} ${elapsedText(now.elapsedMs)}. ${HERO_TAIL}`;
}
