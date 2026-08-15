import { describe, expect, test } from 'vitest';
import {
  initialScreen,
  isAuthenticated,
  reduceScreen,
  type Screen,
  type ScreenEvent,
} from '../../src/web/screen';

function run(start: Screen, events: ScreenEvent[]): Screen {
  return events.reduce(reduceScreen, start);
}

const HOME: Screen = { name: 'home' };
const SERIES: Screen = { name: 'series', channel: 7 };
const LIVE: Screen = { name: 'player', channel: 7, source: 'live' };
const VOD: Screen = { name: 'player', channel: 7, source: 'vod' };

describe('partida', () => {
  test('o app nasce antes de saber se ha sessao', () => {
    expect(initialScreen()).toEqual({ name: 'booting' });
    expect(isAuthenticated(initialScreen())).toBe(false);
  });

  test('sessao valida abre o catalogo', () => {
    expect(reduceScreen(initialScreen(), { type: 'authenticated' })).toEqual(HOME);
  });

  test('sem sessao vai para a senha', () => {
    expect(reduceScreen(initialScreen(), { type: 'unauthorized' })).toEqual({ name: 'login' });
  });

  test('login aprovado cai no catalogo', () => {
    expect(reduceScreen({ name: 'login' }, { type: 'authenticated' })).toEqual(HOME);
  });
});

describe('caminho de ida', () => {
  test('catalogo abre a serie', () => {
    expect(reduceScreen(HOME, { type: 'openSeries', channel: 7 })).toEqual(SERIES);
  });

  test('a serie liga o ao vivo e o catalogo do canal', () => {
    expect(reduceScreen(SERIES, { type: 'watch', source: 'live' })).toEqual(LIVE);
    expect(reduceScreen(SERIES, { type: 'watch', source: 'vod' })).toEqual(VOD);
  });

  test('assistir sem estar na serie nao toca nada', () => {
    expect(reduceScreen(HOME, { type: 'watch', source: 'vod' })).toBe(HOME);
    expect(reduceScreen(LIVE, { type: 'watch', source: 'vod' })).toBe(LIVE);
  });

  test('nao da para abrir serie sem sessao', () => {
    const login: Screen = { name: 'login' };
    expect(reduceScreen(login, { type: 'openSeries', channel: 7 })).toBe(login);
    expect(reduceScreen(initialScreen(), { type: 'openSeries', channel: 7 })).toEqual({
      name: 'booting',
    });
  });
});

describe('caminho de volta', () => {
  test('o player volta para a serie que o abriu', () => {
    expect(reduceScreen(VOD, { type: 'back' })).toEqual(SERIES);
    expect(reduceScreen(LIVE, { type: 'back' })).toEqual(SERIES);
  });

  test('a serie volta para o catalogo', () => {
    expect(reduceScreen(SERIES, { type: 'back' })).toEqual(HOME);
  });

  test('o catalogo e a raiz: voltar dali nao sai do app', () => {
    expect(reduceScreen(HOME, { type: 'back' })).toBe(HOME);
  });

  test('voltar na tela de senha nao faz nada', () => {
    const login: Screen = { name: 'login' };
    expect(reduceScreen(login, { type: 'back' })).toBe(login);
  });

  test('ida e volta inteira termina onde comecou', () => {
    const end = run(HOME, [
      { type: 'openSeries', channel: 7 },
      { type: 'watch', source: 'vod' },
      { type: 'back' },
      { type: 'back' },
    ]);
    expect(end).toEqual(HOME);
  });
});

describe('zapear', () => {
  test('troca o canal sem sair do ao vivo', () => {
    expect(reduceScreen(LIVE, { type: 'tuneTo', channel: 9 })).toEqual({
      name: 'player',
      channel: 9,
      source: 'live',
    });
  });

  test('zapear no catalogo nao existe: a seta la escolhe episodio', () => {
    expect(reduceScreen(VOD, { type: 'tuneTo', channel: 9 })).toBe(VOD);
  });

  test('zapear fora do player e ignorado', () => {
    expect(reduceScreen(SERIES, { type: 'tuneTo', channel: 9 })).toBe(SERIES);
  });

  test('zapear para o mesmo canal nao reabre nada', () => {
    expect(reduceScreen(LIVE, { type: 'tuneTo', channel: 7 })).toBe(LIVE);
  });

  test('depois de zapear, voltar leva para a serie nova', () => {
    const end = run(LIVE, [{ type: 'tuneTo', channel: 9 }, { type: 'back' }]);
    expect(end).toEqual({ name: 'series', channel: 9 });
  });
});

describe('sessao que expira', () => {
  test('cai no login de qualquer tela', () => {
    for (const screen of [HOME, SERIES, LIVE, VOD, initialScreen()]) {
      expect(reduceScreen(screen, { type: 'unauthorized' })).toEqual({ name: 'login' });
    }
  });

  test('sessao confirmada de novo nao arranca o usuario do que ele assiste', () => {
    expect(reduceScreen(VOD, { type: 'authenticated' })).toBe(VOD);
    expect(reduceScreen(SERIES, { type: 'authenticated' })).toBe(SERIES);
  });
});
