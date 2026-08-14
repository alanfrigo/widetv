import { describe, expect, test } from 'vitest';
import {
  initialMenu,
  reduceMenu,
  type MenuContext,
  type MenuEvent,
  type MenuState,
} from '../../src/web/menu';

/** Cinco canais, tres episodios no canal em que se entra. */
const CTX: MenuContext = { channelCount: 5, episodeCount: 3 };

function run(state: MenuState, events: MenuEvent[], context: MenuContext = CTX): MenuState {
  let current = state;
  for (const event of events) {
    current = reduceMenu(current, event, context).state;
  }
  return current;
}

/** Menu aberto no canal 2 (indice 2), ainda no nivel de canais. */
function opened(index = 2, context: MenuContext = CTX): MenuState {
  return reduceMenu(initialMenu(), { type: 'open', currentChannelIndex: index }, context).state;
}

/** Menu ja dentro da lista de episodios do canal `index`. */
function drilled(index = 2, context: MenuContext = CTX): MenuState {
  return run(opened(index, context), [{ type: 'drill' }], context);
}

describe('reduceMenu - abrir e fechar', () => {
  test('nasce fechado', () => {
    expect(initialMenu().open).toBe(false);
  });

  test('open abre no nivel de canais, com o cursor no canal atual', () => {
    const r = reduceMenu(initialMenu(), { type: 'open', currentChannelIndex: 3 }, CTX);
    expect(r.state).toEqual({
      open: true,
      channelCursor: 3,
      drilledChannel: null,
      episodeCursor: 0,
    });
    expect(r.command).toBeNull();
  });

  test('canal atual fora da lista e limitado em vez de abrir cursor invalido', () => {
    expect(opened(99).channelCursor).toBe(4);
    expect(opened(-3).channelCursor).toBe(0);
  });

  test('sem canal nenhum o cursor fica em zero', () => {
    const r = reduceMenu(
      initialMenu(),
      { type: 'open', currentChannelIndex: 4 },
      { channelCount: 0, episodeCount: 0 },
    );
    expect(r.state.channelCursor).toBe(0);
  });

  test('open dentro de episodios volta para o nivel de canais', () => {
    const r = reduceMenu(drilled(2), { type: 'open', currentChannelIndex: 1 }, CTX);
    expect(r.state.drilledChannel).toBeNull();
    expect(r.state.channelCursor).toBe(1);
  });

  test('close fecha sem comando', () => {
    const r = reduceMenu(opened(), { type: 'close' }, CTX);
    expect(r.state.open).toBe(false);
    expect(r.command).toBeNull();
  });
});

describe('reduceMenu - menu fechado engole tudo menos open', () => {
  const closed = initialMenu();

  for (const event of [
    { type: 'up' },
    { type: 'down' },
    { type: 'drill' },
    { type: 'back' },
    { type: 'select' },
    { type: 'close' },
  ] as MenuEvent[]) {
    test(`${event.type} com menu fechado nao faz nada`, () => {
      const r = reduceMenu(closed, event, CTX);
      expect(r.state).toEqual(closed);
      expect(r.command).toBeNull();
    });
  }
});

describe('reduceMenu - navegacao nos canais', () => {
  test('down anda para o proximo', () => {
    expect(run(opened(2), [{ type: 'down' }]).channelCursor).toBe(3);
  });

  test('up anda para o anterior', () => {
    expect(run(opened(2), [{ type: 'up' }]).channelCursor).toBe(1);
  });

  test('nao da a volta no fim da lista', () => {
    expect(run(opened(4), [{ type: 'down' }, { type: 'down' }]).channelCursor).toBe(4);
  });

  test('nao da a volta no comeco da lista', () => {
    expect(run(opened(0), [{ type: 'up' }, { type: 'up' }]).channelCursor).toBe(0);
  });

  test('navegar nao emite comando', () => {
    expect(reduceMenu(opened(2), { type: 'down' }, CTX).command).toBeNull();
  });

  test('lista vazia nao move o cursor', () => {
    const empty: MenuContext = { channelCount: 0, episodeCount: 0 };
    expect(run(opened(0, empty), [{ type: 'down' }], empty).channelCursor).toBe(0);
  });
});

describe('reduceMenu - entrar na serie', () => {
  test('drill guarda o canal, zera o cursor de episodio e pede a lista', () => {
    const r = reduceMenu(opened(2), { type: 'drill' }, CTX);
    expect(r.state.drilledChannel).toBe(2);
    expect(r.state.episodeCursor).toBe(0);
    expect(r.state.open).toBe(true);
    expect(r.command).toEqual({ type: 'loadEpisodes', channelIndex: 2 });
  });

  test('drill sem canal nenhum nao faz nada', () => {
    const empty: MenuContext = { channelCount: 0, episodeCount: 0 };
    const r = reduceMenu(opened(0, empty), { type: 'drill' }, empty);
    expect(r.state.drilledChannel).toBeNull();
    expect(r.command).toBeNull();
  });

  test('drill de novo dentro dos episodios nao faz nada', () => {
    const inside = drilled(2);
    const r = reduceMenu(inside, { type: 'drill' }, CTX);
    expect(r.state).toEqual(inside);
    expect(r.command).toBeNull();
  });
});

describe('reduceMenu - navegacao nos episodios', () => {
  test('down anda no episodio, nao no canal', () => {
    const r = run(drilled(2), [{ type: 'down' }]);
    expect(r.episodeCursor).toBe(1);
    expect(r.channelCursor).toBe(2);
  });

  test('nao passa do ultimo episodio', () => {
    const r = run(drilled(2), [{ type: 'down' }, { type: 'down' }, { type: 'down' }]);
    expect(r.episodeCursor).toBe(2);
  });

  test('nao passa do primeiro episodio', () => {
    expect(run(drilled(2), [{ type: 'up' }]).episodeCursor).toBe(0);
  });

  test('lista ainda carregando nao move o cursor', () => {
    const loading: MenuContext = { channelCount: 5, episodeCount: 0 };
    const r = run(drilled(2, loading), [{ type: 'down' }], loading);
    expect(r.episodeCursor).toBe(0);
  });
});

describe('reduceMenu - voltar', () => {
  test('back nos episodios volta para os canais com o cursor no canal de origem', () => {
    const r = reduceMenu(run(drilled(2), [{ type: 'down' }]), { type: 'back' }, CTX);
    expect(r.state).toEqual({
      open: true,
      channelCursor: 2,
      drilledChannel: null,
      episodeCursor: 0,
    });
    expect(r.command).toBeNull();
  });

  test('back nos canais fecha o menu', () => {
    const r = reduceMenu(opened(2), { type: 'back' }, CTX);
    expect(r.state.open).toBe(false);
    expect(r.command).toBeNull();
  });
});

describe('reduceMenu - escolher', () => {
  test('select num canal sintoniza ao vivo e fecha', () => {
    const r = reduceMenu(run(opened(2), [{ type: 'down' }]), { type: 'select' }, CTX);
    expect(r.command).toEqual({ type: 'tune', channelIndex: 3 });
    expect(r.state.open).toBe(false);
  });

  test('select sem canal nenhum nao fecha nem sintoniza', () => {
    const empty: MenuContext = { channelCount: 0, episodeCount: 0 };
    const state = opened(0, empty);
    const r = reduceMenu(state, { type: 'select' }, empty);
    expect(r.command).toBeNull();
    expect(r.state.open).toBe(true);
  });

  test('select num episodio toca o VOD e fecha', () => {
    const r = reduceMenu(run(drilled(2), [{ type: 'down' }]), { type: 'select' }, CTX);
    expect(r.command).toEqual({ type: 'play', channelIndex: 2, episodeIndex: 1 });
    expect(r.state.open).toBe(false);
  });

  test('select com a lista ainda vazia nao fecha o menu', () => {
    const loading: MenuContext = { channelCount: 5, episodeCount: 0 };
    const state = drilled(2, loading);
    const r = reduceMenu(state, { type: 'select' }, loading);
    expect(r.command).toBeNull();
    expect(r.state.open).toBe(true);
    expect(r.state.drilledChannel).toBe(2);
  });
});

describe('reduceMenu - lista que encolheu entre um evento e outro', () => {
  const shrunk: MenuContext = { channelCount: 2, episodeCount: 1 };

  test('cursor de canal fora da lista e limitado na leitura', () => {
    const r = reduceMenu({ ...opened(4), channelCursor: 4 }, { type: 'select' }, shrunk);
    expect(r.command).toEqual({ type: 'tune', channelIndex: 1 });
  });

  test('up depois do encolhimento parte do fim da lista nova', () => {
    const r = reduceMenu({ ...opened(4), channelCursor: 4 }, { type: 'up' }, shrunk);
    expect(r.state.channelCursor).toBe(0);
  });

  test('cursor de episodio fora da lista e limitado na leitura', () => {
    const state: MenuState = { open: true, channelCursor: 1, drilledChannel: 1, episodeCursor: 7 };
    const r = reduceMenu(state, { type: 'select' }, shrunk);
    expect(r.command).toEqual({ type: 'play', channelIndex: 1, episodeIndex: 0 });
  });

  test('canal em que se entrou saiu da lista: o back ainda cai num indice valido', () => {
    const state: MenuState = { open: true, channelCursor: 4, drilledChannel: 4, episodeCursor: 0 };
    const r = reduceMenu(state, { type: 'back' }, shrunk);
    expect(r.state.channelCursor).toBe(1);
    expect(r.state.drilledChannel).toBeNull();
  });
});
