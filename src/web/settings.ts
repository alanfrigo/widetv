import type {
  AppSettings,
  LibraryStatus,
  ScanMode,
  ScanProgressRef,
  SettingsPatch,
} from '@shared/api-types';

import { moveCursor, stepIndex } from './nav';
import { languageName, normalizeLang } from './tracks';

/**
 * Tela de configuracoes: decisao pura, sem DOM.
 *
 * Mesmo desenho de `tracks.ts`: aqui mora o cursor, o valor que a seta escolhe e
 * o TEXTO que a linha mostra; o `main.ts` desenha e e o unico que fala com a
 * rede. Nada neste arquivo faz fetch - `reduceSettings` devolve o comando e
 * quem executa e quem tem o cliente HTTP na mao.
 *
 * O modelo mental e de controle remoto: cima e baixo escolhem a LINHA, esquerda
 * e direita mudam o VALOR dela, Enter dispara o que e acao. Uma tecla so nunca
 * faz duas coisas diferentes dependendo da linha.
 *
 * A verdade dos valores mora no servidor, nao aqui: o reducer recebe o
 * `AppSettings` atual em `context` e devolve o patch a aplicar. Guardar uma
 * copia local do valor faria a tela mentir quando o PATCH falhasse.
 */

export type SettingsField =
  | 'audioLang'
  | 'subtitleLang'
  | 'subtitlesAuto'
  | 'rescanTime'
  | 'autoRemux'
  | 'autoThumbs'
  | 'smartGrouping'
  | 'scanIncremental'
  | 'scanFull'
  | 'refreshMetadata'
  | 'generateThumbs';

/**
 * As duas listas da tela. E so uma divisao de DESENHO: o cursor do controle
 * remoto percorre as duas na ordem, como se fossem uma lista so - parar de
 * descer no fim de "Reprodução" obrigaria a decorar outra tecla para atravessar
 * o titulo da secao seguinte.
 */
export type SettingsGroup = 'playback' | 'library';

export interface SettingsRow {
  field: SettingsField;
  kind: 'choice' | 'toggle' | 'action' | 'time';
  group: SettingsGroup;
  /**
   * As setas MUDAM alguma coisa nesta linha.
   *
   * Toda linha de valor muda; das acoes, so a rebusca de capas e a geracao de
   * miniaturas, onde ← → escolhem entre completar o que falta e refazer tudo.
   * As duas varreduras nao tem valor nenhum para percorrer, e sao as unicas
   * assim. Quem desenha marca `set--stepper` a partir
   * daqui, e o CSS so esconde a seta esquerda de quem nao a usa - uma seta
   * escondida numa linha que responde a ela seria uma affordance mentindo.
   */
  stepper: boolean;
}

/** Ordem das linhas na tela. Acoes de manutencao no fim: sao as caras. */
const ROWS: readonly SettingsRow[] = [
  { field: 'audioLang', kind: 'choice', group: 'playback', stepper: true },
  { field: 'subtitleLang', kind: 'choice', group: 'playback', stepper: true },
  { field: 'subtitlesAuto', kind: 'toggle', group: 'playback', stepper: true },
  { field: 'smartGrouping', kind: 'toggle', group: 'library', stepper: true },
  { field: 'autoRemux', kind: 'toggle', group: 'library', stepper: true },
  { field: 'autoThumbs', kind: 'toggle', group: 'library', stepper: true },
  { field: 'rescanTime', kind: 'time', group: 'library', stepper: true },
  { field: 'scanIncremental', kind: 'action', group: 'library', stepper: false },
  { field: 'scanFull', kind: 'action', group: 'library', stepper: false },
  { field: 'refreshMetadata', kind: 'action', group: 'library', stepper: true },
  { field: 'generateThumbs', kind: 'action', group: 'library', stepper: true },
];

export function settingsRows(): readonly SettingsRow[] {
  return ROWS;
}

/** Uma linha com a posicao que ela ocupa no cursor unico da tela. */
export interface SettingsRowAt extends SettingsRow {
  /** Indice em `settingsRows()` - e o que o cursor guarda. */
  index: number;
}

/**
 * As linhas de um grupo, cada uma carregando o proprio indice global.
 *
 * Quem desenha precisa das duas coisas ao mesmo tempo: em que `<ul>` a linha
 * entra e qual numero o cursor usa para ela. Recalcular o indice na hora do
 * desenho daria duas contagens da mesma ordem, e elas divergiriam na primeira
 * linha que mudasse de grupo.
 */
export function settingsGroupRows(group: SettingsGroup): readonly SettingsRowAt[] {
  return ROWS.map((row, index) => ({ ...row, index })).filter((row) => row.group === group);
}

export interface SettingsUiState {
  cursor: number;
  /**
   * Linha esperando resposta da rede. So as acoes marcam: elas sao caras e
   * disparar duas varreduras porque o Enter repetiu seria pior do que esperar.
   * Quem limpa e o `main.ts`, quando o POST responde - nao quando o scan acaba.
   */
  busy: SettingsField | null;
  message: string | null;
  /**
   * Modo da rebusca de capas, escolhido com as setas na propria linha da acao.
   * Mora no estado da TELA e nao em `AppSettings` porque nao e preferencia
   * gravada: e a diferenca entre "completa o que falta" (barato) e "refaz
   * tudo", que e o que conserta capa errada depois de a pasta ser renomeada.
   */
  metadataReset: boolean;
  /**
   * Mesmo par de modos na linha de gerar miniaturas, e por isto e um campo
   * proprio: escolher "refazer tudo" ali nao pode mudar o que a linha das capas
   * vai fazer quando alguem descer ate ela.
   */
  thumbsReset: boolean;
}

export function initialSettings(): SettingsUiState {
  return { cursor: 0, busy: null, message: null, metadataReset: false, thumbsReset: false };
}

export type SettingsEvent =
  | { type: 'up' }
  | { type: 'down' }
  | { type: 'left' }
  | { type: 'right' }
  | { type: 'select' };

export type SettingsCommand =
  | null
  | { type: 'patch'; patch: SettingsPatch }
  | { type: 'scan'; mode: ScanMode }
  | { type: 'refreshMetadata'; reset: boolean }
  | { type: 'generateThumbs'; reset: boolean };

export interface SettingsResult {
  state: SettingsUiState;
  command: SettingsCommand;
}

/** Idiomas oferecidos: os que o acervo costuma trazer, mais "Nenhuma"/"Padrao do arquivo". */
export interface LanguageOption {
  value: string | null;
  label: string;
}

export interface SettingsContext {
  settings: AppSettings;
  /**
   * Lista que as setas percorrem nas duas linhas de idioma. Audio e legenda
   * oferecem os mesmos codigos na mesma ordem - so o rotulo do `null` muda -,
   * entao uma lista so basta para andar; o rotulo e assunto de quem desenha.
   */
  languages: readonly LanguageOption[];
}

export function reduceSettings(
  state: SettingsUiState,
  event: SettingsEvent,
  context: SettingsContext,
): SettingsResult {
  const still = (next: SettingsUiState = state): SettingsResult => ({ state: next, command: null });

  if (event.type === 'up' || event.type === 'down') {
    // Coluna unica: `moveCursor` para nas pontas em vez de dar a volta, como no
    // resto do app.
    const cursor = moveCursor(state.cursor, event.type, ROWS.length, 1);
    return still(cursor === state.cursor ? state : { ...state, cursor });
  }

  const row = ROWS[state.cursor];
  if (row === undefined) return still();
  // Enquanto a rede nao respondeu, a linha nao aceita outro comando.
  if (state.busy !== null) return still();

  // Enter numa linha de valor avanca, como a seta direita: numa tela de TV,
  // apertar OK na linha destacada e o gesto mais natural que existe.
  const delta: 1 | -1 = event.type === 'left' ? -1 : 1;

  switch (row.kind) {
    case 'choice': {
      const current = normalizeLang(
        row.field === 'audioLang' ? context.settings.audioLang : context.settings.subtitleLang,
      );
      const next = stepLanguage(current, delta, context.languages);
      if (next === current) return still();
      return fired(state, {
        type: 'patch',
        patch: row.field === 'audioLang' ? { audioLang: next } : { subtitleLang: next },
      });
    }

    case 'time': {
      const next = stepRescanTime(context.settings.rescanTime, delta);
      if (next === context.settings.rescanTime) return still();
      return fired(state, { type: 'patch', patch: { rescanTime: next } });
    }

    case 'toggle': {
      const current = toggleValue(row.field, context.settings);
      // A seta escolhe o lado (direita liga, esquerda desliga) e nao repete o
      // PATCH quando o valor ja esta la; o Enter alterna.
      const next = event.type === 'select' ? !current : event.type === 'right';
      if (next === current) return still();
      return fired(state, { type: 'patch', patch: togglePatch(row.field, next) });
    }

    case 'action': {
      const chosen = resetModeOf(row.field, state);
      if (chosen !== null && event.type !== 'select') {
        // Nas duas acoes que tem modo, as setas so escolhem o lado; quem gasta
        // rede e o Enter.
        const reset = event.type === 'right';
        return still(reset === chosen ? state : withResetMode(state, row.field, reset));
      }
      if (event.type !== 'select') return still();

      return {
        state: { ...state, busy: row.field, message: null },
        command: actionCommand(row.field, state),
      };
    }
  }
}

/**
 * Modo escolhido na linha, ou null quando a acao nao tem modo nenhum.
 *
 * E o que distingue uma acao que responde as setas de uma que so dispara: as
 * duas varreduras nao tem "so o que falta" para escolher.
 */
function resetModeOf(field: SettingsField, state: SettingsUiState): boolean | null {
  if (field === 'refreshMetadata') return state.metadataReset;
  if (field === 'generateThumbs') return state.thumbsReset;
  return null;
}

function withResetMode(
  state: SettingsUiState,
  field: SettingsField,
  reset: boolean,
): SettingsUiState {
  return field === 'generateThumbs'
    ? { ...state, thumbsReset: reset }
    : { ...state, metadataReset: reset };
}

function actionCommand(field: SettingsField, state: SettingsUiState): SettingsCommand {
  switch (field) {
    case 'refreshMetadata':
      return { type: 'refreshMetadata', reset: state.metadataReset };
    case 'generateThumbs':
      return { type: 'generateThumbs', reset: state.thumbsReset };
    default:
      return { type: 'scan', mode: field === 'scanFull' ? 'full' : 'incremental' };
  }
}

/** Comando emitido: a mensagem antiga sai da tela agora, o resultado chega depois. */
function fired(state: SettingsUiState, command: SettingsCommand): SettingsResult {
  return { state: { ...state, message: null }, command };
}

function toggleValue(field: SettingsField, settings: AppSettings): boolean {
  switch (field) {
    case 'subtitlesAuto':
      return settings.subtitlesAuto;
    case 'autoRemux':
      return settings.autoRemux;
    case 'autoThumbs':
      // Servidor mais velho do que esta tela nao manda o campo: sem a guarda, a
      // linha desenharia "Ligado" a partir de `undefined`.
      return settings.autoThumbs === true;
    case 'smartGrouping':
      return settings.smartGrouping;
    default:
      return false;
  }
}

function togglePatch(field: SettingsField, value: boolean): SettingsPatch {
  switch (field) {
    case 'subtitlesAuto':
      return { subtitlesAuto: value };
    case 'autoRemux':
      return { autoRemux: value };
    case 'autoThumbs':
      return { autoThumbs: value };
    case 'smartGrouping':
      return { smartGrouping: value };
    default:
      return {};
  }
}

/* --- idiomas -------------------------------------------------------------- */

/**
 * Codigos oferecidos na tela. Lista curta de proposito: e a dublagem que um
 * acervo caseiro traz de verdade, e uma lista com as 180 linhas do ISO viraria
 * uma eternidade de setas no controle remoto. O nome legivel vem de `tracks.ts`
 * para nao existirem duas tabelas de idioma no app.
 */
const OFFERED_LANGUAGES: readonly string[] = ['por', 'eng', 'spa', 'fre', 'ger', 'ita', 'jpn', 'kor'];

function languageOptions(none: string): readonly LanguageOption[] {
  return [
    { value: null, label: none },
    ...OFFERED_LANGUAGES.map((value) => ({ value, label: languageName(value) })),
  ];
}

export function audioLanguageOptions(): readonly LanguageOption[] {
  return languageOptions('Padrão do arquivo');
}

export function subtitleLanguageOptions(): readonly LanguageOption[] {
  return languageOptions('Desativadas');
}

/**
 * Vizinho circular na lista de idiomas. Idioma que o servidor tem mas a lista
 * nao oferece (veio do `.env`) cai na primeira opcao em vez de travar a seta.
 */
function stepLanguage(
  current: string | null,
  delta: 1 | -1,
  languages: readonly LanguageOption[],
): string | null {
  if (languages.length === 0) return current;
  const at = languages.findIndex((option) => option.value === current);
  return languages[stepIndex(at, delta, languages.length)]?.value ?? null;
}

/* --- horario do rescan ---------------------------------------------------- */

const SLOT_MINUTES = 30;
const SLOTS = (24 * 60) / SLOT_MINUTES;

function parseTime(value: string | null): number | null {
  if (value === null) return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (match === null) return null;

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

function formatTime(minutes: number): string {
  const hour = Math.floor(minutes / 60) % 24;
  return `${String(hour).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * 'HH:MM' -> proximo valor ao apertar seta; passo de 30 min, ciclico, com 'off'.
 *
 * O desligado e uma posicao do ciclo, entre 23:30 e 00:00: quem esta na ponta
 * chega nele com a mesma seta que usou para chegar ate ali, sem outra tecla.
 */
export function stepRescanTime(current: string | null, delta: 1 | -1): string | null {
  const minutes = parseTime(current);
  // Desligado (ou horario ilegivel gravado por outra pessoa) e a posicao 0.
  if (minutes === null) return formatTime(delta === 1 ? 0 : (SLOTS - 1) * SLOT_MINUTES);

  const slot = minutes / SLOT_MINUTES;
  // Horario fora da grade de meia em meia hora (veio do `.env`): a seta encosta
  // no vizinho em vez de continuar de um ponto que a lista nao tem.
  if (!Number.isInteger(slot)) {
    const rounded = delta === 1 ? Math.ceil(slot) : Math.floor(slot);
    return formatTime((rounded % SLOTS) * SLOT_MINUTES);
  }

  const next = slot + delta;
  return next < 0 || next >= SLOTS ? null : formatTime(next * SLOT_MINUTES);
}

/* --- texto da tela -------------------------------------------------------- */

const TITLES: Readonly<Record<SettingsField, string>> = {
  audioLang: 'Idioma do áudio',
  subtitleLang: 'Idioma da legenda',
  subtitlesAuto: 'Ligar legenda sozinha',
  smartGrouping: 'Agrupar temporadas da mesma série',
  autoRemux: 'Converter arquivos em segundo plano',
  autoThumbs: 'Tirar miniatura de cada episódio',
  rescanTime: 'Varredura diária',
  scanIncremental: 'Procurar arquivos novos',
  scanFull: 'Reanalisar a biblioteca inteira',
  refreshMetadata: 'Rebuscar capas e sinopses',
  generateThumbs: 'Gerar miniaturas',
};

const HINTS: Readonly<Record<SettingsField, string>> = {
  audioLang: 'A dublagem escolhida sozinha quando o episódio tem esse idioma.',
  subtitleLang: 'A legenda escolhida sozinha quando o episódio tem esse idioma.',
  subtitlesAuto: 'Desligado, a legenda só aparece quando você escolhe no player.',
  smartGrouping:
    'Junta as pastas de release da mesma série num canal só. Vale a partir da próxima varredura.',
  autoRemux: 'Prepara em MP4 o que o navegador não toca direto, sem segurar quem está assistindo.',
  autoThumbs:
    'Tira um quadro do próprio vídeo para a lista e as faixas. Desligar não apaga o que já existe.',
  rescanTime: 'Horário em que o servidor procura arquivos novos sem ninguém pedir.',
  scanIncremental: 'Reaproveita o que já foi medido. É a varredura rápida do dia a dia.',
  scanFull: 'Mede todo arquivo de novo, ignorando o cache. Demora, e é o que conserta índice torto.',
  refreshMetadata: '← → escolhem entre completar o que falta e refazer tudo.',
  generateThumbs:
    'Um ffmpeg por episódio, um de cada vez. ← → escolhem entre o que falta e refazer tudo.',
};

export function settingsRowTitle(field: SettingsField): string {
  return TITLES[field];
}

export function settingsRowHint(field: SettingsField): string {
  return HINTS[field];
}

/** Valor a mostrar do lado direito da linha. */
export function settingsValueText(
  field: SettingsField,
  settings: AppSettings,
  state: SettingsUiState,
): string {
  if (state.busy === field) return 'Aguarde…';

  switch (field) {
    case 'audioLang':
      return labelOf(settings.audioLang, audioLanguageOptions());
    case 'subtitleLang':
      return labelOf(settings.subtitleLang, subtitleLanguageOptions());
    case 'subtitlesAuto':
    case 'autoRemux':
    case 'autoThumbs':
    case 'smartGrouping':
      return toggleValue(field, settings) ? 'Ligado' : 'Desligado';
    case 'rescanTime':
      return settings.rescanTime ?? 'Desligada';
    case 'refreshMetadata':
      return state.metadataReset ? 'Refazer tudo' : 'Só o que falta';
    case 'generateThumbs':
      return state.thumbsReset ? 'Refazer tudo' : 'Só o que falta';
    default:
      return 'Iniciar';
  }
}

/** Idioma fora da lista ainda aparece com nome, so nao e alcancavel pela seta. */
function labelOf(lang: string | null, options: readonly LanguageOption[]): string {
  const wanted = normalizeLang(lang);
  const found = options.find((option) => option.value === wanted);
  if (found !== undefined) return found.label;
  return wanted === null ? (options[0]?.label ?? '') : languageName(wanted);
}

/* --- estado da biblioteca ------------------------------------------------- */

/** "1240 de 14320 — The Simpsons", ou so a contagem quando a serie nao tem nome. */
function progressText(progress: ScanProgressRef): string {
  const head = `${progress.done} de ${progress.total}`;
  return progress.show.trim() === '' ? head : `${head} — ${progress.show}`;
}

/** @returns null quando nao ha o que medir - a barra some em vez de fingir 0%. */
function progressRatio(progress: ScanProgressRef | null): number | null {
  if (progress === null || progress.total <= 0) return null;
  return Math.min(1, Math.max(0, progress.done / progress.total));
}

/** Texto do progresso: "1240 de 14320 — The Simpsons". null quando parado. */
export function scanProgressText(status: LibraryStatus): string | null {
  if (status.scan.state !== 'running') return null;

  const progress = status.scan.progress;
  // Rodada recem-disparada: dizer que esta parada seria mentira, e a barra
  // vazia sem legenda parece tela travada.
  if (progress === null) return 'Preparando a varredura…';

  return progressText(progress);
}

/**
 * Fracao para a barra de progresso.
 *
 * @returns null quando nao ha o que medir - a barra some em vez de fingir 0%.
 */
export function scanProgressRatio(status: LibraryStatus): number | null {
  if (status.scan.state !== 'running') return null;
  return progressRatio(status.scan.progress);
}

/* --- fila de miniaturas --------------------------------------------------- */

type ThumbTask = LibraryStatus['thumbs'];

/**
 * A fila de quadros como o servidor mandou, ou null.
 *
 * Servidor mais velho do que esta tela nao traz o campo, e `status.thumbs.state`
 * derrubaria a tela de configuracoes inteira por causa de um bloco de status.
 */
function thumbTask(status: LibraryStatus): ThumbTask | null {
  const task: ThumbTask | undefined = status.thumbs;
  return task ?? null;
}

/**
 * A fila de quadros esta rodando agora.
 *
 * E ela que mais precisa disto: num acervo grande e a tarefa mais demorada de
 * todas, um ffmpeg por episodio, e sem esta pergunta o polling da tela desligaria
 * enquanto ela ainda esta trabalhando.
 */
export function thumbsRunning(status: LibraryStatus): boolean {
  return thumbTask(status)?.state === 'running';
}

/** Mesma leitura de `scanProgressText` para a fila de quadros. */
export function thumbProgressText(status: LibraryStatus): string | null {
  const task = thumbTask(status);
  if (task === null || task.state !== 'running') return null;
  if (task.progress === null) return 'Preparando as miniaturas…';
  return progressText(task.progress);
}

/** Mesma barra da varredura, medida pela fila de quadros. */
export function thumbProgressRatio(status: LibraryStatus): number | null {
  const task = thumbTask(status);
  if (task === null || task.state !== 'running') return null;
  return progressRatio(task.progress);
}

function count(value: number, one: string, many: string): string {
  return `${value} ${value === 1 ? one : many}`;
}

/** Duracao legivel de uma rodada: segundos, minutos ou horas, nunca "0.0h". */
function formatSpan(ms: number): string {
  const seconds = Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : 0;
  if (seconds < 60) return `${seconds} s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
  }

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** Resumo legivel da ultima rodada. null quando nenhuma terminou desde o boot. */
export function scanSummaryText(status: LibraryStatus): string | null {
  const last = status.scan.last;
  if (last === null) return null;
  // Rodada que morreu no meio: o numero de series achadas ate ali nao interessa
  // perto do motivo de ela ter parado.
  if (last.error !== null) return `A última varredura falhou: ${last.error}`;

  const parts = [
    `${count(last.shows, 'série', 'séries')}, ${count(last.episodes, 'episódio', 'episódios')}`,
    `${last.probed} analisados, ${last.cached} do cache`,
  ];
  if (last.removedShows > 0 || last.removedEpisodes > 0) {
    parts.push(
      `${count(last.removedShows, 'série', 'séries')} e ${count(last.removedEpisodes, 'episódio', 'episódios')} fora do acervo`,
    );
  }
  if (last.failed > 0) parts.push(count(last.failed, 'arquivo falhou', 'arquivos falharam'));
  parts.push(`em ${formatSpan(last.durationMs)}`);

  return `Última varredura: ${parts.join(' · ')}`;
}

/** Mesma ideia de `scanSummaryText` para a busca de capa e sinopse. */
export function metadataSummaryText(status: LibraryStatus): string | null {
  const last = status.metadata.last;
  if (last === null) return null;

  const parts = [
    `${last.found} de ${last.considered} identificadas`,
    count(last.posters, 'capa baixada', 'capas baixadas'),
  ];
  if (last.notFound > 0) parts.push(`${last.notFound} sem resultado`);
  if (last.failed > 0) parts.push(count(last.failed, 'falha', 'falhas'));

  return `Última busca de capas: ${parts.join(' · ')}`;
}

/**
 * Mesma ideia para a fila de quadros.
 *
 * `skipped` conta junto quem ja tinha miniatura e quem sumiu do volume: e por
 * isso que ele aparece como "pulados", e nao como "ja tinham" - o resumo nao
 * sabe distinguir os dois e nao vai fingir que sabe.
 */
export function thumbSummaryText(status: LibraryStatus): string | null {
  const last = thumbTask(status)?.last ?? null;
  if (last === null) return null;

  const parts = [`${last.generated} de ${last.considered} geradas`];
  if (last.skipped > 0) parts.push(count(last.skipped, 'pulado', 'pulados'));
  if (last.failed > 0) parts.push(count(last.failed, 'falha', 'falhas'));
  parts.push(`em ${formatSpan(last.durationMs)}`);

  return `Últimas miniaturas: ${parts.join(' · ')}`;
}
