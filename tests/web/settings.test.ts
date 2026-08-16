import { describe, expect, test } from 'vitest';
import type {
  AppSettings,
  LibraryStatus,
  ScanProgressRef,
  ScanSummary,
} from '../../src/shared/api-types';
import {
  audioLanguageOptions,
  formatCacheSize,
  initialSettings,
  metadataSummaryText,
  reduceSettings,
  scanProgressRatio,
  scanProgressText,
  scanSummaryText,
  settingsGroupRows,
  settingsRows,
  settingsValueText,
  stepCacheSize,
  stepRescanTime,
  subtitleLanguageOptions,
  thumbProgressRatio,
  thumbProgressText,
  thumbSummaryText,
  thumbsRunning,
  type SettingsContext,
  type SettingsEvent,
  type SettingsField,
  type SettingsResult,
  type SettingsUiState,
} from '../../src/web/settings';

const SETTINGS: AppSettings = {
  audioLang: null,
  subtitleLang: null,
  subtitlesAuto: true,
  rescanTime: '03:30',
  autoRemux: false,
  remuxCacheMaxBytes: 20 * 1024 ** 3,
  autoThumbs: true,
  smartGrouping: true,
  tmdbConfigured: false,
};

function context(over: Partial<AppSettings> = {}): SettingsContext {
  return { settings: { ...SETTINGS, ...over }, languages: audioLanguageOptions() };
}

/** Estado com o cursor na linha do campo: o teste nao conta linhas na mao. */
function at(field: SettingsField, over: Partial<SettingsUiState> = {}): SettingsUiState {
  const cursor = settingsRows().findIndex((row) => row.field === field);
  return { ...initialSettings(), cursor, ...over };
}

function fire(
  field: SettingsField,
  event: SettingsEvent,
  over: Partial<AppSettings> = {},
  state: Partial<SettingsUiState> = {},
): SettingsResult {
  return reduceSettings(at(field, state), event, context(over));
}

function run(state: SettingsUiState, events: SettingsEvent[]): SettingsUiState {
  return events.reduce((current, event) => reduceSettings(current, event, context()).state, state);
}

describe('as linhas da tela', () => {
  test('as acoes de manutencao ficam todas no fim', () => {
    const rows = settingsRows();
    const first = rows.findIndex((row) => row.kind === 'action');
    expect(first).toBeGreaterThan(0);
    expect(rows.slice(first).every((row) => row.kind === 'action')).toBe(true);
  });

  test('a tela tem duas listas, e a de reproducao vem primeiro', () => {
    const groups = settingsRows().map((row) => row.group);
    expect(groups.indexOf('library')).toBeGreaterThan(0);
    // Um grupo nao volta depois do outro: o cursor unico desce em linha reta.
    expect(groups.slice(groups.indexOf('library')).every((group) => group === 'library')).toBe(true);
  });

  test('cada linha entra numa lista so, com o indice do cursor global', () => {
    const playback = settingsGroupRows('playback');
    const library = settingsGroupRows('library');

    expect(playback.map((row) => row.field)).toEqual([
      'audioLang',
      'subtitleLang',
      'subtitlesAuto',
    ]);
    expect(library.map((row) => row.field)).toEqual([
      'smartGrouping',
      'autoRemux',
      'remuxCacheMaxBytes',
      'autoThumbs',
      'rescanTime',
      'scanIncremental',
      'scanFull',
      'refreshMetadata',
      'generateThumbs',
    ]);

    // Os indices sao os de `settingsRows()`, e nao a posicao dentro do grupo:
    // e o que faz o cursor unico casar com a linha desenhada.
    expect([...playback, ...library].map((row) => row.index)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ]);
    for (const row of [...playback, ...library]) {
      expect(settingsRows()[row.index]?.field).toBe(row.field);
    }
  });

  test('a divisao e so de desenho: o cursor atravessa as duas listas', () => {
    // Ultima linha de "Reprodução" desce direto na primeira de "Biblioteca".
    const last = settingsGroupRows('playback').at(-1);
    const first = settingsGroupRows('library')[0];
    const moved = reduceSettings({ ...initialSettings(), cursor: last?.index ?? 0 }, { type: 'down' }, context());
    expect(moved.state.cursor).toBe(first?.index);
  });

  test('so marca stepper a linha em que as setas fazem alguma coisa', () => {
    const stepper = settingsRows().filter((row) => row.stepper).map((row) => row.field);
    const parada = settingsRows().filter((row) => !row.stepper).map((row) => row.field);

    // As duas varreduras nao tem valor nenhum para percorrer com ← →.
    expect(parada).toEqual(['scanIncremental', 'scanFull']);
    // A rebusca de capas e acao E stepper: as setas escolhem o modo, e a dica
    // da linha manda usar ← →. Sem a marca, o CSS esconderia a seta esquerda.
    expect(stepper).toContain('refreshMetadata');
    // A geracao de miniaturas escolhe o mesmo par de modos, pela mesma tecla.
    expect(stepper).toContain('generateThumbs');
  });

  test('a marca casa com quem o reducer deixa as setas mexerem', () => {
    for (const row of settingsRows()) {
      if (row.stepper) continue;
      // Linha sem stepper nao pode reagir a seta nenhuma: nem comando, nem
      // mudanca no estado da tela. Se reagir, a seta escondida seria mentira.
      const start = at(row.field);
      for (const key of ['left', 'right'] as const) {
        const result = reduceSettings(start, { type: key }, context());
        expect(result.command).toBeNull();
        expect(result.state).toEqual(start);
      }
    }
  });

  test('todo campo do contrato tem uma linha e uma so', () => {
    const fields = settingsRows().map((row) => row.field);
    expect(new Set(fields).size).toBe(fields.length);
    expect(fields).toEqual(
      expect.arrayContaining([
        'audioLang',
        'subtitleLang',
        'subtitlesAuto',
        'rescanTime',
        'autoRemux',
        'smartGrouping',
        'scanIncremental',
        'scanFull',
        'refreshMetadata',
        'autoThumbs',
        'generateThumbs',
      ]),
    );
  });
});

describe('cursor', () => {
  test('desce e sobe linha a linha', () => {
    expect(run(initialSettings(), [{ type: 'down' }]).cursor).toBe(1);
    expect(run(initialSettings(), [{ type: 'down' }, { type: 'down' }, { type: 'up' }]).cursor).toBe(
      1,
    );
  });

  test('as pontas seguram o cursor em vez de dar a volta', () => {
    expect(run(initialSettings(), [{ type: 'up' }]).cursor).toBe(0);

    const last = settingsRows().length - 1;
    const bottom = run({ ...initialSettings(), cursor: last }, [{ type: 'down' }]);
    expect(bottom.cursor).toBe(last);
  });

  test('andar entre linhas nao dispara nada', () => {
    expect(reduceSettings(initialSettings(), { type: 'down' }, context()).command).toBeNull();
  });
});

describe('idiomas', () => {
  test('a seta anda pela lista e manda o campo sozinho', () => {
    const result = fire('audioLang', { type: 'right' });
    expect(result.command).toEqual({ type: 'patch', patch: { audioLang: 'por' } });
  });

  test('a seta para tras da a volta e cai no ultimo idioma', () => {
    const result = fire('audioLang', { type: 'left' });
    const last = audioLanguageOptions().at(-1)?.value;
    expect(result.command).toEqual({ type: 'patch', patch: { audioLang: last } });
  });

  test('a linha da legenda mexe so no campo dela', () => {
    const result = fire('subtitleLang', { type: 'right' }, { subtitleLang: 'por' });
    expect(result.command).toEqual({ type: 'patch', patch: { subtitleLang: 'eng' } });
  });

  test('voltar do primeiro idioma chega em "sem preferencia"', () => {
    const result = fire('audioLang', { type: 'left' }, { audioLang: 'por' });
    expect(result.command).toEqual({ type: 'patch', patch: { audioLang: null } });
  });

  test('Enter na linha de valor avanca, como a seta direita', () => {
    expect(fire('audioLang', { type: 'select' }).command).toEqual(
      fire('audioLang', { type: 'right' }).command,
    );
  });

  test('idioma gravado fora do padrao ainda casa com a lista', () => {
    // O servidor devolve o canonico, mas um `.env` antigo pode trazer 'pt-BR'.
    const result = fire('audioLang', { type: 'right' }, { audioLang: 'pt-BR' });
    expect(result.command).toEqual({ type: 'patch', patch: { audioLang: 'eng' } });
  });

  test('idioma que a lista nao oferece nao trava a seta', () => {
    const result = fire('audioLang', { type: 'right' }, { audioLang: 'swa' });
    expect(result.command).toEqual({ type: 'patch', patch: { audioLang: null } });
  });
});

describe('liga e desliga', () => {
  test('a seta direita liga e a esquerda desliga', () => {
    expect(fire('autoRemux', { type: 'right' }).command).toEqual({
      type: 'patch',
      patch: { autoRemux: true },
    });
    expect(fire('smartGrouping', { type: 'left' }).command).toEqual({
      type: 'patch',
      patch: { smartGrouping: false },
    });
  });

  test('a seta que aponta para o lado em que ja esta nao gasta um PATCH', () => {
    expect(fire('smartGrouping', { type: 'right' }).command).toBeNull();
    expect(fire('autoRemux', { type: 'left' }).command).toBeNull();
  });

  test('a linha das miniaturas grava o campo do contrato', () => {
    expect(fire('autoThumbs', { type: 'left' }).command).toEqual({
      type: 'patch',
      patch: { autoThumbs: false },
    });
    expect(fire('autoThumbs', { type: 'select' }, { autoThumbs: false }).command).toEqual({
      type: 'patch',
      patch: { autoThumbs: true },
    });
  });

  test('servidor sem o campo das miniaturas nao vira "Ligado" a partir do nada', () => {
    // O servidor esta sendo escrito em paralelo: um mais velho nao manda
    // `autoThumbs`, e a linha nao pode inventar um valor para mostrar.
    const older = { ...SETTINGS } as Partial<AppSettings>;
    delete older.autoThumbs;
    const settings = older as AppSettings;

    expect(settingsValueText('autoThumbs', settings, initialSettings())).toBe('Desligado');
    expect(
      reduceSettings(at('autoThumbs'), { type: 'right' }, {
        settings,
        languages: audioLanguageOptions(),
      }).command,
    ).toEqual({ type: 'patch', patch: { autoThumbs: true } });
  });

  test('Enter alterna', () => {
    expect(fire('subtitlesAuto', { type: 'select' }).command).toEqual({
      type: 'patch',
      patch: { subtitlesAuto: false },
    });
    expect(fire('subtitlesAuto', { type: 'select' }, { subtitlesAuto: false }).command).toEqual({
      type: 'patch',
      patch: { subtitlesAuto: true },
    });
  });
});

describe('horario da varredura diaria', () => {
  test('a seta anda de meia em meia hora', () => {
    expect(fire('rescanTime', { type: 'right' }).command).toEqual({
      type: 'patch',
      patch: { rescanTime: '04:00' },
    });
    expect(fire('rescanTime', { type: 'left' }).command).toEqual({
      type: 'patch',
      patch: { rescanTime: '03:00' },
    });
  });

  test('o passo e de 30 minutos nos dois sentidos', () => {
    expect(stepRescanTime('03:00', 1)).toBe('03:30');
    expect(stepRescanTime('03:30', 1)).toBe('04:00');
    expect(stepRescanTime('04:00', -1)).toBe('03:30');
  });

  test('desligado e uma posicao do ciclo, entre 23:30 e 00:00', () => {
    expect(stepRescanTime('23:30', 1)).toBeNull();
    expect(stepRescanTime(stepRescanTime('23:30', 1), 1)).toBe('00:00');
    expect(stepRescanTime('00:00', -1)).toBeNull();
    expect(stepRescanTime(null, -1)).toBe('23:30');
  });

  test('horario fora da grade encosta no vizinho', () => {
    expect(stepRescanTime('03:15', 1)).toBe('03:30');
    expect(stepRescanTime('03:15', -1)).toBe('03:00');
  });

  test('valor ilegivel gravado no servidor nao trava a linha', () => {
    expect(stepRescanTime('meia-noite', 1)).toBe('00:00');
    expect(stepRescanTime('99:99', 1)).toBe('00:00');
  });

  test('a hora sai sempre com dois digitos', () => {
    expect(stepRescanTime('09:00', 1)).toBe('09:30');
    expect(stepRescanTime('00:30', -1)).toBe('00:00');
  });
});

describe('acoes de manutencao', () => {
  test('Enter dispara a varredura e marca a linha como ocupada', () => {
    const result = fire('scanIncremental', { type: 'select' });
    expect(result.command).toEqual({ type: 'scan', mode: 'incremental' });
    expect(result.state.busy).toBe('scanIncremental');
  });

  test('a reanalise completa e outro modo, nao outra rota', () => {
    expect(fire('scanFull', { type: 'select' }).command).toEqual({ type: 'scan', mode: 'full' });
  });

  test('as setas na linha de acao nao disparam nada', () => {
    expect(fire('scanFull', { type: 'right' }).command).toBeNull();
    expect(fire('scanIncremental', { type: 'left' }).command).toBeNull();
  });

  test('a rebusca de capas escolhe o modo com a seta e dispara com Enter', () => {
    const chosen = fire('refreshMetadata', { type: 'right' });
    expect(chosen.command).toBeNull();
    expect(chosen.state.metadataReset).toBe(true);

    const fired = reduceSettings(chosen.state, { type: 'select' }, context());
    expect(fired.command).toEqual({ type: 'refreshMetadata', reset: true });
  });

  test('sem escolher o modo, a rebusca so completa o que falta', () => {
    expect(fire('refreshMetadata', { type: 'select' }).command).toEqual({
      type: 'refreshMetadata',
      reset: false,
    });
  });

  test('gerar miniaturas escolhe o modo com a seta e dispara com Enter', () => {
    const chosen = fire('generateThumbs', { type: 'right' });
    expect(chosen.command).toBeNull();
    expect(chosen.state.thumbsReset).toBe(true);

    const fired = reduceSettings(chosen.state, { type: 'select' }, context());
    expect(fired.command).toEqual({ type: 'generateThumbs', reset: true });
    expect(fired.state.busy).toBe('generateThumbs');
  });

  test('sem escolher o modo, a geracao so completa o que falta', () => {
    expect(fire('generateThumbs', { type: 'select' }).command).toEqual({
      type: 'generateThumbs',
      reset: false,
    });
  });

  test('o modo de uma acao nao contamina o da outra', () => {
    // As duas linhas oferecem o mesmo par de modos: um campo so faria "refazer
    // tudo" nas miniaturas virar "refazer tudo" tambem nas capas, que e a
    // rodada cara do provedor.
    const chosen = fire('generateThumbs', { type: 'right' }).state;
    expect(chosen.metadataReset).toBe(false);
    expect(
      reduceSettings({ ...chosen, cursor: at('refreshMetadata').cursor }, { type: 'select' }, context())
        .command,
    ).toEqual({ type: 'refreshMetadata', reset: false });
  });

  test('linha ocupada nao aceita um segundo Enter', () => {
    const busy = fire('scanFull', { type: 'select' }).state;
    expect(reduceSettings(busy, { type: 'select' }, context()).command).toBeNull();
  });

  test('ocupado, mudar valor tambem espera - mas o cursor continua andando', () => {
    const busy = fire('scanFull', { type: 'select' }).state;
    expect(reduceSettings(busy, { type: 'right' }, context()).command).toBeNull();
    expect(reduceSettings(busy, { type: 'up' }, context()).state.cursor).toBe(busy.cursor - 1);
  });

  test('disparar limpa o recado da rodada anterior', () => {
    const state = at('scanFull', { message: 'Já está em andamento.' });
    expect(reduceSettings(state, { type: 'select' }, context()).state.message).toBeNull();
  });
});

describe('listas de idioma', () => {
  test('o acervo caseiro esta coberto', () => {
    const labels = audioLanguageOptions().map((option) => option.label);
    expect(labels).toEqual(
      expect.arrayContaining([
        'Português',
        'English',
        'Español',
        'Français',
        'Deutsch',
        'Italiano',
        '日本語',
        '한국어',
      ]),
    );
  });

  test('o "nada escolhido" diz coisas diferentes em audio e legenda', () => {
    expect(audioLanguageOptions()[0]).toEqual({ value: null, label: 'Padrão do arquivo' });
    expect(subtitleLanguageOptions()[0]).toEqual({ value: null, label: 'Desativadas' });
  });

  test('as duas listas andam pelos mesmos valores, na mesma ordem', () => {
    // O reducer percorre uma lista so; se a ordem divergisse, a linha da legenda
    // pularia para o idioma errado.
    expect(subtitleLanguageOptions().map((option) => option.value)).toEqual(
      audioLanguageOptions().map((option) => option.value),
    );
  });

  test('os codigos sao canonicos, que e o que o servidor guarda', () => {
    expect(audioLanguageOptions().map((option) => option.value)).toContain('por');
    expect(audioLanguageOptions().every((option) => option.value !== 'pt')).toBe(true);
  });
});

describe('texto das linhas', () => {
  test('o valor mostra o nome do idioma, nao o codigo', () => {
    expect(settingsValueText('audioLang', { ...SETTINGS, audioLang: 'por' }, initialSettings())).toBe(
      'Português',
    );
    expect(settingsValueText('subtitleLang', SETTINGS, initialSettings())).toBe('Desativadas');
    expect(settingsValueText('audioLang', SETTINGS, initialSettings())).toBe('Padrão do arquivo');
  });

  test('idioma fora da lista ainda aparece com nome', () => {
    expect(settingsValueText('audioLang', { ...SETTINGS, audioLang: 'rus' }, initialSettings())).toBe(
      'Русский',
    );
  });

  test('o horario desligado nao vira linha vazia', () => {
    expect(settingsValueText('rescanTime', SETTINGS, initialSettings())).toBe('03:30');
    expect(settingsValueText('rescanTime', { ...SETTINGS, rescanTime: null }, initialSettings())).toBe(
      'Desligada',
    );
  });

  test('a linha ocupada avisa que esta esperando', () => {
    const busy: SettingsUiState = { ...initialSettings(), busy: 'scanFull' };
    expect(settingsValueText('scanFull', SETTINGS, busy)).toBe('Aguarde…');
    expect(settingsValueText('scanIncremental', SETTINGS, busy)).toBe('Iniciar');
  });

  test('o modo da rebusca aparece na propria linha', () => {
    expect(settingsValueText('refreshMetadata', SETTINGS, initialSettings())).toBe('Só o que falta');
    expect(
      settingsValueText('refreshMetadata', SETTINGS, { ...initialSettings(), metadataReset: true }),
    ).toBe('Refazer tudo');
  });

  test('cada acao com modo mostra o modo DELA', () => {
    const state: SettingsUiState = { ...initialSettings(), thumbsReset: true };
    expect(settingsValueText('generateThumbs', SETTINGS, state)).toBe('Refazer tudo');
    expect(settingsValueText('refreshMetadata', SETTINGS, state)).toBe('Só o que falta');
  });

  test('a linha das miniaturas automaticas diz ligado ou desligado', () => {
    expect(settingsValueText('autoThumbs', SETTINGS, initialSettings())).toBe('Ligado');
    expect(
      settingsValueText('autoThumbs', { ...SETTINGS, autoThumbs: false }, initialSettings()),
    ).toBe('Desligado');
  });
});

/* --- estado da biblioteca ------------------------------------------------- */

function summary(over: Partial<ScanSummary> = {}): ScanSummary {
  return {
    shows: 12,
    episodes: 340,
    probed: 20,
    cached: 320,
    removedShows: 0,
    removedEpisodes: 0,
    failed: 0,
    durationMs: 65_000,
    finishedAt: 1_700_000_000_000,
    error: null,
    ...over,
  };
}

function status(over: Partial<LibraryStatus> = {}): LibraryStatus {
  return {
    scan: { state: 'idle', progress: null, startedAt: null, last: null },
    metadata: { state: 'idle', last: null },
    thumbs: { state: 'idle', progress: null, last: null },
    remux: { state: 'idle' },
    ...over,
  };
}

function running(done: number, total: number, show: string): LibraryStatus {
  return status({
    scan: { state: 'running', progress: { done, total, show }, startedAt: 1, last: null },
  });
}

describe('progresso da varredura', () => {
  test('conta onde esta e o que esta medindo agora', () => {
    expect(scanProgressText(running(1240, 14_320, 'The Simpsons'))).toBe(
      '1240 de 14320 — The Simpsons',
    );
  });

  test('parado nao tem progresso nenhum', () => {
    expect(scanProgressText(status())).toBeNull();
    expect(scanProgressText(status({ scan: { state: 'idle', progress: { done: 3, total: 9, show: 'X' }, startedAt: null, last: null } }))).toBeNull();
  });

  test('rodada recem-disparada diz que comecou, em vez de parecer travada', () => {
    const fresh = status({ scan: { state: 'running', progress: null, startedAt: 1, last: null } });
    expect(scanProgressText(fresh)).toBe('Preparando a varredura…');
    expect(scanProgressRatio(fresh)).toBeNull();
  });

  test('serie sem nome nao deixa travessao orfao na tela', () => {
    expect(scanProgressText(running(2, 10, '   '))).toBe('2 de 10');
  });

  test('a fracao da barra sai entre 0 e 1', () => {
    expect(scanProgressRatio(running(5, 10, 'X'))).toBe(0.5);
    expect(scanProgressRatio(running(20, 10, 'X'))).toBe(1);
    // Total zerado: a barra some em vez de fingir 0%.
    expect(scanProgressRatio(running(0, 0, 'X'))).toBeNull();
    expect(scanProgressRatio(status())).toBeNull();
  });
});

describe('resumo da ultima rodada', () => {
  test('conta o que a varredura fez, em portugues', () => {
    const text = scanSummaryText(status({ scan: { state: 'idle', progress: null, startedAt: null, last: summary() } }));
    expect(text).toBe(
      'Última varredura: 12 séries, 340 episódios · 20 analisados, 320 do cache · em 1 min 5 s',
    );
  });

  test('singular nao vira "1 séries"', () => {
    const text = scanSummaryText(
      status({
        scan: {
          state: 'idle',
          progress: null,
          startedAt: null,
          last: summary({ shows: 1, episodes: 1, durationMs: 4_000 }),
        },
      }),
    );
    expect(text).toContain('1 série, 1 episódio');
    expect(text).toContain('em 4 s');
  });

  test('o que sumiu do acervo e o que falhou so aparecem quando existem', () => {
    const text = scanSummaryText(
      status({
        scan: {
          state: 'idle',
          progress: null,
          startedAt: null,
          last: summary({ removedShows: 1, removedEpisodes: 12, failed: 3, durationMs: 3_600_000 }),
        },
      }),
    );
    expect(text).toContain('1 série e 12 episódios fora do acervo');
    expect(text).toContain('3 arquivos falharam');
    expect(text).toContain('em 1 h');
  });

  test('rodada que morreu no meio mostra o motivo, nao os numeros', () => {
    const text = scanSummaryText(
      status({
        scan: {
          state: 'idle',
          progress: null,
          startedAt: null,
          last: summary({ error: 'LIBRARY_ROOT não existe' }),
        },
      }),
    );
    expect(text).toBe('A última varredura falhou: LIBRARY_ROOT não existe');
  });

  test('servidor recem-ligado nao tem rodada para contar', () => {
    expect(scanSummaryText(status())).toBeNull();
    expect(metadataSummaryText(status())).toBeNull();
  });

  test('a busca de capas tem resumo proprio', () => {
    const text = metadataSummaryText(
      status({
        metadata: {
          state: 'idle',
          last: { considered: 40, found: 38, posters: 31, notFound: 2, failed: 0, finishedAt: 1 },
        },
      }),
    );
    expect(text).toBe('Última busca de capas: 38 de 40 identificadas · 31 capas baixadas · 2 sem resultado');
  });
});

/* --- fila de miniaturas --------------------------------------------------- */

function thumbing(progress: ScanProgressRef | null): LibraryStatus {
  return status({ thumbs: { state: 'running', progress, last: null } });
}

/** Servidor mais velho do que esta tela: o campo nem vem na resposta. */
function withoutThumbs(): LibraryStatus {
  const older = { ...status() } as Partial<LibraryStatus>;
  delete older.thumbs;
  return older as LibraryStatus;
}

describe('progresso da fila de miniaturas', () => {
  test('conta onde esta, como a varredura', () => {
    expect(thumbProgressText(thumbing({ done: 120, total: 340, show: 'The Simpsons' }))).toBe(
      '120 de 340 — The Simpsons',
    );
    expect(thumbProgressRatio(thumbing({ done: 170, total: 340, show: 'X' }))).toBe(0.5);
  });

  test('fila recem-disparada diz que comecou', () => {
    expect(thumbProgressText(thumbing(null))).toBe('Preparando as miniaturas…');
    expect(thumbProgressRatio(thumbing(null))).toBeNull();
  });

  test('parada nao tem progresso nenhum', () => {
    expect(thumbProgressText(status())).toBeNull();
    expect(thumbProgressRatio(status())).toBeNull();
    expect(thumbsRunning(status())).toBe(false);
  });

  test('a fila rodando e o que segura o polling da tela', () => {
    expect(thumbsRunning(thumbing(null))).toBe(true);
  });

  test('servidor sem a fila nao derruba o bloco de estado', () => {
    const older = withoutThumbs();
    expect(thumbsRunning(older)).toBe(false);
    expect(thumbProgressText(older)).toBeNull();
    expect(thumbProgressRatio(older)).toBeNull();
    expect(thumbSummaryText(older)).toBeNull();
  });

  test('a fila tem resumo proprio', () => {
    const text = thumbSummaryText(
      status({
        thumbs: {
          state: 'idle',
          progress: null,
          last: {
            considered: 340,
            generated: 118,
            skipped: 220,
            failed: 2,
            durationMs: 65_000,
            finishedAt: 1,
          },
        },
      }),
    );
    expect(text).toBe('Últimas miniaturas: 118 de 340 geradas · 220 pulados · 2 falhas · em 1 min 5 s');
  });

  test('rodada limpa nao lista pulados nem falhas', () => {
    const text = thumbSummaryText(
      status({
        thumbs: {
          state: 'idle',
          progress: null,
          last: {
            considered: 4,
            generated: 4,
            skipped: 0,
            failed: 0,
            durationMs: 8_000,
            finishedAt: 1,
          },
        },
      }),
    );
    expect(text).toBe('Últimas miniaturas: 4 de 4 geradas · em 8 s');
  });

  test('servidor recem-ligado nao tem rodada de miniaturas para contar', () => {
    expect(thumbSummaryText(status())).toBeNull();
  });
});

describe('espaco das copias convertidas', () => {
  const GIB = 1024 ** 3;

  test('a seta sobe e desce pelos degraus, sem dar a volta', () => {
    expect(stepCacheSize(20 * GIB, 1)).toBe(50 * GIB);
    expect(stepCacheSize(20 * GIB, -1)).toBe(10 * GIB);
    // Ponta de baixo: encosta, nao vira "sem limite" por acidente.
    expect(stepCacheSize(5 * GIB, -1)).toBe(5 * GIB);
  });

  test('"sem limite" e o degrau ACIMA do maior valor', () => {
    expect(stepCacheSize(500 * GIB, 1)).toBe(0);
    expect(stepCacheSize(0, 1)).toBe(0);
    expect(stepCacheSize(0, -1)).toBe(500 * GIB);
  });

  test('valor fora da escada (veio do .env) anda para o degrau vizinho', () => {
    // 30 GiB nao e um degrau: subir vai para 50, descer vai para 20.
    expect(stepCacheSize(30 * GIB, 1)).toBe(50 * GIB);
    expect(stepCacheSize(30 * GIB, -1)).toBe(20 * GIB);
    // Acima do maior degrau, subir so pode dar "sem limite".
    expect(stepCacheSize(900 * GIB, 1)).toBe(0);
    // Abaixo do menor, descer encosta no menor.
    expect(stepCacheSize(1024, -1)).toBe(5 * GIB);
  });

  test('rotulo: zero e "Sem limite", nunca "0 GB"', () => {
    expect(formatCacheSize(0)).toBe('Sem limite');
    expect(formatCacheSize(-1)).toBe('Sem limite');
    expect(formatCacheSize(Number.NaN)).toBe('Sem limite');
  });

  test('rotulo em GB, e em MB quando nao chega a 1 GB', () => {
    expect(formatCacheSize(20 * GIB)).toBe('20 GB');
    expect(formatCacheSize(500 * GIB)).toBe('500 GB');
    expect(formatCacheSize(Math.floor(1.5 * GIB))).toBe('1.5 GB');
    expect(formatCacheSize(512 * 1024 ** 2)).toBe('512 MB');
  });

  test('a seta na linha emite o PATCH com o valor novo', () => {
    const result = fire('remuxCacheMaxBytes', { type: 'right' }, { remuxCacheMaxBytes: 20 * GIB });
    expect(result.command).toEqual({
      type: 'patch',
      patch: { remuxCacheMaxBytes: 50 * GIB },
    });
  });

  test('na ponta, a seta nao gasta rede', () => {
    const result = fire('remuxCacheMaxBytes', { type: 'left' }, { remuxCacheMaxBytes: 5 * GIB });
    expect(result.command).toBeNull();
  });

  test('a linha mostra o valor legivel, nao o numero de bytes', () => {
    expect(
      settingsValueText('remuxCacheMaxBytes', { ...SETTINGS, remuxCacheMaxBytes: 20 * GIB }, initialSettings()),
    ).toBe('20 GB');
  });
});
