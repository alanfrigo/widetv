import type { AudioTrackRef, SubtitleTrackRef } from '@shared/api-types';

import type { StorageLike } from './last-channel';

/**
 * Painel de legendas e audio.
 *
 * Duas coisas moram aqui, ambas puras: o estado do painel (aberto, secao,
 * cursor, o que esta selecionado) e a traducao de codigo de idioma para nome
 * legivel. Aplicar a escolha no `<video>` e trabalho do `main.ts` - este modulo
 * so diz O QUE aplicar, em `TracksCommand`.
 *
 * A preferencia guardada e o IDIOMA, nao o indice da faixa: o indice 2 e uma
 * legenda diferente em cada arquivo do acervo, entao lembra-lo faria o proximo
 * episodio abrir com a legenda errada.
 */

export type TrackSection = 'subtitles' | 'audio';

export interface TracksState {
  open: boolean;
  section: TrackSection;
  /** Linha destacada dentro da secao atual. */
  cursor: number;
  /** `index` da legenda ativa; null e "Desativadas". */
  subtitle: number | null;
  /** `index` do audio ativo; null quando o navegador nao deixa escolher. */
  audio: number | null;
}

export interface TracksContext {
  /** `index` das legendas do episodio, na ordem em que aparecem no painel. */
  subtitles: readonly number[];
  /** `index` dos audios do episodio, na ordem em que aparecem no painel. */
  audios: readonly number[];
  /**
   * O navegador expoe `video.audioTracks` com mais de uma faixa. Quando false,
   * as linhas de audio aparecem desabilitadas: esconde-las faria parecer que o
   * arquivo e mono-idioma, o que e mentira sobre o acervo.
   */
  audioSwitchable: boolean;
}

export type TracksEvent =
  | { type: 'open' }
  | { type: 'close' }
  | { type: 'up' }
  | { type: 'down' }
  | { type: 'section'; value: TrackSection }
  | { type: 'select' };

/** O que o `main.ts` precisa aplicar no elemento de video; null quando nada mudou. */
export type TracksCommand =
  | null
  | { type: 'subtitle'; index: number | null }
  | { type: 'audio'; index: number };

export interface TracksResult {
  state: TracksState;
  command: TracksCommand;
}

export function initialTracks(): TracksState {
  return { open: false, section: 'subtitles', cursor: 0, subtitle: null, audio: null };
}

/** A linha 0 da secao de legendas e sempre "Desativadas". */
export function subtitleRowCount(context: TracksContext): number {
  return context.subtitles.length + 1;
}

export function audioRowCount(context: TracksContext): number {
  return context.audios.length;
}

function rowCount(section: TrackSection, context: TracksContext): number {
  return section === 'subtitles' ? subtitleRowCount(context) : audioRowCount(context);
}

/** Linha em que o cursor deve nascer: a que ja esta selecionada. */
function cursorForSelection(state: TracksState, context: TracksContext): number {
  if (state.subtitle === null) return 0;
  const at = context.subtitles.indexOf(state.subtitle);
  return at === -1 ? 0 : at + 1;
}

export function reduceTracks(
  state: TracksState,
  event: TracksEvent,
  context: TracksContext,
): TracksResult {
  const still = (next: TracksState = state): TracksResult => ({ state: next, command: null });

  switch (event.type) {
    case 'open':
      return still({
        ...state,
        open: true,
        section: 'subtitles',
        cursor: cursorForSelection(state, context),
      });

    case 'close':
      return still({ ...state, open: false });

    case 'section': {
      // Secao vazia nao recebe cursor: o painel ficaria com destaque em lugar
      // nenhum e o Enter nao teria o que selecionar.
      if (rowCount(event.value, context) === 0) return still();
      return still({ ...state, section: event.value, cursor: 0 });
    }

    case 'down': {
      const rows = rowCount(state.section, context);
      if (state.cursor + 1 < rows) return still({ ...state, cursor: state.cursor + 1 });
      // Fim das legendas cai na primeira linha do audio: o painel e uma coluna
      // so, e parar na fronteira obrigaria a decorar outra tecla.
      if (state.section === 'subtitles' && audioRowCount(context) > 0) {
        return still({ ...state, section: 'audio', cursor: 0 });
      }
      return still();
    }

    case 'up': {
      if (state.cursor > 0) return still({ ...state, cursor: state.cursor - 1 });
      if (state.section === 'audio') {
        return still({ ...state, section: 'subtitles', cursor: subtitleRowCount(context) - 1 });
      }
      return still();
    }

    case 'select': {
      if (state.section === 'subtitles') {
        if (state.cursor === 0) {
          return { state: { ...state, subtitle: null }, command: { type: 'subtitle', index: null } };
        }
        const index = context.subtitles[state.cursor - 1];
        if (index === undefined) return still();
        return { state: { ...state, subtitle: index }, command: { type: 'subtitle', index } };
      }

      // Linhas desabilitadas: o navegador nao troca o audio, entao selecionar
      // ali nao pode mudar estado nenhum - ficaria marcada uma faixa que nao
      // esta tocando.
      if (!context.audioSwitchable) return still();
      const index = context.audios[state.cursor];
      if (index === undefined) return still();
      return { state: { ...state, audio: index }, command: { type: 'audio', index } };
    }
  }
}

/* --- idiomas -------------------------------------------------------------- */

/**
 * Nomes por codigo ISO 639-2/B, que e o que container de video costuma trazer.
 * Lista curta de proposito: cobre o que aparece em acervo caseiro e cai no
 * proprio codigo quando nao conhece - melhor "SWA" do que uma linha em branco.
 */
const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  ara: 'العربية',
  bul: 'Български',
  cat: 'Català',
  chi: '中文',
  cze: 'Čeština',
  dan: 'Dansk',
  dut: 'Nederlands',
  eng: 'English',
  fin: 'Suomi',
  fre: 'Français',
  ger: 'Deutsch',
  glg: 'Galego',
  gre: 'Ελληνικά',
  heb: 'עברית',
  hin: 'हिन्दी',
  hun: 'Magyar',
  ind: 'Bahasa Indonesia',
  ita: 'Italiano',
  jpn: '日本語',
  kor: '한국어',
  nor: 'Norsk',
  pol: 'Polski',
  por: 'Português',
  rum: 'Română',
  rus: 'Русский',
  spa: 'Español',
  swe: 'Svenska',
  tha: 'ไทย',
  tur: 'Türkçe',
  ukr: 'Українська',
  vie: 'Tiếng Việt',
};

/** ISO 639-1 e as variantes 639-2/T, todas apontando para a chave da tabela. */
const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  ar: 'ara',
  bg: 'bul',
  ca: 'cat',
  ces: 'cze',
  cs: 'cze',
  da: 'dan',
  de: 'ger',
  deu: 'ger',
  el: 'gre',
  ell: 'gre',
  en: 'eng',
  es: 'spa',
  fi: 'fin',
  fr: 'fre',
  fra: 'fre',
  gl: 'glg',
  he: 'heb',
  hi: 'hin',
  hu: 'hun',
  id: 'ind',
  it: 'ita',
  iw: 'heb',
  ja: 'jpn',
  ko: 'kor',
  nb: 'nor',
  nl: 'dut',
  nld: 'dut',
  nn: 'nor',
  no: 'nor',
  nob: 'nor',
  nno: 'nor',
  pl: 'pol',
  pt: 'por',
  ro: 'rum',
  ron: 'rum',
  ru: 'rus',
  sv: 'swe',
  th: 'tha',
  tr: 'tur',
  uk: 'ukr',
  vi: 'vie',
  zh: 'chi',
  zho: 'chi',
};

interface ParsedLang {
  /** Codigo canonico em minuscula, ex. 'por'. */
  base: string;
  /** Regiao em maiuscula quando a tag traz uma, ex. 'BR'. */
  region: string | null;
}

function parseLang(raw: string): ParsedLang | null {
  const cleaned = raw.trim().toLowerCase().replace(/_/g, '-');
  if (cleaned === '' || cleaned === 'und') return null;

  const [head, tail] = cleaned.split('-');
  if (head === undefined || head === '') return null;

  const base = LANGUAGE_ALIASES[head] ?? head;
  return { base, region: tail === undefined || tail === '' ? null : tail.toUpperCase() };
}

/**
 * Codigo canonico para comparar idiomas entre arquivos: o mesmo idioma vem
 * marcado 'pt' num MKV e 'por' no outro, e sem normalizar a preferencia so
 * valeria para metade do acervo. A regiao e descartada: quem escolheu
 * 'Portugues (BR)' aceita 'Portugues (PT)' antes de ficar sem legenda.
 */
export function normalizeLang(lang: string | null | undefined): string | null {
  if (typeof lang !== 'string') return null;
  return parseLang(lang)?.base ?? null;
}

/** Nome legivel do idioma; cai no proprio codigo em maiuscula quando nao conhece. */
export function languageName(lang: string | null | undefined): string {
  if (typeof lang !== 'string') return 'Desconhecido';
  const parsed = parseLang(lang);
  if (parsed === null) return 'Desconhecido';

  const name = LANGUAGE_NAMES[parsed.base] ?? parsed.base.toUpperCase();
  return parsed.region === null ? name : `${name} (${parsed.region})`;
}

/**
 * Rotulo da linha de legenda. O `title` do container ganha do idioma quando
 * existe: quem marcou "Comentarios do diretor" sabia mais sobre a faixa do que
 * a tag `eng`.
 */
export function subtitleLabel(track: SubtitleTrackRef): string {
  const base = track.title ?? languageName(track.lang);
  const named = base.trim() === '' ? `Faixa ${track.index + 1}` : base;
  return track.forced ? `${named} (forçada)` : named;
}

export function audioLabel(track: AudioTrackRef): string {
  const base = track.title ?? languageName(track.lang);
  return base.trim() === '' ? `Faixa ${track.index + 1}` : base;
}

/**
 * Legenda a ligar sozinha neste episodio, dada a preferencia guardada.
 *
 * Faixa forcada perde para a normal do mesmo idioma: forcada so legenda as
 * falas em outra lingua, e quem escolheu Portugues quer o episodio inteiro
 * legendado.
 *
 * @returns null quando a preferencia e "desativadas" ou o episodio nao tem o
 *          idioma - deixar a legenda anterior valendo mostraria outra lingua.
 */
export function pickPreferredSubtitle(
  tracks: readonly SubtitleTrackRef[],
  preferred: string | null,
): number | null {
  const wanted = normalizeLang(preferred);
  if (wanted === null) return null;

  let fallback: number | null = null;
  for (const track of tracks) {
    if (normalizeLang(track.lang) !== wanted) continue;
    if (!track.forced) return track.index;
    if (fallback === null) fallback = track.index;
  }
  return fallback;
}

/* --- preferencia guardada ------------------------------------------------- */

export const SUBTITLE_LANG_KEY = 'widetv:subtitle-lang';

/** Valor gravado quando a escolha e "sem legenda", para nao confundir com "nunca escolheu". */
const OFF = 'off';

/**
 * @returns o idioma preferido, ou null tanto para "desativadas" quanto para
 *          "nunca escolheu" - nos dois casos o episodio abre sem legenda.
 */
export function readPreferredSubtitle(storage: StorageLike | null): string | null {
  if (storage === null) return null;
  try {
    const raw = storage.getItem(SUBTITLE_LANG_KEY);
    if (raw === null || raw === OFF) return null;
    return normalizeLang(raw);
  } catch {
    // Navegador com armazenamento bloqueado: legenda nenhuma nao derruba o app.
    return null;
  }
}

export function writePreferredSubtitle(storage: StorageLike | null, lang: string | null): void {
  if (storage === null) return;
  try {
    storage.setItem(SUBTITLE_LANG_KEY, normalizeLang(lang) ?? OFF);
  } catch {
    // Sem memoria de idioma o painel continua funcionando na sessao atual.
  }
}
