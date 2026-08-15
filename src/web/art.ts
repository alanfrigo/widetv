import type { EpisodeRef } from '@shared/api-types';

/**
 * De onde sai cada imagem da tela, sem DOM.
 *
 * Tres coisas disputam o mesmo retangulo 16:9: o quadro tirado do proprio
 * episodio, a arte do canal e o padrao listrado que o CSS desenha sozinho. A
 * ordem entre elas e regra do desenho, e nao detalhe de quem monta o markup -
 * ate porque ela muda no meio da sessao: a fila de quadros do servidor vai
 * preenchendo `thumbUrl` enquanto a tela ja esta aberta.
 *
 * Puro de proposito, como o resto: quem desenha so pendura a `<img>` na URL que
 * sair daqui, e null quer dizer "nao pendure nada".
 */

/**
 * URL de imagem que o servidor mandou, ou null.
 *
 * Duas guardas numa funcao so. Servidor mais velho do que esta tela (ele esta
 * sendo escrito em paralelo) nao traz o campo, e `undefined` viraria
 * `<img src="undefined">`; string vazia viraria `<img src="">`, que e um
 * request a propria pagina em vez de uma imagem.
 */
export function imageUrl(value: string | null | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Quadro da linha de episodio.
 *
 * null enquanto a fila do servidor nao chegou neste arquivo - e a maior parte
 * do tempo, num acervo grande. Nao e erro: e o listrado, que e desenho.
 */
export function episodeArtUrl(episode: EpisodeRef | null | undefined): string | null {
  return imageUrl(episode?.thumbUrl);
}

/**
 * Imagem do card 16:9 das faixas "No ar agora" e "Continuar assistindo".
 *
 * O quadro do episodio vem primeiro porque e o que o desenho pede: a arte do
 * canal e a MESMA imagem em todos os cards da serie e nao diz nada sobre o
 * episodio que esta no ar agora. Ela fica de reserva para enquanto a fila nao
 * passou por aquele arquivo, e o listrado para quando nao ha nem uma nem outra.
 *
 * @param backdropUrl arte 16:9 do canal - `channel.backdropUrl` no ao vivo,
 *                    `entry.backdropUrl` na retomada.
 */
export function wideArtUrl(
  episode: EpisodeRef | null | undefined,
  backdropUrl: string | null | undefined,
): string | null {
  return episodeArtUrl(episode) ?? imageUrl(backdropUrl);
}
