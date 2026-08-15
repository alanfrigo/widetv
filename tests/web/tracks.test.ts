import { describe, expect, test } from 'vitest';
import type { AudioTrackRef, SubtitleTrackRef } from '../../src/shared/api-types';
import type { StorageLike } from '../../src/web/last-channel';
import {
  SUBTITLE_LANG_KEY,
  audioLabel,
  initialTracks,
  languageName,
  normalizeLang,
  pickPreferredSubtitle,
  readPreferredSubtitle,
  reduceTracks,
  subtitleLabel,
  writePreferredSubtitle,
  type TracksContext,
  type TracksEvent,
  type TracksState,
} from '../../src/web/tracks';

/** Duas legendas e dois audios: o caso comum de MKV de acervo. */
const CTX: TracksContext = { subtitles: [0, 1], audios: [0, 1], audioSwitchable: true };
/** Navegador que nao expoe `video.audioTracks`, que e o caso do Chrome. */
const NO_AUDIO: TracksContext = { ...CTX, audioSwitchable: false };

function run(
  state: TracksState,
  events: TracksEvent[],
  context: TracksContext = CTX,
): TracksState {
  return events.reduce((current, event) => reduceTracks(current, event, context).state, state);
}

function open(context: TracksContext = CTX): TracksState {
  return reduceTracks(initialTracks(), { type: 'open' }, context).state;
}

function sub(over: Partial<SubtitleTrackRef> = {}): SubtitleTrackRef {
  return { index: 0, lang: 'por', title: null, codec: 'subrip', isDefault: false, forced: false, ...over };
}

function aud(over: Partial<AudioTrackRef> = {}): AudioTrackRef {
  return { index: 0, lang: 'eng', title: null, codec: 'eac3', isDefault: false, ...over };
}

describe('abrir e fechar', () => {
  test('nasce fechado e sem legenda', () => {
    expect(initialTracks()).toEqual({
      open: false,
      section: 'subtitles',
      cursor: 0,
      subtitle: null,
      audio: null,
    });
  });

  test('abre nas legendas, com o cursor na linha que ja esta ligada', () => {
    const state = run(initialTracks(), [{ type: 'open' }, { type: 'down' }, { type: 'select' }]);
    expect(state.subtitle).toBe(0);

    const again = reduceTracks({ ...state, open: false }, { type: 'open' }, CTX).state;
    expect(again).toMatchObject({ open: true, section: 'subtitles', cursor: 1 });
  });

  test('legenda desligada abre com o cursor em "Desativadas"', () => {
    expect(open()).toMatchObject({ open: true, section: 'subtitles', cursor: 0 });
  });

  test('legenda que sumiu do episodio novo nao deixa o cursor no vazio', () => {
    const state: TracksState = { ...open(), subtitle: 7 };
    expect(reduceTracks(state, { type: 'open' }, CTX).state.cursor).toBe(0);
  });

  test('fechar preserva o que estava escolhido', () => {
    const state = run(initialTracks(), [
      { type: 'open' },
      { type: 'down' },
      { type: 'select' },
      { type: 'close' },
    ]);
    expect(state).toMatchObject({ open: false, subtitle: 0 });
  });
});

describe('cursor', () => {
  test('desce dentro das legendas', () => {
    expect(run(open(), [{ type: 'down' }]).cursor).toBe(1);
    expect(run(open(), [{ type: 'down' }, { type: 'down' }]).cursor).toBe(2);
  });

  test('o fim das legendas emenda na primeira linha do audio', () => {
    const state = run(open(), [{ type: 'down' }, { type: 'down' }, { type: 'down' }]);
    expect(state).toMatchObject({ section: 'audio', cursor: 0 });
  });

  test('subir do audio volta para a ultima legenda', () => {
    const state = run(open(), [
      { type: 'section', value: 'audio' },
      { type: 'up' },
    ]);
    expect(state).toMatchObject({ section: 'subtitles', cursor: 2 });
  });

  test('as pontas do painel seguram o cursor', () => {
    expect(run(open(), [{ type: 'up' }]).cursor).toBe(0);

    const bottom = run(open(), [
      { type: 'section', value: 'audio' },
      { type: 'down' },
      { type: 'down' },
      { type: 'down' },
    ]);
    expect(bottom).toMatchObject({ section: 'audio', cursor: 1 });
  });

  test('sem audio no arquivo, a lista de legendas nao emenda em nada', () => {
    const context: TracksContext = { subtitles: [0], audios: [], audioSwitchable: false };
    const state = run(open(context), [{ type: 'down' }, { type: 'down' }], context);
    expect(state).toMatchObject({ section: 'subtitles', cursor: 1 });
  });

  test('pular para uma secao vazia nao move o cursor para lugar nenhum', () => {
    const context: TracksContext = { subtitles: [0], audios: [], audioSwitchable: false };
    const state = run(open(context), [{ type: 'section', value: 'audio' }], context);
    expect(state.section).toBe('subtitles');
  });
});

describe('selecao', () => {
  test('a primeira linha desliga a legenda', () => {
    const ligada = run(open(), [{ type: 'down' }, { type: 'select' }]);
    const result = reduceTracks({ ...ligada, cursor: 0 }, { type: 'select' }, CTX);
    expect(result.state.subtitle).toBeNull();
    expect(result.command).toEqual({ type: 'subtitle', index: null });
  });

  test('a linha da legenda manda o indice que o servidor entende', () => {
    const result = reduceTracks({ ...open(), cursor: 2 }, { type: 'select' }, CTX);
    expect(result.state.subtitle).toBe(1);
    expect(result.command).toEqual({ type: 'subtitle', index: 1 });
  });

  test('o indice vem da lista do episodio, nao da posicao da linha', () => {
    // Episodio cujas legendas de texto sao a 2 e a 5 do container.
    const context: TracksContext = { subtitles: [2, 5], audios: [], audioSwitchable: false };
    const result = reduceTracks({ ...open(context), cursor: 2 }, { type: 'select' }, context);
    expect(result.command).toEqual({ type: 'subtitle', index: 5 });
  });

  test('trocar de audio quando o navegador deixa', () => {
    const state: TracksState = { ...open(), section: 'audio', cursor: 1 };
    const result = reduceTracks(state, { type: 'select' }, CTX);
    expect(result.state.audio).toBe(1);
    expect(result.command).toEqual({ type: 'audio', index: 1 });
  });

  test('linha de audio desabilitada nao marca faixa que nao esta tocando', () => {
    const state: TracksState = { ...open(NO_AUDIO), section: 'audio', cursor: 1 };
    const result = reduceTracks(state, { type: 'select' }, NO_AUDIO);
    expect(result.state.audio).toBeNull();
    expect(result.command).toBeNull();
  });

  test('selecionar linha inexistente nao inventa comando', () => {
    const state: TracksState = { ...open(), cursor: 9 };
    expect(reduceTracks(state, { type: 'select' }, CTX).command).toBeNull();
  });
});

describe('nomes de idioma', () => {
  test('os codigos comuns do acervo viram nome legivel', () => {
    expect(languageName('por')).toBe('Português');
    expect(languageName('eng')).toBe('English');
    expect(languageName('spa')).toBe('Español');
    expect(languageName('fre')).toBe('Français');
    expect(languageName('ger')).toBe('Deutsch');
    expect(languageName('ita')).toBe('Italiano');
    expect(languageName('jpn')).toBe('日本語');
  });

  test('ISO 639-1 e as variantes /T caem no mesmo nome', () => {
    expect(languageName('pt')).toBe('Português');
    expect(languageName('fra')).toBe('Français');
    expect(languageName('deu')).toBe('Deutsch');
    expect(languageName('zho')).toBe('中文');
  });

  test('a regiao da tag e mantida no rotulo', () => {
    expect(languageName('pt-BR')).toBe('Português (BR)');
    expect(languageName('pt_br')).toBe('Português (BR)');
  });

  test('codigo desconhecido vira o proprio codigo em vez de linha vazia', () => {
    expect(languageName('swa')).toBe('SWA');
    expect(languageName('xyz')).toBe('XYZ');
  });

  test('faixa sem tag de idioma nao mente sobre a lingua', () => {
    expect(languageName(null)).toBe('Desconhecido');
    expect(languageName('')).toBe('Desconhecido');
    expect(languageName('und')).toBe('Desconhecido');
  });

  test('normalizar ignora a regiao e a caixa', () => {
    expect(normalizeLang('PT-br')).toBe('por');
    expect(normalizeLang('por')).toBe('por');
    expect(normalizeLang(null)).toBeNull();
    expect(normalizeLang('und')).toBeNull();
  });
});

describe('rotulos das faixas', () => {
  test('o title do container ganha do idioma', () => {
    expect(subtitleLabel(sub({ title: 'Comentários do diretor', lang: 'eng' }))).toBe(
      'Comentários do diretor',
    );
  });

  test('sem title, o idioma vira o rotulo', () => {
    expect(subtitleLabel(sub({ lang: 'por' }))).toBe('Português');
    expect(audioLabel(aud({ lang: 'eng' }))).toBe('English');
  });

  test('faixa forcada e marcada como tal', () => {
    expect(subtitleLabel(sub({ lang: 'eng', forced: true }))).toBe('English (forçada)');
    expect(subtitleLabel(sub({ title: 'Sinais', forced: true }))).toBe('Sinais (forçada)');
  });

  test('faixa sem title e sem idioma ainda tem nome utilizavel', () => {
    expect(subtitleLabel(sub({ index: 2, lang: null }))).toBe('Desconhecido');
    expect(audioLabel(aud({ index: 1, lang: null, title: '   ' }))).toBe('Faixa 2');
  });
});

describe('preferencia de legenda', () => {
  test('reaplica o idioma escolhido no episodio seguinte', () => {
    const tracks = [sub({ index: 0, lang: 'eng' }), sub({ index: 1, lang: 'por' })];
    expect(pickPreferredSubtitle(tracks, 'por')).toBe(1);
  });

  test('o mesmo idioma marcado de outro jeito no arquivo seguinte ainda casa', () => {
    const tracks = [sub({ index: 0, lang: 'pt-BR' })];
    expect(pickPreferredSubtitle(tracks, 'por')).toBe(0);
  });

  test('a faixa completa ganha da forcada do mesmo idioma', () => {
    const tracks = [
      sub({ index: 0, lang: 'por', forced: true }),
      sub({ index: 1, lang: 'por', forced: false }),
    ];
    expect(pickPreferredSubtitle(tracks, 'por')).toBe(1);
  });

  test('so havendo forcada, ela serve', () => {
    const tracks = [sub({ index: 3, lang: 'por', forced: true })];
    expect(pickPreferredSubtitle(tracks, 'por')).toBe(3);
  });

  test('episodio sem o idioma preferido fica sem legenda, nao com outra lingua', () => {
    const tracks = [sub({ index: 0, lang: 'eng' })];
    expect(pickPreferredSubtitle(tracks, 'por')).toBeNull();
  });

  test('sem preferencia nenhuma o episodio abre limpo', () => {
    expect(pickPreferredSubtitle([sub()], null)).toBeNull();
    expect(pickPreferredSubtitle([], 'por')).toBeNull();
  });
});

describe('memoria da preferencia', () => {
  function fakeStorage(seed: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
    const data = { ...seed };
    return {
      data,
      getItem: (key) => data[key] ?? null,
      setItem: (key, value) => {
        data[key] = value;
      },
    };
  }

  test('grava o idioma normalizado', () => {
    const storage = fakeStorage();
    writePreferredSubtitle(storage, 'pt-BR');
    expect(storage.data[SUBTITLE_LANG_KEY]).toBe('por');
    expect(readPreferredSubtitle(storage)).toBe('por');
  });

  test('desligar a legenda tambem e uma escolha guardada', () => {
    const storage = fakeStorage();
    writePreferredSubtitle(storage, null);
    expect(storage.data[SUBTITLE_LANG_KEY]).toBe('off');
    expect(readPreferredSubtitle(storage)).toBeNull();
  });

  test('sem nada guardado, o app comeca sem legenda', () => {
    expect(readPreferredSubtitle(fakeStorage())).toBeNull();
    expect(readPreferredSubtitle(null)).toBeNull();
  });

  test('valor estragado no armazenamento nao vira legenda fantasma', () => {
    expect(readPreferredSubtitle(fakeStorage({ [SUBTITLE_LANG_KEY]: 'und' }))).toBeNull();
  });

  test('armazenamento bloqueado pelo navegador nao derruba o painel', () => {
    const hostile: StorageLike = {
      getItem: () => {
        throw new Error('bloqueado');
      },
      setItem: () => {
        throw new Error('bloqueado');
      },
    };
    expect(readPreferredSubtitle(hostile)).toBeNull();
    expect(() => writePreferredSubtitle(hostile, 'por')).not.toThrow();
  });
});
