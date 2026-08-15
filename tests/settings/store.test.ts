import { describe, expect, test } from 'vitest';

import { openStore } from '../../src/server/library/index-store';
import {
  canonicalLang,
  createSettingsService,
  SettingsError,
  type SettingsDefaults,
  type SettingsStore,
} from '../../src/server/settings/store';

/** Defaults tipicos de um `.env` sem nada customizado. */
const DEFAULTS: SettingsDefaults = {
  rescanTime: { hour: 4, minute: 0 },
  autoRemux: true,
  smartGrouping: true,
  tmdbConfigured: false,
};

/** Store de mentira: o mesmo contrato chave/valor, sem SQLite no caminho. */
function fakeStore(seed: Record<string, string> = {}): SettingsStore & { rows: Map<string, string> } {
  const rows = new Map(Object.entries(seed));
  return {
    rows,
    getSetting: (key) => rows.get(key) ?? null,
    setSetting: (key, value) => {
      rows.set(key, value);
    },
    deleteSetting: (key) => {
      rows.delete(key);
    },
    listSettings: () => Object.fromEntries(rows),
  };
}

function service(seed: Record<string, string> = {}, defaults: SettingsDefaults = DEFAULTS) {
  const store = fakeStore(seed);
  return { store, settings: createSettingsService(store, defaults) };
}

describe('valores efetivos', () => {
  test('sem linha nenhuma, tudo vem do .env', () => {
    const { settings } = service();
    expect(settings.get()).toEqual({
      audioLang: null,
      subtitleLang: null,
      subtitlesAuto: false,
      rescanTime: '04:00',
      autoRemux: true,
      smartGrouping: true,
      tmdbConfigured: false,
    });
  });

  test('rescanTime desligado no .env vira null, nao string', () => {
    const { settings } = service({}, { ...DEFAULTS, rescanTime: null });
    expect(settings.get().rescanTime).toBeNull();
  });

  test('a linha do banco sobrepoe o default do .env', () => {
    const { settings } = service({ auto_remux: 'false', rescan_time: '23:05' });
    expect(settings.get().autoRemux).toBe(false);
    expect(settings.get().rescanTime).toBe('23:05');
  });

  test('apagar a linha volta ao default do .env', () => {
    const { store, settings } = service();
    settings.patch({ autoRemux: false });
    expect(settings.get().autoRemux).toBe(false);

    store.deleteSetting('auto_remux');
    expect(settings.get().autoRemux).toBe(true);
  });

  test('tmdbConfigured e so leitura: vem do ambiente e nada no corpo o muda', () => {
    const { store, settings } = service({}, { ...DEFAULTS, tmdbConfigured: true });
    // O cast simula um cliente que devolve o objeto inteiro que recebeu no GET.
    settings.patch({ tmdbConfigured: false } as unknown as Parameters<typeof settings.patch>[0]);
    expect(settings.get().tmdbConfigured).toBe(true);
    expect(store.rows.size).toBe(0);
  });

  test('rescanTime() devolve o horario ja convertido, que e o que o agendador usa', () => {
    const { settings } = service({ rescan_time: '03:07' });
    expect(settings.rescanTime()).toEqual({ hour: 3, minute: 7 });

    settings.patch({ rescanTime: null });
    expect(settings.rescanTime()).toBeNull();
    expect(settings.get().rescanTime).toBeNull();
  });
});

describe('normalizacao de idioma', () => {
  test.each([
    ['pt-BR', 'por'],
    ['PT', 'por'],
    ['pt_BR', 'por'],
    ['  en  ', 'eng'],
    ['por', 'por'],
    ['zh-Hans', 'chi'],
  ])('%s vira %s', (entrada, esperado) => {
    const { store, settings } = service();
    settings.patch({ audioLang: entrada });
    // Normaliza ANTES de gravar: a comparacao com a tag do container e crua.
    expect(store.rows.get('audio_lang')).toBe(esperado);
    expect(settings.get().audioLang).toBe(esperado);
  });

  test('codigo desconhecido e preservado: melhor "swa" do que recusar', () => {
    const { settings } = service();
    settings.patch({ audioLang: 'swa' });
    expect(settings.get().audioLang).toBe('swa');
  });

  test('und e vazio viram null', () => {
    expect(canonicalLang('und')).toBeNull();
    expect(canonicalLang('   ')).toBeNull();
    expect(canonicalLang(null)).toBeNull();
  });

  test('audioLang null apaga a chave: "sem preferencia" e o proprio default', () => {
    const { store, settings } = service({ audio_lang: 'por' });
    settings.patch({ audioLang: null });
    expect(store.rows.has('audio_lang')).toBe(false);
    expect(settings.get().audioLang).toBeNull();
  });
});

describe('legenda desligada x nunca escolhida', () => {
  test('subtitleLang null grava o sentinela em vez de apagar a chave', () => {
    const { store, settings } = service();
    settings.patch({ subtitleLang: null });

    // As duas leem como null em AppSettings...
    expect(settings.get().subtitleLang).toBeNull();
    // ...mas no banco a escolha deliberada e distinguivel da ausencia, que e o
    // que impede um cliente novo de religar o que a pessoa desligou.
    expect(store.rows.get('subtitle_lang')).toBe('off');
  });

  test('nunca escolhido nao deixa linha nenhuma', () => {
    const { store, settings } = service();
    settings.patch({ audioLang: 'por' });
    expect(store.rows.has('subtitle_lang')).toBe(false);
    expect(settings.get().subtitleLang).toBeNull();
  });

  test('escolher idioma depois de desligar sobrescreve o sentinela', () => {
    const { store, settings } = service({ subtitle_lang: 'off' });
    settings.patch({ subtitleLang: 'pt-BR' });
    expect(store.rows.get('subtitle_lang')).toBe('por');
  });
});

describe('linha corrompida', () => {
  test('booleano ilegivel cai no default e nao lanca', () => {
    const { settings } = service({ auto_remux: 'talvez', smart_grouping: '1' });
    expect(() => settings.get()).not.toThrow();
    expect(settings.get().autoRemux).toBe(true);
    expect(settings.get().smartGrouping).toBe(true);
  });

  test('horario ilegivel cai no default do .env, e nao desliga o rescan', () => {
    const { settings } = service({ rescan_time: '25:99' });
    expect(settings.get().rescanTime).toBe('04:00');
    expect(settings.rescanTime()).toEqual({ hour: 4, minute: 0 });
  });

  test('idioma ilegivel vira null em vez de derrubar a leitura', () => {
    const { settings } = service({ audio_lang: 'und', subtitle_lang: '' });
    expect(settings.get().audioLang).toBeNull();
    expect(settings.get().subtitleLang).toBeNull();
  });
});

describe('patch parcial', () => {
  test('campo ausente fica como esta', () => {
    const { settings } = service();
    settings.patch({ audioLang: 'por', subtitlesAuto: true });
    settings.patch({ autoRemux: false });

    expect(settings.get()).toMatchObject({
      audioLang: 'por',
      subtitlesAuto: true,
      autoRemux: false,
      smartGrouping: true,
    });
  });

  test('devolve os efetivos, nao so o que veio no corpo', () => {
    const { settings } = service();
    expect(settings.patch({ smartGrouping: false })).toEqual(settings.get());
  });

  test('corpo vazio nao muda nada e nao grava linha', () => {
    const { store, settings } = service();
    settings.patch({});
    expect(store.rows.size).toBe(0);
  });
});

describe('subscribe', () => {
  test('chama uma vez por patch, com os efetivos ja gravados', () => {
    const { settings } = service();
    const vistos: unknown[] = [];
    settings.subscribe((s) => vistos.push(s));

    const efetivo = settings.patch({ audioLang: 'pt-BR', rescanTime: '05:30', autoRemux: false });

    expect(vistos).toHaveLength(1);
    expect(vistos[0]).toEqual(efetivo);
    expect(vistos[0]).toMatchObject({ audioLang: 'por', rescanTime: '05:30', autoRemux: false });
  });

  test('o cancelador para de notificar', () => {
    const { settings } = service();
    let chamadas = 0;
    const cancelar = settings.subscribe(() => {
      chamadas += 1;
    });

    settings.patch({ autoRemux: false });
    cancelar();
    settings.patch({ autoRemux: true });

    expect(chamadas).toBe(1);
  });
});

describe('rescanTime invalido', () => {
  test.each(['25:00', '04:60', '4h', 'madrugada', '4:0'])('%s lanca SettingsError', (valor) => {
    const { store, settings } = service();
    expect(() => settings.patch({ rescanTime: valor })).toThrow(SettingsError);
    expect(store.rows.has('rescan_time')).toBe(false);
  });

  test('null e "off" desligam, e o desligado fica gravado', () => {
    const { store, settings } = service();
    settings.patch({ rescanTime: null });
    expect(store.rows.get('rescan_time')).toBe('off');
    expect(settings.get().rescanTime).toBeNull();

    settings.patch({ rescanTime: 'off' });
    expect(settings.get().rescanTime).toBeNull();
  });

  test('horario sem zero a esquerda e aceito e gravado normalizado', () => {
    const { store, settings } = service();
    settings.patch({ rescanTime: '5:07' });
    expect(store.rows.get('rescan_time')).toBe('05:07');
    expect(settings.get().rescanTime).toBe('05:07');
  });
});

describe('sobre o indice de verdade', () => {
  test('grava na tabela settings e outra instancia do servico le o mesmo', () => {
    const store = openStore(':memory:');
    const settings = createSettingsService(store, DEFAULTS);

    settings.patch({ audioLang: 'pt-BR', subtitleLang: null, rescanTime: '02:15' });

    expect(createSettingsService(store, DEFAULTS).get()).toMatchObject({
      audioLang: 'por',
      subtitleLang: null,
      rescanTime: '02:15',
    });
    expect(store.getSetting('subtitle_lang')).toBe('off');

    store.close();
  });
});
