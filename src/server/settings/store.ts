import type { AppSettings, SettingsPatch } from '@shared/api-types';

import { parseRescanTimeInput } from '../config';
import { formatRescanTime, type RescanTime } from '../library/rescan-timer';

/**
 * Preferencias da casa, com o `.env` como piso.
 *
 * Toda leitura e "linha do banco quando existe, senao o default do ambiente".
 * E o que permite mexer na tela sem editar arquivo no NAS, e ao mesmo tempo
 * deixa o operador definir o comportamento de fabrica: apagar a linha volta ao
 * `.env`, nunca a um valor inventado aqui.
 *
 * Nada aqui derruba o servidor. Uma linha ilegivel (banco editado na mao, valor
 * de uma versao futura) cai no default e segue o baile - mesmo espirito do
 * `parseTracks` do indice: um dado torto nao pode impedir a casa de assistir TV.
 */

/**
 * Chaves gravadas na tabela `settings`. Sao CONTRATO DE DADOS: um banco ja em
 * producao tem essas strings dentro dele, entao renomear qualquer uma delas
 * exige migracao - sem isso, a preferencia some silenciosamente e volta ao
 * default, que e o pior jeito de quebrar (ninguem ve erro, so a escolha sumida).
 */
const KEY = {
  audioLang: 'audio_lang',
  subtitleLang: 'subtitle_lang',
  subtitlesAuto: 'subtitles_auto',
  rescanTime: 'rescan_time',
  autoRemux: 'auto_remux',
  autoThumbs: 'auto_thumbs',
  smartGrouping: 'smart_grouping',
} as const;

/**
 * Valor de `subtitle_lang` que significa "o usuario DESLIGOU a legenda".
 *
 * A chave ausente e outra coisa: "nunca escolheu". As duas viram `null` em
 * `AppSettings`, mas a distincao existe no banco de proposito - um cliente novo
 * que queira sugerir legenda no primeiro uso precisa saber se esta diante de
 * uma escolha deliberada ou de um estado virgem, e sobrescrever uma escolha
 * deliberada seria ligar de novo o que a pessoa desligou.
 */
const SUBTITLE_OFF = 'off';

/** ISO 639-1 -> 639-2/B para os idiomas que aparecem de fato num acervo. */
const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  ar: 'ara',
  bg: 'bul',
  ca: 'cat',
  cs: 'cze',
  da: 'dan',
  de: 'ger',
  el: 'gre',
  en: 'eng',
  es: 'spa',
  fi: 'fin',
  fr: 'fre',
  gl: 'glg',
  he: 'heb',
  hi: 'hin',
  hu: 'hun',
  id: 'ind',
  it: 'ita',
  ja: 'jpn',
  ko: 'kor',
  nl: 'dut',
  no: 'nor',
  pl: 'pol',
  pt: 'por',
  ro: 'rum',
  ru: 'rus',
  sv: 'swe',
  th: 'tha',
  tr: 'tur',
  uk: 'ukr',
  vi: 'vie',
  zh: 'chi',
};

/**
 * Codigo canonico em ISO 639-2/B, ou null quando nao ha idioma nenhum.
 *
 * Normaliza ANTES de gravar porque a comparacao com a tag do container e por
 * igualdade crua: o mesmo idioma vem 'pt' num MKV e 'por' no outro, e uma
 * preferencia gravada como 'pt-BR' so valeria para metade do acervo. A regiao e
 * descartada - quem escolheu portugues do Brasil aceita o de Portugal antes de
 * ficar sem legenda. Codigo desconhecido volta como veio: melhor guardar 'swa'
 * do que recusar um idioma que este mapa nao conhece.
 *
 * Duplicado de proposito em relacao ao `normalizeLang` do cliente: aquele e
 * codigo de navegador, e o servidor nao importa `src/web`.
 */
export function canonicalLang(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().toLowerCase().replace(/_/g, '-');
  if (cleaned === '' || cleaned === 'und') return null;

  const head = cleaned.split('-')[0];
  if (head === undefined || head === '') return null;
  return LANGUAGE_ALIASES[head] ?? head;
}

/** Defaults vindos do `.env`; sao o valor efetivo enquanto nao ha linha no banco. */
export interface SettingsDefaults {
  rescanTime: RescanTime | null;
  autoRemux: boolean;
  autoThumbs: boolean;
  smartGrouping: boolean;
  tmdbConfigured: boolean;
}

/** So o que este modulo precisa do indice: chave/valor. */
export interface SettingsStore {
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;
  deleteSetting(key: string): void;
  listSettings(): Record<string, string>;
}

export interface SettingsService {
  /** Valores EFETIVOS: linha do banco quando existe, senao o default do .env. */
  get(): AppSettings;
  /** Aplica, grava e devolve os efetivos. Lanca `SettingsError` em valor invalido. */
  patch(input: SettingsPatch): AppSettings;
  /** Chamado apos cada patch aplicado, com os efetivos. Devolve o cancelador. */
  subscribe(listener: (settings: AppSettings) => void): () => void;
  /** RescanTime efetivo, ja convertido - e o que o agendador consome. */
  rescanTime(): RescanTime | null;
}

/** Valor que nao da para gravar. Vira 400, nunca 500: quem errou foi o corpo. */
export class SettingsError extends Error {
  override readonly name = 'SettingsError';
}

/** `'true'`/`'false'`; qualquer outra coisa e linha ilegivel e cai no default. */
function readBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return fallback;
}

/**
 * Preferencia de idioma gravada. `'off'` so tem sentido para legenda, e por
 * isso quem decide o que fazer com ele e o chamador.
 */
function readLang(raw: string | undefined): string | null {
  if (raw === undefined || raw === SUBTITLE_OFF) return null;
  return canonicalLang(raw);
}

/**
 * Agrupamento efetivo para quem roda FORA do servidor (o scan.js do container).
 *
 * O CLI nao monta o servico inteiro, mas nao pode ignorar a escolha do painel:
 * um scan manual que agrupasse diferente do rescan da madrugada reescreveria
 * metade do indice num criterio e metade no outro, a cada rodada.
 */
export function effectiveSmartGrouping(store: SettingsStore, envDefault: boolean): boolean {
  return readBoolean(store.getSetting(KEY.smartGrouping) ?? undefined, envDefault);
}

export function createSettingsService(
  store: SettingsStore,
  defaults: SettingsDefaults,
): SettingsService {
  const listeners = new Set<(settings: AppSettings) => void>();

  /** Horario efetivo. Linha ilegivel nao desliga o rescan: cai no default. */
  function effectiveRescanTime(rows: Record<string, string>): RescanTime | null {
    const raw = rows[KEY.rescanTime];
    if (raw === undefined) return defaults.rescanTime;
    const parsed = parseRescanTimeInput(raw);
    return parsed === undefined ? defaults.rescanTime : parsed;
  }

  function read(): AppSettings {
    // Uma leitura so do banco por chamada: `get` e chamado a cada abertura da
    // tela de configuracoes e a cada patch.
    const rows = store.listSettings();

    const rescan = effectiveRescanTime(rows);

    return {
      audioLang: readLang(rows[KEY.audioLang]),
      subtitleLang: readLang(rows[KEY.subtitleLang]),
      // Sem default no `.env`: nada liga sozinho antes de a pessoa pedir.
      subtitlesAuto: readBoolean(rows[KEY.subtitlesAuto], false),
      rescanTime: rescan === null ? null : formatRescanTime(rescan),
      autoRemux: readBoolean(rows[KEY.autoRemux], defaults.autoRemux),
      autoThumbs: readBoolean(rows[KEY.autoThumbs], defaults.autoThumbs),
      smartGrouping: readBoolean(rows[KEY.smartGrouping], defaults.smartGrouping),
      // Nunca gravavel: e um fato sobre o ambiente, nao uma preferencia.
      tmdbConfigured: defaults.tmdbConfigured,
    };
  }

  return {
    get: read,

    patch(input): AppSettings {
      // So o que veio no corpo e tocado; campo ausente fica exatamente como
      // esta. E o que permite dois aparelhos mexerem em preferencias
      // diferentes ao mesmo tempo sem um apagar a escolha do outro.
      if (input.audioLang !== undefined) {
        const lang = canonicalLang(input.audioLang);
        // "sem preferencia" e o proprio default: apagar a chave e a forma
        // honesta de dizer isso, e nao ha sentinela para audio (nao existe
        // "audio desligado" - o arquivo sempre toca alguma faixa).
        if (lang === null) store.deleteSetting(KEY.audioLang);
        else store.setSetting(KEY.audioLang, lang);
      }

      if (input.subtitleLang !== undefined) {
        const lang = canonicalLang(input.subtitleLang);
        // Aqui o null e escolha: grava o sentinela em vez de apagar a chave.
        store.setSetting(KEY.subtitleLang, lang ?? SUBTITLE_OFF);
      }

      if (input.subtitlesAuto !== undefined) {
        store.setSetting(KEY.subtitlesAuto, input.subtitlesAuto ? 'true' : 'false');
      }

      if (input.rescanTime !== undefined) {
        const time = parseRescanTimeInput(input.rescanTime);
        if (time === undefined) {
          throw new SettingsError(
            `rescanTime precisa ser HH:MM (ou null para desligar), recebeu "${String(input.rescanTime)}".`,
          );
        }
        store.setSetting(KEY.rescanTime, time === null ? 'off' : formatRescanTime(time));
      }

      if (input.autoRemux !== undefined) {
        store.setSetting(KEY.autoRemux, input.autoRemux ? 'true' : 'false');
      }

      if (input.autoThumbs !== undefined) {
        store.setSetting(KEY.autoThumbs, input.autoThumbs ? 'true' : 'false');
      }

      if (input.smartGrouping !== undefined) {
        store.setSetting(KEY.smartGrouping, input.smartGrouping ? 'true' : 'false');
      }

      const settings = read();
      // Uma notificacao por patch, DEPOIS de tudo gravado: quem reage a isto
      // reagenda timer e reinicia job, e nao pode ver estado pela metade.
      for (const listener of listeners) {
        listener(settings);
      }
      return settings;
    },

    subscribe(listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    rescanTime(): RescanTime | null {
      return effectiveRescanTime(store.listSettings());
    },
  };
}
