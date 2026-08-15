/**
 * Maquina de telas do app.
 *
 * Quatro telas e uma regra so: quem manda no que aparece e este reducer, nunca
 * um `hidden = false` solto no meio de um handler. O `main.ts` chama
 * `reduceScreen`, guarda o resultado e desenha - se a transicao nao existe aqui,
 * ela nao acontece na tela.
 *
 * A sessao e a excecao que atravessa tudo: `unauthorized` pode chegar de
 * qualquer lugar (o cookie expira enquanto o episodio toca) e sempre cai no
 * login. Continuar mostrando catalogo com a sessao morta so renderia 401 em
 * cada clique.
 */

export type WatchSource = 'live' | 'vod';

export type Screen =
  /** Antes de saber se ha sessao: nao e login nem catalogo. */
  | { name: 'booting' }
  | { name: 'login' }
  | { name: 'home' }
  | { name: 'series'; channel: number }
  | { name: 'player'; channel: number; source: WatchSource };

export type ScreenEvent =
  | { type: 'authenticated' }
  | { type: 'unauthorized' }
  | { type: 'openSeries'; channel: number }
  | { type: 'watch'; source: WatchSource }
  /** Zapear: mesma tela, outro canal. So faz sentido no ao vivo. */
  | { type: 'tuneTo'; channel: number }
  | { type: 'back' };

export function initialScreen(): Screen {
  return { name: 'booting' };
}

/** true quando a tela ja passou pelo login e pode falar com a API. */
export function isAuthenticated(screen: Screen): boolean {
  return screen.name !== 'booting' && screen.name !== 'login';
}

export function reduceScreen(screen: Screen, event: ScreenEvent): Screen {
  switch (event.type) {
    case 'unauthorized':
      return { name: 'login' };

    case 'authenticated':
      // Idempotente de proposito: um `/session` que responde tarde nao pode
      // jogar de volta para a home quem ja esta assistindo.
      return isAuthenticated(screen) ? screen : { name: 'home' };

    case 'openSeries':
      // Sem sessao nao ha catalogo para abrir.
      return isAuthenticated(screen) ? { name: 'series', channel: event.channel } : screen;

    case 'watch': {
      // So a tela da serie tem os dois botoes; disparar `watch` de qualquer
      // outro lugar significaria tocar sem saber o que.
      if (screen.name !== 'series') return screen;
      return { name: 'player', channel: screen.channel, source: event.source };
    }

    case 'tuneTo': {
      // Zapear so existe no ao vivo: no catalogo a seta escolhe episodio, e a
      // grade de outro canal nao tem nada a ver com o arquivo que esta tocando.
      if (screen.name !== 'player' || screen.source !== 'live') return screen;
      if (screen.channel === event.channel) return screen;
      return { name: 'player', channel: event.channel, source: 'live' };
    }

    case 'back': {
      switch (screen.name) {
        case 'player':
          return { name: 'series', channel: screen.channel };
        case 'series':
          return { name: 'home' };
        // Home e a raiz, e login/booting nao tem para onde voltar.
        default:
          return screen;
      }
    }
  }
}
