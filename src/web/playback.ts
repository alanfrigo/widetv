/**
 * Partida da reproducao sob a politica de autoplay do navegador.
 *
 * O Chrome recusa `play()` com som antes de um gesto do usuario, mas nunca
 * recusa video mudo. A imagem por isso nao precisa esperar por nada: se o som
 * for negado, o video entra mudo imediatamente e o som liga no primeiro toque.
 *
 * Interface minima de proposito: o que importa aqui e a sequencia de tentativas,
 * e isso da para testar sem DOM.
 */

export interface PlayableMedia {
  muted: boolean;
  play(): Promise<void>;
}

export interface ReadyableMedia {
  /** `HTMLMediaElement.HAVE_METADATA` e 1. */
  readyState: number;
  addEventListener(type: string, listener: () => void): void;
}

export type ReadyOutcome = 'ready' | 'error' | 'timeout';

/**
 * Espera a metadata do video, com prazo.
 *
 * `loadedmetadata` pode nunca chegar: aba em segundo plano que o navegador
 * estrangula, arquivo corrompido, rede que morre no meio. Sem prazo, quem
 * espera por ele trava o canal para sempre — sem erro, sem tela e sem
 * recuperacao. Esta funcao nunca rejeita e nunca fica pendurada.
 */
export function awaitMediaReady(media: ReadyableMedia, timeoutMs: number): Promise<ReadyOutcome> {
  if (media.readyState >= 1) return Promise.resolve('ready');

  return new Promise<ReadyOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: ReadyOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    media.addEventListener('loadedmetadata', () => finish('ready'));
    media.addEventListener('error', () => finish('error'));
  });
}

export type PlaybackOutcome =
  /** Tocando como o usuario pediu. */
  | 'playing'
  /** Tocando, mas mudo por imposicao do navegador, nao por escolha. */
  | 'playing-muted'
  /** Nem mudo o navegador aceitou; so um gesto do usuario resolve. */
  | 'blocked';

/**
 * @param wantMuted  mudo pedido pelo usuario. Quando true nao existe fallback:
 *                   desligar o mudo dele para conseguir tocar seria pior do que
 *                   nao tocar.
 */
export async function startPlayback(
  media: PlayableMedia,
  wantMuted: boolean,
): Promise<PlaybackOutcome> {
  try {
    await media.play();
    return 'playing';
  } catch {
    if (wantMuted) return 'blocked';
  }

  media.muted = true;
  try {
    await media.play();
    return 'playing-muted';
  } catch {
    return 'blocked';
  }
}
