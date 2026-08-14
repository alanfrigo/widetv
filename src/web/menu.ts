/**
 * Menu do modo widescreen: uma lista so, com dois niveis.
 *
 * Canal e serie sao a mesma coisa neste app, entao nao ha aba nem coluna: o
 * nivel de cima lista canais, `drill` entra na serie e o nivel de baixo lista os
 * episodios dela. Reducer puro no molde de `tuner.ts` - sem DOM, sem fetch, sem
 * timer. Quem carrega a lista de episodios e quem sintoniza e o `main.ts`; aqui
 * so sai a ordem do que fazer.
 *
 * Os indices sao posicoes nas listas que o chamador tem em maos, nao numeros de
 * canal: assim o reducer nao precisa conhecer o acervo.
 */

export interface MenuState {
  open: boolean;
  /** Posicao na lista de canais. */
  channelCursor: number;
  /** Canal em que se entrou, ou null quando o menu esta no nivel de canais. */
  drilledChannel: number | null;
  /** Posicao na lista de episodios do canal em que se entrou. */
  episodeCursor: number;
}

export type MenuEvent =
  | { type: 'open'; currentChannelIndex: number }
  | { type: 'close' }
  | { type: 'up' }
  | { type: 'down' }
  | { type: 'drill' }
  | { type: 'back' }
  | { type: 'select' };

/** Tamanho das listas AGORA: o acervo muda embaixo do menu aberto. */
export interface MenuContext {
  channelCount: number;
  /** Episodios do canal em que se entrou; 0 enquanto a lista nao chegou. */
  episodeCount: number;
}

export type MenuCommand =
  | { type: 'tune'; channelIndex: number }
  | { type: 'play'; channelIndex: number; episodeIndex: number }
  | { type: 'loadEpisodes'; channelIndex: number }
  | null;

export interface MenuResult {
  state: MenuState;
  command: MenuCommand;
}

export function initialMenu(): MenuState {
  return { open: false, channelCursor: 0, drilledChannel: null, episodeCursor: 0 };
}

function clampIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(Math.max(index, 0), count - 1);
}

/**
 * Limita os cursores as listas que existem agora. Um rescan pode encurtar o
 * acervo enquanto o menu esta aberto; sem isso o cursor apontaria para fora e a
 * escolha sintonizaria um canal que nao existe mais.
 */
function normalize(state: MenuState, context: MenuContext): MenuState {
  if (!state.open) return state;
  return {
    open: true,
    channelCursor: clampIndex(state.channelCursor, context.channelCount),
    drilledChannel:
      state.drilledChannel === null ? null : clampIndex(state.drilledChannel, context.channelCount),
    episodeCursor: clampIndex(state.episodeCursor, context.episodeCount),
  };
}

function move(state: MenuState, delta: number, context: MenuContext): MenuState {
  if (state.drilledChannel === null) {
    return { ...state, channelCursor: clampIndex(state.channelCursor + delta, context.channelCount) };
  }
  return { ...state, episodeCursor: clampIndex(state.episodeCursor + delta, context.episodeCount) };
}

export function reduceMenu(state: MenuState, event: MenuEvent, context: MenuContext): MenuResult {
  if (event.type === 'open') {
    return {
      state: {
        open: true,
        channelCursor: clampIndex(event.currentChannelIndex, context.channelCount),
        drilledChannel: null,
        episodeCursor: 0,
      },
      command: null,
    };
  }

  // Menu fechado nao reage a nada: as mesmas teclas la fora significam volume,
  // canal e saida do VOD.
  if (!state.open) return { state, command: null };

  const current = normalize(state, context);

  switch (event.type) {
    case 'close':
      return { state: { ...current, open: false }, command: null };

    case 'up':
      return { state: move(current, -1, context), command: null };

    case 'down':
      return { state: move(current, 1, context), command: null };

    case 'drill': {
      if (current.drilledChannel !== null || context.channelCount === 0) {
        return { state: current, command: null };
      }
      return {
        state: { ...current, drilledChannel: current.channelCursor, episodeCursor: 0 },
        command: { type: 'loadEpisodes', channelIndex: current.channelCursor },
      };
    }

    case 'back': {
      if (current.drilledChannel === null) {
        return { state: { ...current, open: false }, command: null };
      }
      // Volta pousando no canal de onde se entrou, nao no topo da lista.
      return {
        state: {
          open: true,
          channelCursor: current.drilledChannel,
          drilledChannel: null,
          episodeCursor: 0,
        },
        command: null,
      };
    }

    case 'select': {
      if (current.drilledChannel === null) {
        if (context.channelCount === 0) return { state: current, command: null };
        return {
          state: { ...current, open: false },
          command: { type: 'tune', channelIndex: current.channelCursor },
        };
      }
      // Lista ainda carregando (ou que nao carregou): fechar o menu deixaria o
      // usuario olhando para o nada.
      if (context.episodeCount === 0) return { state: current, command: null };
      return {
        state: { ...current, open: false },
        command: {
          type: 'play',
          channelIndex: current.drilledChannel,
          episodeIndex: current.episodeCursor,
        },
      };
    }
  }
}
