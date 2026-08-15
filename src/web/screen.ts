/**
 * Maquina de telas do app.
 *
 * Cinco telas e uma regra so: quem manda no que aparece e este reducer, nunca
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
  | { name: 'player'; channel: number; source: WatchSource }
  /** Manutencao da biblioteca e preferencias da casa. Irma da home, nao filha. */
  | { name: 'settings' };

export type ScreenEvent =
  | { type: 'authenticated' }
  | { type: 'unauthorized' }
  | { type: 'openSeries'; channel: number }
  | { type: 'openSettings' }
  /**
   * `channel` ausente significa "o canal da tela em que estou", que e o caso da
   * tela da serie. O catalogo manda o numero junto porque de la se assiste sem
   * passar pela serie: o hero, o card do ao vivo e o de continuar assistindo
   * tocam direto.
   */
  | { type: 'watch'; source: WatchSource; channel?: number }
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
      // Idempotente: dois requests que falham juntos com 401 (a grade e o
      // historico, disparados lado a lado) nao podem reabrir a tela de senha
      // duas vezes e apagar o que o usuario ja comecou a digitar.
      return screen.name === 'login' ? screen : { name: 'login' };

    case 'authenticated':
      // Idempotente de proposito: um `/session` que responde tarde nao pode
      // jogar de volta para a home quem ja esta assistindo.
      return isAuthenticated(screen) ? screen : { name: 'home' };

    case 'openSeries':
      // Sem sessao nao ha catalogo para abrir.
      return isAuthenticated(screen) ? { name: 'series', channel: event.channel } : screen;

    case 'openSettings':
      // Toda linha da tela de configuracoes bate numa rota autenticada: abri-la
      // sem sessao so renderia 401 em cada seta.
      return isAuthenticated(screen) ? { name: 'settings' } : screen;

    case 'watch': {
      if (!isAuthenticated(screen)) return screen;
      // Sem canal explicito so a tela da serie sabe o que tocar; disparar
      // `watch` de qualquer outro lugar significaria tocar sem saber o que.
      const channel = event.channel ?? (screen.name === 'series' ? screen.channel : null);
      if (channel === null) return screen;
      return { name: 'player', channel, source: event.source };
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
        case 'settings':
          return { name: 'home' };
        // Home e a raiz, e login/booting nao tem para onde voltar.
        default:
          return screen;
      }
    }
  }
}
