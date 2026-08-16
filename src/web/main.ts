import {
  API,
  type AppSettings,
  type AudioTrackRef,
  type ChannelSummary,
  type EpisodeRef,
  type LibraryStatus,
  type NowPlaying,
  type ResumeEntry,
  type SettingsPatch,
  type SubtitleTrackRef,
  type TaskAccepted,
  type WatchProgress,
} from '@shared/api-types';

import './app.css';

import {
  UnauthorizedError,
  fetchChannels,
  fetchEpisodes,
  fetchHistory,
  fetchLibraryStatus,
  fetchNowAll,
  fetchResume,
  fetchSettings,
  hasSession,
  login,
  logout,
  patchSettings,
  probeStream,
  refreshMetadata,
  saveProgress,
  startScan,
  startThumbs,
  type TimedNowAll,
} from './api';
import { episodeArtUrl, imageUrl, wideArtUrl } from './art';
import {
  audiosBadge,
  channelLabel,
  channelNumberLabel,
  episodeHeadline,
  episodesLabel,
  formatChannelMeta,
  formatClock,
  formatDurationMin,
  formatEpisodeLabel,
  formatLeftBadge,
  formatRemaining,
  formatUpNext,
  initialsOf,
  playbackProblemText,
  languagesBadge,
  resolutionBadge,
  seasonsLabel,
} from './format';
import { emptySearchText, filterChannels, heroSentence, liveAside, shelfAside } from './home';
import { browserStorage, readLastChannel, writeLastChannel } from './last-channel';
import { stepIndex } from './nav';
import { ChannelPlayer } from './player';
import { shouldPoll, type PollGate } from './polling';
import { clampRail, moveRail, type RailCursor, type RailKey } from './rails';
import { progressRatio, remainingMs, resumeStartMs, watchState } from './resume';
import { initialScreen, reduceScreen, type Screen, type ScreenEvent } from './screen';
import {
  activeSeasonTab,
  buildSeasonTabs,
  episodesOfSeason,
  seasonAside,
  type SeasonTab,
} from './seasons';
import {
  audioLanguageOptions,
  initialSettings,
  metadataSummaryText,
  reduceSettings,
  scanProgressRatio,
  scanProgressText,
  scanSummaryText,
  settingsGroupRows,
  settingsRowHint,
  settingsRowTitle,
  settingsValueText,
  thumbProgressRatio,
  thumbProgressText,
  thumbSummaryText,
  thumbsRunning,
  type SettingsCommand,
  type SettingsEvent,
  type SettingsUiState,
} from './settings';
import { expectedOffsetMs, type NowSample } from './sync';
import {
  applyServerPreferences,
  audioLabel,
  initialTracks,
  normalizeLang,
  pickPreferredAudio,
  pickPreferredSubtitle,
  readPreferredAudio,
  readPreferredSubtitle,
  reduceTracks,
  subtitleLabel,
  trackDetail,
  writePreferredAudio,
  writePreferredSubtitle,
  type TrackSection,
  type TracksContext,
  type TracksEvent,
  type TracksState,
} from './tracks';
import { decideOnEnded } from './vod';
import { VodPlayer } from './vod-player';

/**
 * Cola entre teclado, mouse, DOM e players.
 *
 * As decisoes moram nos reducers puros - `screen.ts` (que tela), `rails.ts`
 * (onde esta o foco nas faixas), `seasons.ts` (as abas de temporada),
 * `home.ts` (busca e textos do catalogo), `tracks.ts` (o painel de trilhas),
 * `settings.ts` (a tela de configuracoes), `vod.ts` (o que vem depois do
 * episodio) e `sync.ts` (a perseguicao da grade). Este arquivo so descobre o
 * evento, entrega ao reducer e desenha. Quando bater a duvida de onde por uma
 * regra nova: se ela da para escrever sem `document`, ela nao mora aqui.
 */

/** Tempo sem atividade antes de o overlay do player sumir. */
const OVERLAY_HOLD_MS = 3_000;
/** Passo do seek no catalogo. */
const SEEK_STEP_MS = 10_000;
const NOTICE_HOLD_MS = 3_000;
/** Relogio do overlay: meio segundo e suave o bastante e nao custa nada. */
const TICK_MS = 500;
/** Relogio das barras do catalogo; um segundo basta para uma barra de 3px. */
const HOME_TICK_MS = 1_000;
/** De quanto em quanto tempo reperguntar a grade inteira ao servidor. */
const NOW_REFRESH_MS = 60_000;
/**
 * Teto de cards na faixa "No ar agora".
 *
 * Ela e uma prateleira, nao o acervo: o acervo inteiro esta na faixa de baixo,
 * e o aside continua contando os canais de verdade. Um servidor com 460 series
 * desenharia 460 cards com `<img>` que o relogio percorre a cada segundo -
 * quase mil escritas de DOM por segundo com a faixa fora da tela.
 */
const LIVE_RAIL_LIMIT = 24;

function need<T extends Element>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`elemento #${id} ausente no HTML`);
  return element as unknown as T;
}

const dom = {
  topbar: need<HTMLElement>('topbar'),
  navHome: need<HTMLButtonElement>('nav-home'),
  navLive: need<HTMLButtonElement>('nav-live'),
  navShelf: need<HTMLButtonElement>('nav-shelf'),
  searchInput: need<HTMLInputElement>('search-input'),
  openSettings: need<HTMLButtonElement>('open-settings'),
  logout: need<HTMLButtonElement>('logout'),

  login: need<HTMLElement>('screen-login'),
  loginForm: need<HTMLFormElement>('login-form'),
  loginPassword: need<HTMLInputElement>('login-password'),
  loginSubmit: need<HTMLButtonElement>('login-submit'),
  loginError: need<HTMLParagraphElement>('login-error'),

  home: need<HTMLElement>('screen-home'),
  hero: need<HTMLDivElement>('hero'),
  heroArt: need<HTMLDivElement>('hero-art'),
  heroChip: need<HTMLParagraphElement>('hero-chip'),
  heroChipText: need<HTMLSpanElement>('hero-chip-text'),
  heroTitle: need<HTMLHeadingElement>('hero-title'),
  heroMeta: need<HTMLParagraphElement>('hero-meta'),
  heroText: need<HTMLParagraphElement>('hero-text'),
  heroPlay: need<HTMLButtonElement>('hero-play'),
  heroEpisodes: need<HTMLButtonElement>('hero-episodes'),
  heroFirst: need<HTMLButtonElement>('hero-first'),
  rowLive: need<HTMLElement>('row-live'),
  rowLiveAside: need<HTMLSpanElement>('row-live-aside'),
  railLive: need<HTMLDivElement>('rail-live'),
  rowResume: need<HTMLElement>('row-resume'),
  railResume: need<HTMLDivElement>('rail-resume'),
  rowShelfAside: need<HTMLSpanElement>('row-shelf-aside'),
  railShelf: need<HTMLDivElement>('rail-shelf'),
  homeEmpty: need<HTMLDivElement>('home-empty'),
  homeEmptyTitle: need<HTMLHeadingElement>('home-empty-title'),
  homeEmptyText: need<HTMLParagraphElement>('home-empty-text'),

  series: need<HTMLElement>('screen-series'),
  seriesArt: need<HTMLDivElement>('series-art'),
  seriesBack: need<HTMLButtonElement>('series-back'),
  seriesPoster: need<HTMLDivElement>('series-poster'),
  seriesChannel: need<HTMLParagraphElement>('series-channel'),
  seriesTitle: need<HTMLHeadingElement>('series-title'),
  seriesMeta: need<HTMLParagraphElement>('series-meta'),
  seriesOverview: need<HTMLParagraphElement>('series-overview'),
  seriesResume: need<HTMLButtonElement>('series-resume'),
  seriesResumeText: need<HTMLSpanElement>('series-resume-text'),
  seriesLive: need<HTMLButtonElement>('series-live'),
  seriesFirst: need<HTMLButtonElement>('series-first'),
  seasonTabs: need<HTMLDivElement>('season-tabs'),
  seasonAside: need<HTMLSpanElement>('season-aside'),
  episodeList: need<HTMLOListElement>('episode-list'),

  settings: need<HTMLElement>('screen-settings'),
  settingsBack: need<HTMLButtonElement>('settings-back'),
  settingsPlayback: need<HTMLUListElement>('settings-playback'),
  settingsLibrary: need<HTMLUListElement>('settings-library'),
  settingsMessage: need<HTMLParagraphElement>('settings-message'),
  scanTitle: need<HTMLHeadingElement>('scan-title'),
  scanPct: need<HTMLSpanElement>('scan-pct'),
  scanBar: need<HTMLDivElement>('scan-bar'),
  scanFill: need<HTMLDivElement>('scan-fill'),
  scanState: need<HTMLParagraphElement>('scan-state'),
  scanSummary: need<HTMLParagraphElement>('scan-summary'),
  scanMetadata: need<HTMLParagraphElement>('scan-metadata'),
  scanThumbs: need<HTMLParagraphElement>('scan-thumbs'),
  scanTmdb: need<HTMLParagraphElement>('scan-tmdb'),

  player: need<HTMLElement>('screen-player'),
  videoA: need<HTMLVideoElement>('video-a'),
  videoB: need<HTMLVideoElement>('video-b'),
  overlay: need<HTMLDivElement>('overlay'),
  liveBadge: need<HTMLSpanElement>('live-badge'),
  channelBadge: need<HTMLSpanElement>('channel-badge'),
  upnext: need<HTMLDivElement>('upnext'),
  upnextTitle: need<HTMLSpanElement>('upnext-title'),
  upnextTime: need<HTMLSpanElement>('upnext-time'),
  overlayShow: need<HTMLParagraphElement>('overlay-show'),
  overlayTitle: need<HTMLParagraphElement>('overlay-title'),
  overlayHint: need<HTMLParagraphElement>('overlay-hint'),
  tracksOpen: need<HTMLButtonElement>('tracks-open'),
  fullscreen: need<HTMLButtonElement>('fullscreen'),
  playToggle: need<HTMLButtonElement>('play-toggle'),
  playPause: need<HTMLSpanElement>('play-pause'),
  playTri: need<HTMLSpanElement>('play-tri'),
  scrubBar: need<HTMLDivElement>('scrub-bar'),
  scrubBuffer: need<HTMLDivElement>('scrub-buffer'),
  scrubFill: need<HTMLDivElement>('scrub-fill'),
  scrubKnob: need<HTMLSpanElement>('scrub-knob'),
  scrubLeft: need<HTMLSpanElement>('scrub-left'),
  scrubNote: need<HTMLSpanElement>('scrub-note'),
  scrubRight: need<HTMLSpanElement>('scrub-right'),
  seekBack: need<HTMLButtonElement>('seek-back'),
  seekFwd: need<HTMLButtonElement>('seek-fwd'),
  volume: need<HTMLDivElement>('volume'),
  volumeIcon: need<HTMLSpanElement>('volume-icon'),
  volumeFill: need<HTMLSpanElement>('volume-fill'),
  notice: need<HTMLParagraphElement>('player-notice'),

  tracksVeil: need<HTMLDivElement>('tracks-veil'),
  tracksPanel: need<HTMLElement>('tracks-panel'),
  tracksSub: need<HTMLParagraphElement>('tracks-sub'),
  tracksClose: need<HTMLButtonElement>('tracks-close'),
  tabAudio: need<HTMLButtonElement>('tab-audio'),
  tabSubs: need<HTMLButtonElement>('tab-subs'),
  audioList: need<HTMLUListElement>('audio-list'),
  audioNote: need<HTMLParagraphElement>('audio-note'),
  subtitleList: need<HTMLUListElement>('subtitle-list'),
  tracksRemember: need<HTMLButtonElement>('tracks-remember'),
  rememberSwitch: need<HTMLSpanElement>('remember-switch'),
};

/** Filhos do esqueleto que nao tem id proprio, mas que a tela precisa mexer. */
const heroDot = dom.heroChip.querySelector<HTMLElement>('.dot');
const volumeTrack = dom.volume.querySelector<HTMLElement>('.volume__track') ?? dom.volume;

/* --- estado central ------------------------------------------------------- */

/** Sessao de catalogo em andamento. null quando o ao vivo e quem toca. */
interface VodSession {
  player: VodPlayer;
  video: HTMLVideoElement;
  episodes: EpisodeRef[];
  index: number;
  /** Faixa FONTE de dublagem tocando via `?audio=N`; null quando e a default. */
  audioIndex: number | null;
}

/** Qual episodio abrir quando a tela do player entrar com `source: 'vod'`. */
interface VodIntent {
  /** Preferido quando existe: a faixa de retomada so conhece o id. */
  episodeId: string | null;
  index: number;
  /** 0 forca "do inicio"; null deixa a retomada do historico decidir. */
  startMs: number | null;
}

const storage = browserStorage();

let screen: Screen = initialScreen();
let channels: ChannelSummary[] = [];
let channelsLoaded = false;
/** Catalogo por numero de canal; uma serie so e buscada uma vez por sessao. */
const episodeCache = new Map<number, EpisodeRef[]>();

/** Faixas do catalogo, na ordem em que aparecem na tela. */
const RAIL_HERO = 0;
const RAIL_LIVE = 1;
const RAIL_RESUME = 2;
const RAIL_SHELF = 3;

let homeCursor: RailCursor = { rail: RAIL_HERO, index: 0 };
let seriesCursor: RailCursor = { rail: 0, index: 0 };
let searchQuery = '';

/** Grade de todos os canais; null enquanto `/api/now` nao respondeu. */
let nowAll: TimedNowAll | null = null;
let nowFetchedAtMs = 0;
let resume: ResumeEntry[] = [];
/** Barras do ao vivo que o relogio precisa repintar sem redesenhar a faixa. */
interface LiveCardRefs {
  playing: NowPlaying;
  /** Canal do card; e a chave que diz se a faixa pode ser reaproveitada. */
  channelNumber: number;
  /**
   * Fundo do card. Fica guardado porque o quadro e do EPISODIO: na virada da
   * grade o card continua o mesmo e a imagem tem de andar junto com o texto.
   */
  art: HTMLElement;
  sub: HTMLElement;
  fill: HTMLElement;
  time: HTMLElement;
}
let liveCards: LiveCardRefs[] = [];
/** Requests de grade em voo, para o relogio nao empilhar um por segundo. */
let nowInFlight = false;
/** O que o acervo desenhou da ultima vez; null quando o DOM foi limpo. */
let shelfPainted: string | null = null;
/** Mesma marca para a retomada e para a lista de episodios. */
let resumePainted: string | null = null;
let episodesPainted: string | null = null;

/** Aba de temporada escolhida na tela da serie; null quando nao ha abas. */
let seasonTab: SeasonTab | null = null;

let tracks: TracksState = initialTracks();
let vod: VodSession | null = null;
let vodIntent: VodIntent = { episodeId: null, index: 0, startMs: null };
// Cache local primeiro: o player abre com a preferencia certa antes de o
// `GET /api/settings` responder. O servidor corrige assim que chega.
let preferredSubtitle = readPreferredSubtitle(storage);
let preferredAudio = readPreferredAudio(storage);

/** Preferencias do servidor. null enquanto a rota nao respondeu nesta sessao. */
let settings: AppSettings | null = null;
let settingsUi: SettingsUiState = initialSettings();
let library: LibraryStatus | null = null;
let libraryTimer: number | null = null;
let libraryFails = 0;
/** Invalida a resposta de um PATCH antigo quando a seta anda de novo no meio. */
let settingsPatch = 0;

/** Onde o usuario parou, por episodio. Vem do servidor; atualizado localmente. */
let history = new Map<string, WatchProgress>();
let progressTimer: number | null = null;
/** Invalida um poll de variante antigo quando o usuario troca de novo no meio. */
let variantPoll = 0;
/** Mesma ideia, para a espera do arquivo default (202 de remux em geracao). */
let streamWait = 0;

let overlayTimer: number | null = null;
let noticeTimer: number | null = null;

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

/* --- utilidades de DOM ---------------------------------------------------- */

function clear(node: Element): void {
  node.replaceChildren();
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  // `textContent` e nao `innerHTML`: nome de serie e sinopse vem de provedor de
  // metadata, e markup vindo de la nao pode virar markup aqui.
  if (text !== undefined) node.textContent = text;
  return node;
}

function percent(ratio: number): string {
  return `${(Math.min(1, Math.max(0, ratio)) * 100).toFixed(2)}%`;
}

/**
 * Escrita idempotente. O relogio do catalogo passa por todo card do ao vivo a
 * cada segundo; escrever o mesmo texto de novo sujaria o layout de graca.
 */
function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

function setWidth(node: HTMLElement, ratio: number): void {
  const width = percent(ratio);
  if (node.style.width !== width) node.style.width = width;
}

function smooth(): ScrollBehavior {
  return reducedMotion.matches ? 'auto' : 'smooth';
}

/** Foco numa lista vertical (configuracoes): so o eixo do bloco precisa rolar. */
function focusRow(row: Element | undefined): void {
  if (!(row instanceof HTMLElement)) return;
  row.focus({ preventScroll: true });
  row.scrollIntoView({ block: 'nearest', behavior: smooth() });
}

/**
 * Foco num item de faixa. `inline: 'nearest'` e o que faz o card focado entrar
 * na tela na horizontal: sem ele o cursor anda para fora do carrossel e o
 * usuario perde de vista o que esta selecionando.
 */
function focusItem(rows: readonly HTMLElement[][], cursor: RailCursor): void {
  const node = rows[cursor.rail]?.[cursor.index];
  if (node === undefined) return;
  node.focus({ preventScroll: true });
  node.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: smooth() });
}

/**
 * O item de faixa focado agora, ou null.
 *
 * Toda faixa e refeita quando uma resposta chega, e o elemento focado sai do
 * DOM junto - o foco cai no `<body>` e o Enter do controle remoto deixa de
 * fazer efeito, porque ele depende de haver um `<button>` focado. Quem repinta
 * pergunta isto ANTES, como `renderSettings` ja fazia.
 */
function focusedItem(rows: readonly HTMLElement[][]): HTMLElement | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return null;
  return rows.some((row) => row.includes(active)) ? active : null;
}

/**
 * Devolve o foco depois da repintura, e so quando ele se perdeu de verdade:
 * refocar quem continua no DOM arrastaria de volta a rolagem que o usuario
 * acabou de fazer com o mouse.
 */
function restoreFocus(
  before: HTMLElement | null,
  rows: readonly HTMLElement[][],
  cursor: RailCursor,
): void {
  if (before === null || before.isConnected) return;
  focusItem(rows, cursor);
}

/** Elemento de video que esta na tela agora - o ao vivo troca os dois na virada. */
function currentVideo(): HTMLVideoElement {
  return dom.videoA.hidden ? dom.videoB : dom.videoA;
}

/**
 * Campos que o contrato ganhou no redesenho. O servidor pode ser mais velho do
 * que esta tela (ele esta sendo escrito em paralelo): ler direto daria
 * `undefined` no lugar de uma lista e a tela quebraria em vez de so mostrar
 * menos.
 */
function seasonsOf(channel: ChannelSummary): number[] {
  return Array.isArray(channel.seasons) ? channel.seasons : [];
}

function backdropOf(channel: ChannelSummary | ResumeEntry): string | null {
  return imageUrl(channel.backdropUrl);
}

/* --- linha de meta -------------------------------------------------------- */

interface MetaPiece {
  kind: 'text' | 'badge';
  text: string;
}

const metaText = (value: string | null): MetaPiece | null =>
  value === null || value === '' ? null : { kind: 'text', text: value };

const metaBadge = (value: string | null): MetaPiece | null =>
  value === null || value === '' ? null : { kind: 'badge', text: value };

/**
 * `1989 · 142 episódios · 1080p · 3 idiomas`, cada pedaco num elemento proprio
 * porque a linha e um flex com gap. O que nao se sabe nao entra - e o `·` so
 * nasce entre dois pedacos que existem, nunca orfao na ponta.
 *
 * `.badge` e o selo da linha de meta (hero e serie); `.tag`, o selo menor da
 * linha de episodio. Sao dois desenhos diferentes no CSS.
 */
function metaInto(node: HTMLElement, pieces: readonly (MetaPiece | null)[]): void {
  clear(node);
  const kept = pieces.filter((piece): piece is MetaPiece => piece !== null);
  kept.forEach((piece, at) => {
    if (at > 0) node.append(el('span', 'sep', '·'));
    node.append(piece.kind === 'badge' ? el('span', 'badge', piece.text) : el('span', undefined, piece.text));
  });
}

/* --- arte ----------------------------------------------------------------- */

/**
 * Pendura a arte quando ela existe. Sem URL o elemento fica vazio de proposito:
 * o padrao listrado do CSS e um desenho, nao uma falha, e um `<img>` quebrado
 * por cima dele seria pior do que nada.
 */
function artInto(box: HTMLElement, url: string | null, className: string): void {
  // Mesma arte de antes: recriar a `<img>` deixaria um quadro sem imagem por
  // causa do `decoding="async"`, e o hero piscaria o listrado a cada minuto,
  // que e a cadencia com que `/api/now` repinta o catalogo.
  const current = box.querySelector<HTMLImageElement>('img');
  if (url !== null && current?.getAttribute('src') === url) return;

  clear(box);
  if (url === null) return;

  const img = el('img', className);
  img.src = url;
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  // Arte apagada do volume com a linha ainda no indice: 404 volta ao listrado
  // em vez do icone de imagem quebrada do navegador.
  img.addEventListener('error', () => clear(box));
  box.append(img);
}

/** Capa 2:3 da tela da serie, com as iniciais como ultimo recurso. */
function posterInto(box: HTMLElement, name: string, url: string | null): void {
  // Mesmo motivo de `artInto`: a tela da serie e repintada a cada resposta de
  // historico, e a capa nao pode piscar por causa disso.
  const current = box.querySelector<HTMLImageElement>('img');
  if (url !== null && current?.getAttribute('src') === url) return;

  clear(box);
  if (url === null) {
    box.append(el('span', 'cover__initials', initialsOf(name)));
    return;
  }

  const img = el('img', 'cover__img');
  img.src = url;
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.addEventListener('error', () => {
    clear(box);
    box.append(el('span', 'cover__initials', initialsOf(name)));
  });
  box.append(img);
}

/**
 * Fundo de um card: a arte quando existe, senao o rotulo listrado - e, no card
 * 2:3, as iniciais logo depois dele (e nessa ordem que o CSS esconde um em
 * favor do outro). O rotulo NAO entra junto com a arte: ele ficaria escrito no
 * meio da capa.
 */
function cardArtInto(
  art: HTMLElement,
  url: string | null,
  ghost: string,
  initials: string | null,
): void {
  const placeholder = (): HTMLElement[] => {
    const nodes = [el('span', 'card__ghost', ghost)];
    if (initials !== null) nodes.push(el('span', 'card__initials', initials));
    return nodes;
  };

  // Card reaproveitado (a faixa do ao vivo faz isso a cada minuto): a arte que
  // ja esta la e a mesma, e trocar a `<img>` so pagaria um quadro de listrado.
  const current = art.querySelector<HTMLImageElement>('img');
  if (url !== null && current?.getAttribute('src') === url) return;
  if (current !== null) current.remove();

  if (url === null) {
    if (art.querySelector('.card__ghost') === null) art.prepend(...placeholder());
    return;
  }

  // O card ja mostrava o listrado e agora tem imagem: e o caminho normal do
  // quadro de episodio, que a fila do servidor preenche com a tela aberta.
  art.querySelectorAll('.card__ghost, .card__initials').forEach((node) => {
    node.remove();
  });

  const img = el('img', 'card__img');
  img.src = url;
  img.alt = '';
  // 500 episodios com miniatura sao 500 imagens no catalogo: a que esta fora da
  // faixa visivel nao chega a ser pedida, e a que chega decodifica fora da
  // thread que desenha.
  img.loading = 'lazy';
  img.decoding = 'async';
  // Arte apagada do volume com a linha ainda no indice: `prepend` devolve o
  // placeholder ATRAS dos selos, que ja estao no card.
  img.addEventListener('error', () => {
    img.remove();
    art.prepend(...placeholder());
  });
  // `prepend`, e nao `append`: num card reaproveitado os selos e a barra ja
  // estao ali, e a imagem entra POR BAIXO deles.
  art.prepend(img);
}

/**
 * Fundo da linha de episodio: o quadro do proprio arquivo quando ele ja existe,
 * senao o rotulo listrado. Mesmo desenho de `cardArtInto`, com um placeholder
 * so - a linha de episodio nao tem iniciais.
 */
function episodeArtInto(art: HTMLElement, url: string | null): void {
  const current = art.querySelector<HTMLImageElement>('img');
  if (url !== null && current?.getAttribute('src') === url) return;
  if (current !== null) current.remove();

  if (url === null) {
    if (art.querySelector('.ep__ghost') === null) art.prepend(el('span', 'ep__ghost', 'frame'));
    return;
  }

  art.querySelector('.ep__ghost')?.remove();

  const img = el('img', 'ep__img');
  img.src = url;
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  // 404 e o normal aqui: a fila leva minutos e a rota so responde depois que o
  // quadro existe. Voltar ao listrado e o comportamento certo, nao um remendo.
  img.addEventListener('error', () => {
    img.remove();
    art.prepend(el('span', 'ep__ghost', 'frame'));
  });
  art.prepend(img);
}

/* --- players -------------------------------------------------------------- */

/** true enquanto o aviso "Preparando o episódio…" do ao vivo esta na tela. */
let livePreparing = false;

/**
 * Veredito de reproducao do episodio no ar. Guardado aqui, e nao lido do
 * player, porque `ChannelPlayer.playing` e privado de proposito - e o que a
 * tela precisa saber e so isto: quando o `<video>` falhar, o defeito e a rede
 * ou o formato do arquivo?
 */
let livePlayback: EpisodeRef['playback'] = undefined;

const live = new ChannelPlayer(dom.videoA, dom.videoB, {
  onTuned: (playing) => {
    livePreparing = false;
    livePlayback = playing.episode.playback;
    notice(null);
    renderOverlay();
    applyPreferredSubtitle(playing.episode);
  },
  onEpisodeChange: (playing) => {
    // Na virada da grade o episodio muda, e com ele o veredito: sem esta linha
    // um `.avi` que entrou no ar seria diagnosticado com o formato do anterior.
    livePlayback = playing.episode.playback;
    // So o aviso de "preparando" sai daqui: apagar qualquer aviso na virada
    // engoliria o "Clique na tela para começar" de um autoplay bloqueado.
    if (livePreparing) {
      livePreparing = false;
      notice(null);
    }
    renderOverlay();
    // Virada da grade: o overlay volta por alguns segundos anunciando o que
    // entrou no ar, como o rodape de canal de TV.
    poke();
    // Elemento novo entrou no ar na virada: a legenda escolhida precisa ser
    // pendurada de novo, senao a maratona continua sem legenda nenhuma.
    applyPreferredSubtitle(playing.episode);
    if (tracks.open) renderTracksPanel();
  },
  onBlocked: () => notice('Clique na tela para começar', { sticky: true }),
  onStalled: (reason) =>
    notice(
      reason === 'error'
        ? // Formato que o navegador nao abre nao e "sem sinal": mandar a pessoa
          // conferir a rede quando o defeito e o arquivo custa a tarde dela.
          (playbackProblemText(livePlayback) ?? 'Sem sinal')
        : 'Sinal fraco',
    ),
  // O player espera sozinho e segue quando o remux fica pronto; o aviso existe
  // so para a tela nao ficar preta sem explicacao.
  onPreparing: () => {
    livePreparing = true;
    notice('Preparando o episódio…', { sticky: true });
  },
  onError: (error) => failed(error),
});

/** Recorte comum de `ChannelPlayer` e `VodPlayer`: quem estiver no ar leva o som. */
interface AudioControl {
  readonly volumeLevel: number;
  readonly isMuted: boolean;
  setVolume(level: number): number;
  toggleMute(): boolean;
}

function activeAudio(): AudioControl {
  return vod === null ? live : vod.player;
}

/* --- sessao e erros ------------------------------------------------------- */

/**
 * Sessao expirada e o unico erro com tratamento universal: de qualquer tela, a
 * saida e a senha. O resto do recado e por conta de quem chamou, porque cada
 * tela tem um lugar proprio para mostrar defeito - o `notice` so existe dentro
 * do player.
 *
 * @returns true quando o erro ja foi resolvido trocando de tela.
 */
function expiredSession(error: unknown): boolean {
  if (!(error instanceof UnauthorizedError)) return false;
  go({ type: 'unauthorized' });
  return true;
}

function failed(error: unknown): void {
  if (expiredSession(error)) return;
  notice('Falha ao falar com o servidor');
}

function notice(text: string | null, options: { sticky?: boolean } = {}): void {
  if (noticeTimer !== null) window.clearTimeout(noticeTimer);
  if (text === null) {
    dom.notice.hidden = true;
    return;
  }
  dom.notice.textContent = text;
  dom.notice.hidden = false;
  if (options.sticky === true) return;
  noticeTimer = window.setTimeout(() => {
    dom.notice.hidden = true;
  }, NOTICE_HOLD_MS);
}

/* --- navegacao entre telas ------------------------------------------------ */

/**
 * Unica porta de troca de tela. A ordem importa: o reducer decide, a tela velha
 * se despede, o DOM aparece e so entao a tela nova entra - dar foco num
 * elemento ainda escondido nao funciona.
 */
function go(event: ScreenEvent): void {
  const before = screen;
  const after = reduceScreen(before, event);
  if (after === before) return;

  screen = after;
  onLeave(before, after);
  render();
  onEnter(before, after);
}

function onLeave(before: Screen, after: Screen): void {
  // Intervalo vivo em tela fechada e vazamento: ele bateria na API para sempre.
  if (before.name === 'settings' && after.name !== 'settings') stopLibraryPolling();

  if (before.name !== 'player' || after.name === 'player') return;
  // Sair do player e sempre parar de tocar: som de episodio continuando por
  // baixo do catalogo seria assombracao.
  //
  // O relogio do overlay sai junto. Ele se reagenda sozinho enquanto o video
  // esta pausado - e um video parado e exatamente o que fica para tras aqui -,
  // entao um timeout pendente viraria um laco de 3 em 3 segundos pelo resto da
  // vida da pagina, mexendo numa tela que ninguem ve.
  stopOverlayTimer();
  closeTracks();
  endVod();
  live.stop();
  clearSubtitles(dom.videoA);
  clearSubtitles(dom.videoB);
  notice(null);
}

function onEnter(before: Screen, after: Screen): void {
  switch (after.name) {
    case 'login':
      dom.loginPassword.value = '';
      dom.loginError.textContent = '';
      window.setTimeout(() => dom.loginPassword.focus(), 0);
      return;

    case 'home':
      void openHome(before);
      return;

    case 'series':
      void openSeries(after.channel);
      return;

    case 'settings':
      void openSettings();
      return;

    case 'player':
      writeLastChannel(storage, after.channel);
      // Foco preso num botao faria Espaco e Enter reclicarem o botao em vez de
      // pausar ou selecionar trilha.
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      poke();
      void openPlayer(after);
      return;

    default:
      return;
  }
}

function render(): void {
  dom.login.hidden = screen.name !== 'login';
  dom.home.hidden = screen.name !== 'home';
  dom.series.hidden = screen.name !== 'series';
  dom.settings.hidden = screen.name !== 'settings';
  dom.player.hidden = screen.name !== 'player';
  // A topbar so serve ao catalogo: serie e configuracoes tem barra propria, com
  // o botao de voltar no lugar da busca.
  dom.topbar.hidden = screen.name !== 'home';
  if (screen.name === 'player') renderOverlay();
}

/* --- 2. catalogo ---------------------------------------------------------- */

function channelAt(number: number): ChannelSummary | null {
  return channels.find((channel) => channel.number === number) ?? null;
}

function episodesOf(number: number): EpisodeRef[] | null {
  return episodeCache.get(number) ?? null;
}

/** O que esta no ar num canal, segundo a ultima resposta de `/api/now`. */
function nowOf(channelNumber: number): NowPlaying | null {
  return nowAll?.data.find((item) => item.channel.number === channelNumber) ?? null;
}

/** Amostra de sincronia de um item da grade, para projetar a barra adiante. */
function nowSampleOf(playing: NowPlaying, timed: TimedNowAll): NowSample {
  return {
    serverTimeMs: playing.serverTimeMs,
    offsetMs: playing.offsetMs,
    durationMs: playing.episode.durationMs,
    sentAtMs: timed.sentAtMs,
    receivedAtMs: timed.receivedAtMs,
  };
}

/** Posicao projetada agora, presa dentro do episodio. */
function liveOffsetMs(playing: NowPlaying): number {
  if (nowAll === null) return playing.offsetMs;
  const projected = expectedOffsetMs(nowSampleOf(playing, nowAll), Date.now());
  return Math.min(Math.max(0, projected), Math.max(0, playing.episode.durationMs));
}

/** Recado no lugar do catalogo: acervo vazio e falha de rede tem o mesmo espaco. */
function homeMessage(title: string, text: string): void {
  clear(dom.railShelf);
  // O DOM foi limpo por fora do desenho normal: sem zerar a marca, a proxima
  // repintura com a mesma assinatura acharia que nao tem nada a fazer.
  shelfPainted = null;
  dom.homeEmptyTitle.textContent = title;
  dom.homeEmptyText.textContent = text;
  dom.homeEmpty.hidden = false;
}

async function openHome(before: Screen): Promise<void> {
  // Preferencias uma vez por sessao, sem segurar a grade: e o que faz o
  // primeiro episodio abrir ja com o idioma escolhido na tela de configuracoes.
  if (settings === null) void loadSettings();

  if (!channelsLoaded) {
    renderSkeleton();
    try {
      channels = await fetchChannels();
      channelsLoaded = true;
    } catch (error) {
      if (!expiredSession(error)) {
        homeMessage(
          'Não foi possível carregar o catálogo',
          'O servidor não respondeu. Confira se ele está no ar e recarregue a página.',
        );
      }
      return;
    }
    // Historico junto do catalogo, sem segurar a grade: ele so pinta barras e
    // decide retomadas, e chega quando chegar.
    void refreshHistory();
  }

  renderHome();
  void refreshNow();
  void refreshResume();

  // Voltando da serie: o foco cai no card de onde se saiu, nao no primeiro.
  if (before.name === 'series') focusChannelCard(before.channel);
  focusItem(homeRows(), homeCursor);
}

/** Faixas do catalogo como matriz de elementos focaveis, na ordem da tela. */
function homeRows(): HTMLElement[][] {
  const hero = dom.hero.hidden ? [] : [dom.heroPlay, dom.heroEpisodes, dom.heroFirst];
  return [hero, railItems(dom.railLive), railItems(dom.railResume), railItems(dom.railShelf)];
}

/** Os cards de verdade: o placeholder de carregamento nao recebe foco. */
function railItems(rail: HTMLElement): HTMLElement[] {
  return Array.from(rail.querySelectorAll<HTMLElement>('.card:not(.skeleton)'));
}

/** O foco do DOM E o cursor: mouse, Tab e controle remoto escrevem no mesmo lugar. */
function bindHomeFocus(node: HTMLElement, rail: number, index: number): void {
  node.addEventListener('focus', () => {
    homeCursor = { rail, index };
    renderNav();
  });
}

function focusChannelCard(channelNumber: number): void {
  const at = visibleChannels().findIndex((channel) => channel.number === channelNumber);
  if (at !== -1) homeCursor = { rail: RAIL_SHELF, index: at };
}

function visibleChannels(): ChannelSummary[] {
  return filterChannels(channels, searchQuery);
}

/**
 * Repinta faixas do catalogo sem largar o foco.
 *
 * `/api/now` responde ~100 ms depois de a tela abrir, e de novo a cada minuto;
 * `/api/history/resume` tambem chega atrasado. Sem isto, o card que o usuario
 * acabou de focar sai do DOM no meio do caminho e o Enter do controle remoto
 * nao faz mais nada.
 */
function repaintHome(paint: () => void): void {
  const before = focusedItem(homeRows());
  paint();
  homeCursor = clampRail(
    homeCursor,
    homeRows().map((row) => row.length),
  );
  renderNav();
  restoreFocus(before, homeRows(), homeCursor);
}

function renderHome(): void {
  repaintHome(() => {
    renderHero();
    renderLiveRail();
    renderResumeRail();
    renderShelfRail();
  });
}

function renderSkeleton(): void {
  clear(dom.railShelf);
  shelfPainted = null;
  dom.hero.hidden = true;
  dom.homeEmpty.hidden = true;
  for (let i = 0; i < 8; i += 1) {
    const card = el('div', 'card card--tall skeleton');
    card.append(el('span', 'card__art'), el('span', 'card__text'));
    dom.railShelf.append(card);
  }
}

/* --- hero ----------------------------------------------------------------- */

/** O canal do hero: o ultimo assistido, ou o primeiro do catalogo. */
function heroChannel(): ChannelSummary | null {
  if (channels.length === 0) return null;
  const last = readLastChannel(
    storage,
    channels.map((channel) => channel.number),
  );
  return (last === null ? null : channelAt(last)) ?? channels[0] ?? null;
}

function renderHero(): void {
  const channel = heroChannel();
  dom.hero.hidden = channel === null;
  if (channel === null) return;

  const playing = nowOf(channel.number);
  // Arte do canal na frente; sem ela, o quadro do episodio no ar. A maior
  // superficie da tela nao pode ficar no listrado tendo imagem valida a mao.
  artInto(dom.heroArt, backdropOf(channel) ?? episodeArtUrl(playing?.episode ?? null), 'hero__img');
  const onAir = playing !== null;
  dom.heroChip.classList.toggle('chip--live', onAir);
  if (heroDot !== null) heroDot.hidden = !onAir;
  dom.heroChipText.textContent = onAir
    ? `${channelLabel(channel.number)} · no ar agora`
    : channelLabel(channel.number);

  dom.heroTitle.textContent = channel.name;

  // O episodio no ar e a melhor fonte de resolucao e idiomas do hero: ele veio
  // com o `/api/now` e e um arquivo de verdade desta serie.
  const episode = playing?.episode ?? episodesOf(channel.number)?.[0] ?? null;
  metaInto(dom.heroMeta, [
    metaText(channel.year === null ? null : String(channel.year)),
    metaText(episodesLabel(channel.episodeCount)),
    metaBadge(episode === null ? null : resolutionBadge(episode.width, episode.height)),
    metaBadge(episode === null ? null : languagesBadge(episode.audioTracks)),
  ]);

  dom.heroText.textContent = heroSentence(
    playing === null
      ? null
      : { episodeNumber: playing.episode.episode, elapsedMs: liveOffsetMs(playing) },
  );

  dom.heroPlay.onclick = () => go({ type: 'watch', source: 'live', channel: channel.number });
  dom.heroEpisodes.onclick = () => go({ type: 'openSeries', channel: channel.number });
  dom.heroFirst.onclick = () => watchFromStart(channel.number);

  bindHeroFocus();
}

let heroFocusBound = false;

function bindHeroFocus(): void {
  if (heroFocusBound) return;
  heroFocusBound = true;
  [dom.heroPlay, dom.heroEpisodes, dom.heroFirst].forEach((node, index) => {
    bindHomeFocus(node, RAIL_HERO, index);
  });
}

/* --- faixa "no ar agora" -------------------------------------------------- */

/** Imagem do card do ao vivo: o quadro do episodio no ar, senao a arte do canal. */
function liveArtOf(playing: NowPlaying): string | null {
  return wideArtUrl(playing.episode, backdropOf(playing.channel));
}

function renderLiveRail(): void {
  const all = nowAll?.data ?? [];
  dom.rowLive.hidden = all.length === 0;
  dom.navLive.disabled = all.length === 0;
  // A contagem e sempre a de verdade, mesmo com a faixa cortada: o aside conta
  // quantos canais TEM grade, nao quantos cards couberam.
  dom.rowLiveAside.textContent = liveAside(all.length);
  if (all.length === 0) {
    clear(dom.railLive);
    liveCards = [];
    return;
  }

  const items = all.slice(0, LIVE_RAIL_LIMIT);

  // Mesma sequencia de canais que ja esta na tela: so o texto anda. Refazer os
  // cards a cada minuto recriaria as `<img>` e faria o listrado piscar por
  // baixo delas, alem de jogar fora o foco.
  const sameChannels =
    liveCards.length === items.length &&
    items.every((playing, at) => liveCards[at]?.channelNumber === playing.channel.number);

  if (sameChannels) {
    items.forEach((playing, at) => {
      const card = liveCards[at];
      if (card === undefined) return;
      card.playing = playing;
      setText(card.sub, episodeHeadline(playing.episode));
      // A imagem do card e o quadro do EPISODIO: na virada da grade ela muda
      // sem o card mudar. `cardArtInto` nao encosta no DOM quando a URL e a
      // mesma, entao chamar isto de minuto em minuto nao custa nada.
      cardArtInto(card.art, liveArtOf(playing), 'frame do episódio', null);
    });
    tickLiveRail();
    return;
  }

  clear(dom.railLive);
  liveCards = [];

  items.forEach((playing, index) => {
    const card = el('button', 'card card--wide');
    card.type = 'button';

    const art = el('span', 'card__art');
    cardArtInto(art, liveArtOf(playing), 'frame do episódio', null);
    art.append(
      el('span', 'card__chan', channelNumberLabel(playing.channel.number)),
      el('span', 'card__live', 'ao vivo'),
    );

    const bar = el('span', 'card__bar');
    const fill = el('span', 'card__bar-fill');
    bar.append(fill);
    art.append(bar);

    const time = el('span', 'card__time');
    const sub = el('span', 'card__sub', episodeHeadline(playing.episode));
    const text = el('span', 'card__text');
    text.append(el('span', 'card__name', playing.channel.name), sub, time);

    card.append(art, text);
    // O numero do canal e capturado agora: o `playing` do card e trocado a cada
    // resposta, mas o canal daquela posicao nao muda sem uma repintura inteira.
    const channelNumber = playing.channel.number;
    card.addEventListener('click', () =>
      go({ type: 'watch', source: 'live', channel: channelNumber }),
    );
    bindHomeFocus(card, RAIL_LIVE, index);
    dom.railLive.append(card);

    liveCards.push({ playing, channelNumber, art, sub, fill, time });
  });

  tickLiveRail();
}

/** Repinta so o que anda: a barra e o "faltam N min" de cada card do ao vivo. */
function tickLiveRail(): void {
  for (const card of liveCards) {
    const duration = Math.max(0, card.playing.episode.durationMs);
    const offset = liveOffsetMs(card.playing);
    setWidth(card.fill, duration === 0 ? 0 : offset / duration);
    setText(card.time, formatRemaining(duration - offset));
  }
}

/* --- faixa "continuar assistindo" ----------------------------------------- */

/**
 * Tudo o que a faixa de retomada mostra, numa linha so.
 *
 * A faixa e repintada a cada volta ao catalogo, e cada card e uma imagem: sem
 * esta marca, sair de uma serie e voltar recriaria as `<img>` e faria o
 * listrado piscar por baixo de todas elas.
 */
function resumeSignature(entries: readonly ResumeEntry[]): string {
  return entries
    .map((entry) =>
      [
        entry.channelNumber,
        entry.channelName,
        entry.episode.id,
        resumeArtOf(entry) ?? '',
        entry.positionMs,
        entry.durationMs,
        episodeHeadline(entry.episode),
      ].join(' '),
    )
    .join('|');
}

/** Imagem do card de retomada: o quadro do episodio parado, senao a arte do canal. */
function resumeArtOf(entry: ResumeEntry): string | null {
  return wideArtUrl(entry.episode, backdropOf(entry));
}

function renderResumeRail(): void {
  dom.rowResume.hidden = resume.length === 0;
  if (resume.length === 0) {
    clear(dom.railResume);
    resumePainted = null;
    return;
  }

  const signature = resumeSignature(resume);
  if (signature === resumePainted) return;
  resumePainted = signature;
  clear(dom.railResume);

  resume.forEach((entry, index) => {
    const card = el('button', 'card card--wide');
    card.type = 'button';

    const art = el('span', 'card__art');
    cardArtInto(art, resumeArtOf(entry), 'frame do episódio', null);

    const play = el('span', 'card__play');
    play.append(el('span', 'tri'));

    const bar = el('span', 'card__bar');
    const fill = el('span', 'card__bar-fill');
    fill.style.width = percent(progressRatio(entry));
    bar.append(fill);

    art.append(play, el('span', 'card__left', formatLeftBadge(remainingMs(entry))), bar);

    const text = el('span', 'card__text');
    text.append(
      el('span', 'card__name', entry.channelName),
      el('span', 'card__sub', episodeHeadline(entry.episode)),
    );

    card.append(art, text);
    // A posicao vem da propria entrada, que e o que o card acabou de desenhar.
    card.addEventListener('click', () =>
      watchEpisodeId(entry.channelNumber, entry.episode.id, resumeStartMs(entry)),
    );
    bindHomeFocus(card, RAIL_RESUME, index);
    dom.railResume.append(card);
  });
}

/* --- faixa "todo o acervo" ------------------------------------------------ */

/**
 * Selo de resolucao do card 2:3.
 *
 * Sai do primeiro episodio da serie quando ele ja foi buscado e, senao, do que
 * esta no ar - e um arquivo real desta serie, medido pelo mesmo probe. Sem
 * nenhum dos dois o selo simplesmente nao aparece: inventar "1080p" para 84
 * canais seria decorar a tela com mentira.
 */
function shelfBadge(channel: ChannelSummary): string | null {
  const episode = episodesOf(channel.number)?.[0] ?? nowOf(channel.number)?.episode ?? null;
  return episode === null ? null : resolutionBadge(episode.width, episode.height);
}

/** Retomada em aberto no canal, para a barrinha do card do acervo. */
function shelfProgress(channelNumber: number): number {
  const entry = resume.find((item) => item.channelNumber === channelNumber);
  return entry === undefined ? 0 : progressRatio(entry);
}

/**
 * Tudo o que um card do acervo mostra, numa linha.
 *
 * O acervo e repintado junto de cada resposta de `/api/now`, mas quase nada
 * dele depende da grade: refazer 460 cards de minuto em minuto recriaria as
 * capas e faria o listrado piscar por baixo de todas elas.
 */
function shelfSignature(visible: readonly ChannelSummary[]): string {
  return visible
    .map((channel) =>
      [
        channel.number,
        channel.name,
        channel.posterUrl ?? '',
        shelfBadge(channel) ?? '',
        shelfProgress(channel.number).toFixed(3),
        formatChannelMeta(channel.year, channel.episodeCount),
      ].join(' '),
    )
    .join('');
}

function renderShelfRail(): void {
  const visible = visibleChannels();
  dom.rowShelfAside.textContent = shelfAside(searchQuery, visible.length);
  dom.homeEmpty.hidden = channels.length > 0;
  if (channels.length === 0) {
    clear(dom.railShelf);
    shelfPainted = null;
    return;
  }

  if (visible.length === 0) {
    const empty = emptySearchText(searchQuery);
    if (shelfPainted === empty) return;
    shelfPainted = empty;
    clear(dom.railShelf);
    dom.railShelf.append(el('p', 'rail__empty', empty));
    return;
  }

  const signature = shelfSignature(visible);
  // Nada do que se ve mudou: nao encostar no DOM preserva o foco, a rolagem da
  // faixa e as capas ja decodificadas.
  if (signature === shelfPainted) return;
  shelfPainted = signature;
  clear(dom.railShelf);

  visible.forEach((channel, index) => {
    const card = el('button', 'card card--tall');
    card.type = 'button';

    const art = el('span', 'card__art');
    cardArtInto(art, channel.posterUrl, 'capa 2:3', initialsOf(channel.name));
    // A capa (ou as iniciais) e o fundo; os selos entram por cima.
    art.append(el('span', 'card__chan', channelNumberLabel(channel.number)));

    const badge = shelfBadge(channel);
    if (badge !== null) art.append(el('span', 'card__badge', badge));

    const ratio = shelfProgress(channel.number);
    if (ratio > 0) {
      const bar = el('span', 'card__bar');
      const fill = el('span', 'card__bar-fill');
      fill.style.width = percent(ratio);
      bar.append(fill);
      art.append(bar);
    }

    const text = el('span', 'card__text');
    text.append(
      el('span', 'card__name', channel.name),
      el('span', 'card__sub', formatChannelMeta(channel.year, channel.episodeCount)),
    );

    card.append(art, text);
    card.addEventListener('click', () => go({ type: 'openSeries', channel: channel.number }));
    bindHomeFocus(card, RAIL_SHELF, index);
    dom.railShelf.append(card);
  });
}

/* --- topo do catalogo ----------------------------------------------------- */

/** Item de nav que corresponde a faixa em que o cursor esta. */
function renderNav(): void {
  const rail = homeCursor.rail;
  dom.navHome.classList.toggle('is-active', rail === RAIL_HERO || rail === RAIL_RESUME);
  dom.navLive.classList.toggle('is-active', rail === RAIL_LIVE);
  dom.navShelf.classList.toggle('is-active', rail === RAIL_SHELF);
}

function goToRail(rail: number): void {
  const rows = homeRows();
  homeCursor = clampRail(
    { rail, index: 0 },
    rows.map((row) => row.length),
  );
  focusItem(rows, homeCursor);
  renderNav();
}

function clearSearch(): void {
  dom.searchInput.value = '';
  searchQuery = '';
  renderShelfRail();
  goToRail(RAIL_SHELF);
}

/* --- rede do catalogo ----------------------------------------------------- */

/**
 * Grade de todos os canais. A faixa e OPCIONAL: a rota pode nem existir ainda
 * no servidor, e nesse caso ela simplesmente nao aparece e o resto do catalogo
 * continua igual.
 */
async function refreshNow(): Promise<void> {
  // Sem trava, um servidor lento faria o relogio do catalogo empilhar um
  // request por segundo em cima do anterior.
  if (nowInFlight) return;
  nowInFlight = true;

  let expired = false;
  try {
    nowAll = await fetchNowAll();
  } catch (error) {
    nowAll = null;
    // Sessao expirada e a saida universal do app. Engolir o 401 aqui deixava a
    // tela pedindo a grade para sempre contra um servidor que so responde 401.
    expired = expiredSession(error);
  } finally {
    // Carimbo em TODO caminho, o 401 inclusive: e ele que segura o relogio.
    nowFetchedAtMs = Date.now();
    nowInFlight = false;
  }

  if (expired || screen.name !== 'home') return;
  repaintHome(() => {
    renderHero();
    renderLiveRail();
    renderShelfRail();
  });
}

/** Mesma regra da faixa do ao vivo: falhou, a faixa some e o catalogo segue. */
async function refreshResume(): Promise<void> {
  try {
    resume = await fetchResume();
  } catch (error) {
    resume = [];
    if (expiredSession(error)) return;
  }
  if (screen.name !== 'home') return;
  repaintHome(() => {
    renderResumeRail();
    renderShelfRail();
  });
}

/* --- 3. tela da serie ----------------------------------------------------- */

async function openSeries(number: number): Promise<void> {
  seriesCursor = { rail: 0, index: 0 };
  seasonTab = null;
  renderSeries(number);
  // Outra tela pode ter avancado a maratona (a TV da sala): rebusca ao entrar.
  void refreshHistory();

  if (episodesOf(number) === null) {
    try {
      // 404 aqui e canal que sumiu num rescan: lista vazia diz a verdade do
      // ponto de vista de quem esta olhando.
      episodeCache.set(number, (await fetchEpisodes(number)) ?? []);
    } catch (error) {
      if (!expiredSession(error)) {
        clear(dom.episodeList);
        // O DOM foi limpo por fora do desenho normal: sem zerar a marca, a
        // proxima repintura com a mesma assinatura acharia que nao tem o que
        // fazer e o recado ficaria na tela para sempre.
        episodesPainted = null;
        dom.episodeList.append(el('li', 'ep__empty', 'Não foi possível carregar os episódios.'));
      }
      return;
    }
    if (screen.name !== 'series' || screen.channel !== number) return;
    renderSeries(number);
  }

  focusItem(seriesRows(), seriesCursor);
}

/**
 * A tela da serie navega como o catalogo: a linha de botoes e as abas de
 * temporada sao faixas horizontais, e cada episodio e uma faixa de um item so.
 */
function seriesRows(): HTMLElement[][] {
  const episodes = Array.from(dom.episodeList.querySelectorAll<HTMLElement>('.ep'));
  return [
    [dom.seriesResume, dom.seriesLive, dom.seriesFirst],
    Array.from(dom.seasonTabs.querySelectorAll<HTMLElement>('.season')),
    ...episodes.map((node) => [node]),
  ];
}

function bindSeriesFocus(node: HTMLElement, rail: number, index: number): void {
  node.addEventListener('focus', () => {
    seriesCursor = { rail, index };
  });
}

let seriesActionsBound = false;

function renderSeries(number: number): void {
  const channel = channelAt(number);
  if (channel === null) return;

  // Mesmo remendo de `renderSettings` e das faixas: a lista e refeita quando o
  // historico e os episodios chegam, e quem estava focado numa linha ficaria
  // com o foco no `<body>` - de onde o Enter do controle nao abre nada.
  const focusedBefore = focusedItem(seriesRows());
  const episodes = episodesOf(number);
  artInto(dom.seriesArt, backdropOf(channel), 'shero__img');
  posterInto(dom.seriesPoster, channel.name, channel.posterUrl);

  dom.seriesChannel.textContent = channelLabel(channel.number);
  dom.seriesTitle.textContent = channel.name;
  dom.seriesOverview.textContent = channel.overview ?? 'Sem sinopse para esta série.';

  const tabs = buildSeasonTabs(seasonsOf(channel), episodes ?? []);
  seasonTab = activeSeasonTab(tabs, seasonTab);

  const first = episodes?.[0] ?? nowOf(number)?.episode ?? null;
  metaInto(dom.seriesMeta, [
    metaText(channel.year === null ? null : String(channel.year)),
    metaText(tabs.length === 0 ? null : seasonsLabel(seasonCount(tabs))),
    metaText(episodesLabel(channel.episodeCount)),
    metaBadge(first === null ? null : resolutionBadge(first.width, first.height)),
    metaBadge(first === null ? null : languagesBadge(first.audioTracks)),
  ]);

  renderSeriesActions(channel, episodes);
  renderSeasonTabs(tabs);
  renderEpisodeList(number, episodes, tabs);

  if (!seriesActionsBound) {
    seriesActionsBound = true;
    [dom.seriesResume, dom.seriesLive, dom.seriesFirst].forEach((node, index) => {
      bindSeriesFocus(node, 0, index);
    });
  }
  seriesCursor = clampRail(
    seriesCursor,
    seriesRows().map((row) => row.length),
  );
  restoreFocus(focusedBefore, seriesRows(), seriesCursor);
}

/** Temporadas de verdade: a aba dos soltos nao conta como temporada. */
function seasonCount(tabs: readonly SeasonTab[]): number {
  return tabs.filter((tab) => tab.season !== null).length;
}

/** Episodio a retomar nesta serie: o mais recente que ficou pela metade. */
function resumeEpisode(episodes: readonly EpisodeRef[] | null): EpisodeRef | null {
  if (episodes === null) return null;
  let best: { episode: EpisodeRef; at: number } | null = null;
  for (const episode of episodes) {
    const entry = history.get(episode.id);
    if (entry === undefined || resumeStartMs(entry) <= 0) continue;
    if (best === null || entry.updatedAt > best.at) best = { episode, at: entry.updatedAt };
  }
  return best?.episode ?? null;
}

function renderSeriesActions(channel: ChannelSummary, episodes: EpisodeRef[] | null): void {
  const pending = resumeEpisode(episodes);
  // Sem retomada o botao primario continua sendo o de tocar: ele so muda de
  // rotulo e passa a comecar do zero.
  dom.seriesResumeText.textContent =
    pending === null ? 'Do início' : `Continuar ${formatEpisodeLabel(pending)}`;
  dom.seriesResume.disabled = episodes !== null && episodes.length === 0;
  dom.seriesFirst.disabled = episodes !== null && episodes.length === 0;

  dom.seriesResume.onclick = () => {
    if (pending === null) watchFromStart(channel.number);
    else watchEpisodeId(channel.number, pending.id);
  };
  dom.seriesLive.onclick = () => go({ type: 'watch', source: 'live', channel: channel.number });
  dom.seriesFirst.onclick = () => watchFromStart(channel.number);
}

function renderSeasonTabs(tabs: readonly SeasonTab[]): void {
  clear(dom.seasonTabs);
  // Sem temporada nenhuma a barra some e sobra o aside, que continua contando a
  // serie inteira.
  dom.seasonTabs.hidden = tabs.length === 0;
  if (tabs.length === 0) return;

  tabs.forEach((tab, index) => {
    const button = el('button', 'season', tab.label);
    button.type = 'button';
    if (seasonTab !== null && seasonTab.season === tab.season) button.classList.add('is-active');
    button.addEventListener('click', () => {
      seasonTab = tab;
      if (screen.name === 'series') renderSeries(screen.channel);
      seriesCursor = { rail: 1, index };
      focusItem(seriesRows(), seriesCursor);
    });
    bindSeriesFocus(button, 1, index);
    dom.seasonTabs.append(button);
  });
}

/**
 * Tudo o que a lista de episodios mostra, numa linha so.
 *
 * A serie e repintada quando os episodios chegam, quando o historico chega
 * depois deles e a cada troca de aba - e uma serie longa sem pastas de
 * temporada e uma lista de centenas de linhas, cada uma com uma `<img>`.
 * Repintar sem nada ter mudado jogaria fora as miniaturas ja decodificadas, a
 * rolagem e o foco de quem navega de controle remoto.
 */
function episodeListSignature(channelNumber: number, shown: readonly EpisodeRef[]): string {
  const rows = shown.map((episode, index) => {
    const entry = history.get(episode.id);
    return [
      episode.id,
      episode.title,
      episodeNumberLabel(episode, index),
      episodeArtUrl(episode) ?? '',
      episode.durationMs,
      episode.width ?? '',
      episode.height ?? '',
      episode.audioTracks.length,
      entry?.positionMs ?? '',
      entry?.durationMs ?? '',
    ].join(' ');
  });
  return [channelNumber, seasonTab?.season ?? '', ...rows].join('|');
}

function renderEpisodeList(
  channelNumber: number,
  episodes: EpisodeRef[] | null,
  tabs: readonly SeasonTab[],
): void {
  if (episodes === null) {
    clear(dom.episodeList);
    episodesPainted = null;
    dom.seasonAside.textContent = '';
    dom.episodeList.append(el('li', 'ep__empty', 'Carregando episódios…'));
    return;
  }
  if (episodes.length === 0) {
    clear(dom.episodeList);
    episodesPainted = null;
    dom.seasonAside.textContent = '';
    dom.episodeList.append(el('li', 'ep__empty', 'Nenhum episódio indexado nesta série.'));
    return;
  }

  const shown =
    tabs.length === 0 || seasonTab === null
      ? episodes
      : episodesOfSeason(episodes, seasonTab.season);
  dom.seasonAside.textContent = seasonAside(shown);

  const signature = episodeListSignature(channelNumber, shown);
  if (signature === episodesPainted) return;
  episodesPainted = signature;
  clear(dom.episodeList);

  shown.forEach((episode, index) => {
    const row = el('button', 'ep');
    row.type = 'button';

    row.append(el('span', 'ep__n', episodeNumberLabel(episode, index)));

    const art = el('span', 'ep__art');
    const bar = el('span', 'ep__bar');
    const fill = el('span', 'ep__bar-fill');
    fill.style.width = percent(progressRatio(history.get(episode.id)));
    bar.append(fill);
    // O quadro entra antes da barra: ele e o fundo da linha, e a barra fica por
    // cima dele.
    episodeArtInto(art, episodeArtUrl(episode));
    art.append(bar);

    const meta = el('span', 'ep__meta');
    appendEpisodeMeta(meta, episode);

    const text = el('span', 'ep__text');
    text.append(el('span', 'ep__title', episode.title), meta);

    const play = el('span', 'ep__play');
    play.append(el('span', 'tri'));

    row.append(art, text, play);
    row.addEventListener('click', () => watchEpisodeId(channelNumber, episode.id));
    bindSeriesFocus(row, index + 2, 0);

    const item = el('li');
    item.append(row);
    dom.episodeList.append(item);
  });
}

/** Numero a esquerda da linha: o do arquivo quando existe, senao a posicao. */
function episodeNumberLabel(episode: EpisodeRef, index: number): string {
  const number = episode.episode ?? index + 1;
  return String(number).padStart(2, '0');
}

function appendEpisodeMeta(meta: HTMLElement, episode: EpisodeRef): void {
  meta.append(el('span', undefined, formatDurationMin(episode.durationMs)));

  const badge = resolutionBadge(episode.width, episode.height);
  const audios = audiosBadge(episode.audioTracks.length);
  if (badge !== null || audios !== null) meta.append(el('span', 'ep__dot', '·'));
  if (badge !== null) meta.append(el('span', 'tag', badge));
  if (audios !== null) meta.append(el('span', 'tag', audios));

  const entry = history.get(episode.id);
  const state = watchState(entry);
  if (state === 'watched') meta.append(el('span', 'ep__state', 'assistido'));
  if (state === 'watching') {
    meta.append(el('span', 'ep__state', formatRemaining(remainingMs(entry))));
  }
}

/** Recarrega o historico do servidor e repinta o que estiver na tela. */
async function refreshHistory(): Promise<void> {
  try {
    const entries = await fetchHistory();
    history = new Map(entries.map((entry) => [entry.episodeId, entry]));
    if (screen.name === 'series') renderSeries(screen.channel);
  } catch {
    // Historico e conforto, nao funcao vital: sem ele o catalogo segue igual.
  }
}

/* --- 4. configuracoes ----------------------------------------------------- */

/** De quanto em quanto tempo perguntar o estado enquanto uma tarefa roda. */
const LIBRARY_POLL_MS = 2_000;
/** Falhas seguidas antes de desistir do polling. */
const LIBRARY_FAIL_LIMIT = 3;

/** Novo `AppSettings` do servidor: ele manda no player e semeia o cache local. */
function adoptSettings(next: AppSettings): void {
  settings = next;
  applyServerPreferences(storage, next);
  // Do servidor direto, e nao de volta do cache: com armazenamento bloqueado
  // pelo navegador a preferencia continua valendo nesta sessao.
  preferredAudio = normalizeLang(next.audioLang);
  preferredSubtitle = normalizeLang(next.subtitleLang);
}

/** Uma vez por sessao: e o que faz o player abrir com o idioma escolhido. */
async function loadSettings(): Promise<void> {
  try {
    adoptSettings(await fetchSettings());
  } catch {
    // Rota fora do ar: valem as preferencias que ficaram no cache local.
  }
}

/**
 * As linhas das DUAS listas, na ordem do cursor unico. As de reproducao vem
 * primeiro porque e essa a ordem de `settingsRows()`.
 */
function settingsRowNodes(): HTMLElement[] {
  return [
    ...Array.from(dom.settingsPlayback.querySelectorAll<HTMLElement>('.set')),
    ...Array.from(dom.settingsLibrary.querySelectorAll<HTMLElement>('.set')),
  ];
}

async function openSettings(): Promise<void> {
  settingsUi = initialSettings();
  renderSettings();

  try {
    const [next, status] = await Promise.all([fetchSettings(), fetchLibraryStatus()]);
    adoptSettings(next);
    library = status;
  } catch (error) {
    if (expiredSession(error)) return;
    settingsUi = { ...settingsUi, message: 'Não foi possível falar com o servidor.' };
    renderSettings();
    return;
  }

  // Saiu da tela enquanto as duas rotas respondiam.
  if (screen.name !== 'settings') return;
  renderSettings();
  focusRow(settingsRowNodes()[settingsUi.cursor]);
  pollLibraryWhileBusy();
}

function renderSettings(): void {
  const current = settings;
  // Redesenhar troca os botoes por outros: sem isto, uma resposta que chega
  // tarde apagaria o foco de quem esta navegando com o controle.
  const focused =
    document.activeElement instanceof HTMLElement &&
    document.activeElement.classList.contains('set');

  clear(dom.settingsPlayback);
  clear(dom.settingsLibrary);

  if (current === null) {
    // Sem `AppSettings` nao ha linha nenhuma para desenhar: elas mostram o valor
    // do servidor, e inventar um default aqui seria mentir sobre o que vale.
    const text =
      settingsUi.message === null
        ? 'Carregando configurações…'
        : 'As configurações não puderam ser carregadas.';
    dom.settingsPlayback.append(el('li', 'settings__note', text));
  } else {
    renderSettingsGroup(dom.settingsPlayback, 'playback', current);
    renderSettingsGroup(dom.settingsLibrary, 'library', current);
  }

  dom.settingsMessage.textContent = settingsUi.message ?? '';
  dom.settingsMessage.hidden = settingsUi.message === null;

  renderLibraryStatus();
  if (focused) focusRow(settingsRowNodes()[settingsUi.cursor]);
}

function renderSettingsGroup(
  list: HTMLUListElement,
  group: 'playback' | 'library',
  current: AppSettings,
): void {
  for (const row of settingsGroupRows(group)) {
    const button = el('button', `set set--${row.kind}`);
    button.type = 'button';
    // A rebusca de capas e uma acao QUE responde as setas: sem esta marca o CSS
    // esconderia a seta esquerda de uma linha cuja dica manda usar ← →.
    if (row.stepper) button.classList.add('set--stepper');
    if (settingsUi.busy === row.field) button.classList.add('is-busy');
    if (settingsUi.cursor === row.index) button.classList.add('is-cursor');

    const text = el('span', 'set__text');
    text.append(
      el('span', 'set__name', settingsRowTitle(row.field)),
      el('span', 'set__hint', settingsRowHint(row.field)),
    );

    const control = el('span', 'set__control');
    // As duas setas existem sempre no DOM; quem decide quando elas aparecem e o
    // CSS, a partir do foco e da classe da linha.
    control.append(
      el('span', 'set__arrow set__arrow--left', '←'),
      el('span', 'set__value', settingsValueText(row.field, current, settingsUi)),
      el('span', 'set__arrow set__arrow--right', '→'),
    );

    button.append(text, control);

    // O foco do DOM E o cursor, como nas faixas e na lista de episodios.
    button.addEventListener('focus', () => {
      settingsUi = { ...settingsUi, cursor: row.index };
    });
    button.addEventListener('click', () => {
      settingsUi = { ...settingsUi, cursor: row.index };
      dispatchSettings({ type: 'select' });
    });

    const item = el('li');
    item.append(button);
    list.append(item);
  }
}

/** Linha principal do bloco de estado: o que o servidor esta fazendo agora. */
function libraryStateText(status: LibraryStatus): string {
  const progress = scanProgressText(status);
  if (progress !== null) return progress;
  // A fila de quadros vem antes das outras duas porque e a unica que tem
  // progresso proprio para contar - as outras so dizem que estao rodando.
  const thumbs = thumbProgressText(status);
  if (thumbs !== null) return thumbs;
  if (status.metadata.state === 'running') return 'Buscando capas e sinopses…';
  if (status.remux.state === 'running') return 'Convertendo arquivos em segundo plano…';
  return 'Nenhuma tarefa em andamento.';
}

function renderLibraryStatus(): void {
  const tmdb = settings?.tmdbConfigured;
  dom.scanTmdb.textContent =
    tmdb === undefined
      ? ''
      : tmdb
        ? 'TMDB configurado: as capas e as sinopses vêm do provedor.'
        : 'Sem chave do TMDB no servidor: as capas ficam limitadas ao que a pasta já tem.';
  dom.scanTmdb.hidden = tmdb === undefined;

  const status = library;
  if (status === null) {
    dom.scanTitle.textContent = 'Biblioteca';
    dom.scanPct.hidden = true;
    dom.scanBar.hidden = true;
    dom.scanState.textContent = 'Consultando o servidor…';
    dom.scanSummary.hidden = true;
    dom.scanMetadata.hidden = true;
    dom.scanThumbs.hidden = true;
    return;
  }

  const scanning = status.scan.state === 'running';
  dom.scanTitle.textContent = scanning
    ? 'Varredura em andamento'
    : thumbsRunning(status)
      ? 'Miniaturas em andamento'
      : 'Biblioteca';

  // Uma barra so para as duas filas: elas nao rodam ao mesmo tempo, e a
  // varredura manda quando roda - e ela quem descobre os arquivos que a fila de
  // quadros vai processar depois.
  const ratio = scanProgressRatio(status) ?? thumbProgressRatio(status);
  // Sem fracao para medir, a barra e o percentual somem em vez de fingir 0%.
  dom.scanPct.hidden = ratio === null;
  dom.scanBar.hidden = ratio === null;
  if (ratio !== null) {
    dom.scanPct.textContent = `${Math.round(ratio * 100)}%`;
    dom.scanFill.style.width = percent(ratio);
  }

  dom.scanState.textContent = libraryStateText(status);

  const scan = scanSummaryText(status);
  dom.scanSummary.textContent = scan ?? '';
  dom.scanSummary.hidden = scan === null;

  const metadata = metadataSummaryText(status);
  dom.scanMetadata.textContent = metadata ?? '';
  dom.scanMetadata.hidden = metadata === null;

  const thumbs = thumbSummaryText(status);
  dom.scanThumbs.textContent = thumbs ?? '';
  dom.scanThumbs.hidden = thumbs === null;
}

function dispatchSettings(event: SettingsEvent): void {
  const current = settings;
  if (current === null) return;

  const result = reduceSettings(settingsUi, event, {
    settings: current,
    // As duas linhas de idioma andam pela mesma lista de valores; o rotulo do
    // `null` e que muda, e quem desenha resolve isso.
    languages: audioLanguageOptions(),
  });
  settingsUi = result.state;
  if (result.command !== null) runSettingsCommand(result.command);

  renderSettings();
  focusRow(settingsRowNodes()[settingsUi.cursor]);
}

function runSettingsCommand(command: Exclude<SettingsCommand, null>): void {
  switch (command.type) {
    case 'patch':
      void savePreference(command.patch);
      return;
    case 'scan':
      void runLibraryTask(
        startScan(command.mode),
        command.mode === 'full' ? 'Reanálise iniciada.' : 'Varredura iniciada.',
      );
      return;
    case 'refreshMetadata':
      void runLibraryTask(refreshMetadata(command.reset), 'Busca de capas iniciada.');
      return;
    case 'generateThumbs':
      void runLibraryTask(startThumbs(command.reset), 'Geração de miniaturas iniciada.');
      return;
  }
}

/**
 * PATCH de um campo so, otimista: a linha muda na hora e o servidor confirma.
 * Quando ele recusa, o valor volta ao que era - uma tela que continua mostrando
 * a escolha que nao foi gravada mente para quem esta olhando.
 */
async function savePreference(patch: SettingsPatch): Promise<void> {
  const before = settings;
  if (before === null) return;

  const mine = ++settingsPatch;
  adoptSettings({ ...before, ...patch });
  renderSettings();

  try {
    const next = await patchSettings(patch);
    // Resposta de um PATCH que outra seta ja atropelou: aplicar agora devolveria
    // um valor velho para a tela.
    if (mine !== settingsPatch) return;
    adoptSettings(next);
  } catch (error) {
    if (expiredSession(error)) return;
    if (mine !== settingsPatch) return;
    adoptSettings(before);
    settingsUi = { ...settingsUi, message: 'O servidor não aceitou a mudança.' };
  }

  if (screen.name === 'settings') renderSettings();
}

/**
 * Grava a escolha feita no painel do player, sem segurar quem esta assistindo.
 * Falhar aqui nao vira recado na tela: a trilha ja trocou, e o que se perde e
 * so a memoria dela no proximo aparelho.
 */
function rememberPreference(patch: SettingsPatch): void {
  void patchSettings(patch)
    .then((next) => {
      settings = next;
    })
    .catch(() => undefined);
}

/**
 * Dispara uma tarefa de fundo e conta o que o servidor respondeu. 409 nao e
 * falha: e "ja esta rodando", e a barra de progresso vai mostrar o resto.
 */
async function runLibraryTask(request: Promise<TaskAccepted>, started: string): Promise<void> {
  try {
    const result = await request;
    settingsUi = {
      ...settingsUi,
      busy: null,
      message: result.started ? started : (result.reason ?? 'Já está em andamento.'),
    };
  } catch (error) {
    if (expiredSession(error)) return;
    settingsUi = { ...settingsUi, busy: null, message: 'Não foi possível iniciar a tarefa.' };
  }

  if (screen.name !== 'settings') return;
  renderSettings();
  await refreshLibrary();
}

async function refreshLibrary(): Promise<void> {
  try {
    library = await fetchLibraryStatus();
  } catch {
    return;
  }
  if (screen.name !== 'settings') return;
  renderLibraryStatus();
  pollLibraryWhileBusy();
}

function libraryBusy(): boolean {
  if (library === null) return false;
  // A fila de quadros conta: num acervo grande ela e a mais demorada de todas,
  // e sem ela aqui o polling desligaria com a barra ainda andando na tela.
  return (
    library.scan.state === 'running' ||
    library.metadata.state === 'running' ||
    thumbsRunning(library)
  );
}

/**
 * Liga o polling so enquanto ha tarefa rodando E a tela esta aberta. Chamado de
 * novo a cada resposta, e por isso ele tambem e quem DESLIGA: quando o scan
 * acaba, o proximo estado ja nao pede intervalo nenhum.
 */
function pollLibraryWhileBusy(): void {
  if (screen.name !== 'settings' || !libraryBusy()) {
    stopLibraryPolling();
    return;
  }
  if (libraryTimer !== null) return;
  libraryTimer = window.setInterval(() => void pollLibrary(), LIBRARY_POLL_MS);
}

function stopLibraryPolling(): void {
  if (libraryTimer !== null) window.clearInterval(libraryTimer);
  libraryTimer = null;
  libraryFails = 0;
}

async function pollLibrary(): Promise<void> {
  if (screen.name !== 'settings') {
    stopLibraryPolling();
    return;
  }

  try {
    library = await fetchLibraryStatus();
    libraryFails = 0;
  } catch (error) {
    if (expiredSession(error)) return;
    // Uma falha isolada nao pode apagar o progresso da tela; teimar para sempre
    // contra um servidor fora do ar tambem nao.
    libraryFails += 1;
    if (libraryFails >= LIBRARY_FAIL_LIMIT) {
      stopLibraryPolling();
      settingsUi = { ...settingsUi, message: 'Perdi contato com o servidor.' };
      renderSettings();
    }
    return;
  }

  if (screen.name !== 'settings') {
    stopLibraryPolling();
    return;
  }
  renderLibraryStatus();
  pollLibraryWhileBusy();
}

/* --- 5. player ------------------------------------------------------------ */

/**
 * Abre um episodio pelo id.
 *
 * @param startMs  posicao ja conhecida por quem chamou; null deixa o historico
 *                 local decidir. A faixa "Continuar assistindo" passa a posicao
 *                 do proprio `ResumeEntry`: ela vem `no-store` do servidor e e
 *                 mais nova que o mapa de `GET /api/history`, que so e rebuscado
 *                 ao entrar numa serie. Sem isto, o card desenhava "faltam 4
 *                 min" e o player abria em 5:00.
 */
function watchEpisodeId(
  channelNumber: number,
  episodeId: string,
  startMs: number | null = null,
): void {
  vodIntent = { episodeId, index: 0, startMs };
  go({ type: 'watch', source: 'vod', channel: channelNumber });
}

/** "Do inicio": o primeiro episodio, ignorando a retomada gravada. */
function watchFromStart(channelNumber: number): void {
  vodIntent = { episodeId: null, index: 0, startMs: 0 };
  go({ type: 'watch', source: 'vod', channel: channelNumber });
}

async function openPlayer(target: Extract<Screen, { name: 'player' }>): Promise<void> {
  if (target.source === 'live') {
    endVod();
    // Zap: o <track> pendurado ainda e o do canal anterior e recarregaria junto
    // com o proximo `load()`.
    clearSubtitles(currentVideo());
    const ok = await live.tune(target.channel);
    if (!ok) notice('Sem sinal');
    return;
  }

  // Tocar direto do catalogo (hero, faixa de retomada) chega aqui sem a lista
  // do canal em memoria: buscar aqui e o que faz esses caminhos existirem sem
  // passar pela tela da serie.
  let episodes = episodesOf(target.channel);
  if (episodes === null) {
    try {
      episodes = (await fetchEpisodes(target.channel)) ?? [];
      episodeCache.set(target.channel, episodes);
    } catch (error) {
      if (!expiredSession(error)) notice('Sem episódios');
      return;
    }
    if (screen.name !== 'player' || screen.channel !== target.channel) return;
  }

  if (episodes.length === 0) {
    notice('Sem episódios');
    return;
  }

  const wanted =
    vodIntent.episodeId === null
      ? vodIntent.index
      : episodes.findIndex((episode) => episode.id === vodIntent.episodeId);
  const index = wanted === -1 ? 0 : Math.min(Math.max(wanted, 0), episodes.length - 1);
  await startVod(episodes, index, vodIntent.startMs);
}

async function startVod(
  episodes: EpisodeRef[],
  index: number,
  startMs: number | null,
): Promise<void> {
  if (vod === null) {
    // O ao vivo devolve o <video> que estava na tela; um so elemento toca por vez.
    const video = live.stop();
    const level = live.volumeLevel;
    const wasMuted = live.isMuted;

    const player = new VodPlayer(video, {
      onEnded: () => onVodEnded(),
      onStalled: (reason) => notice(reason === 'error' ? 'Sem sinal' : 'Sinal fraco'),
      onError: (error) => failed(error),
    });
    player.setVolume(level);
    // `setVolume` zera o mudo nas duas classes de player; sem esta linha, entrar
    // no catalogo devolveria o som que o usuario tinha desligado.
    if (wasMuted !== player.isMuted) player.toggleMute();

    vod = { player, video, episodes, index, audioIndex: null };
  } else {
    vod = { ...vod, episodes, index };
  }

  // `resumed` diz que a posicao veio de uma retomada e nao de uma troca de
  // dublagem no meio - so a primeira merece o recado na tela.
  await playVod(index, startMs === null ? undefined : { startMs, resumed: startMs > 0 });
}

/** Faixa que o arquivo toca sem `?audio`: a marcada default, senao a primeira. */
function defaultAudioIndex(episode: EpisodeRef): number | null {
  const chosen = episode.audioTracks.find((track) => track.isDefault) ?? episode.audioTracks[0];
  return chosen?.index ?? null;
}

async function playVod(
  index: number,
  options?: { startMs?: number; audioIndex?: number | null; resumed?: boolean },
): Promise<void> {
  const session = vod;
  if (session === null) return;
  const episode = session.episodes[index];
  if (episode === undefined) return;

  // Sem escolha explicita, a dublagem preferida so entra direto quando a
  // variante ja existe; senao o episodio abre na default e a troca acontece
  // sozinha quando o servidor terminar - abrir um episodio nunca espera ffmpeg.
  const audioIndex = options?.audioIndex !== undefined ? options.audioIndex : null;

  vod = { ...session, index, audioIndex };
  // Antes do `play`: o <track> antigo aponta para a legenda do episodio
  // anterior e recarregaria com o `load()` do proximo.
  clearSubtitles(session.video);
  renderOverlay();
  // Emenda de maratona: mostrar o overlay diz que episodio comecou agora, sem
  // obrigar quem esta deitado no sofa a mexer no mouse para descobrir.
  poke();

  // Retomada: so quando ninguem pediu posicao (troca de dublagem no meio pede).
  const startMs = options?.startMs ?? resumeStartMs(history.get(episode.id));
  const resumed = options?.resumed ?? options?.startMs === undefined;

  // O arquivo default tambem pode responder 202: e o episodio cujo original
  // tocaria mudo e o servidor esta remuxando com prioridade. Espera com aviso
  // em vez de entregar o <video> a um erro generico de "Sem sinal".
  if (!(await waitStreamReady(episode.id, audioIndex))) return;

  const ok = await session.player.play(episode.id, { startMs, audioIndex });
  if (!ok) {
    // Autoplay bloqueado e formato inreproduzivel chegam os dois aqui como
    // `false`; so o segundo tem explicacao propria.
    const problem = playbackProblemText(episode.playback);
    notice(problem ?? 'Clique na tela para começar', { sticky: true });
    return;
  }
  if (resumed && startMs > 0) {
    notice(`Retomando de ${formatClock(startMs)}`);
  }
  applyPreferredSubtitle(episode);
  tracks = { ...tracks, audio: audioIndex ?? defaultAudioIndex(episode) };
  startProgressReporter();
  renderOverlay();
  if (tracks.open) renderTracksPanel();

  // Dublagem preferida diferente da default: troca em segundo plano.
  if (options?.audioIndex === undefined) {
    const wanted = pickPreferredAudio(episode.audioTracks, preferredAudio);
    if (wanted !== null && wanted !== defaultAudioIndex(episode)) {
      void switchVodAudio(wanted, { announce: false });
    }
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/** De quanto em quanto tempo perguntar se a variante de dublagem ficou pronta. */
const VARIANT_POLL_MS = 3_000;
const VARIANT_POLL_LIMIT = 100;

/**
 * Espera o arquivo do episodio existir no servidor.
 *
 * 202 = remux em geracao (o original tocaria mudo). O poll respeita as mesmas
 * travas da troca de dublagem: outro play, outro episodio ou outra espera no
 * meio cancelam este.
 *
 * @returns false quando quem esperava deve desistir (outro play assumiu, erro
 *          de verdade ou prazo esgotado); o proprio aviso ja foi dado aqui.
 */
async function waitStreamReady(episodeId: string, audioIndex: number | null): Promise<boolean> {
  let state = await probeStream(episodeId, audioIndex);
  // 'error' nao desiste: um HEAD bloqueado nao prova nada, e o play de verdade
  // e quem sabe mostrar 'Sem sinal'.
  if (state !== 'preparing') return true;

  const myWait = ++streamWait;
  notice('Preparando o episódio… começa sozinho', { sticky: true });
  for (let attempt = 0; attempt < VARIANT_POLL_LIMIT; attempt += 1) {
    await sleep(VARIANT_POLL_MS);
    if (streamWait !== myWait) return false;
    const current = vod;
    if (current === null || current.episodes[current.index]?.id !== episodeId) return false;

    state = await probeStream(episodeId, audioIndex);
    if (state === 'ready') {
      notice(null);
      return true;
    }
    if (state === 'error') {
      notice('Sem sinal');
      return false;
    }
  }
  notice('O episódio ainda não ficou pronto; tente de novo');
  return false;
}

/**
 * Troca a dublagem do episodio em reproducao.
 *
 * A troca e um ARQUIVO diferente (`?audio=N`): quando a variante ainda nao
 * existe, o servidor responde 202 e gera em segundo plano; aqui fica um poll
 * paciente que recarrega o video na mesma posicao quando ela chega. Trocar de
 * episodio ou escolher outra faixa no meio cancela o poll antigo.
 */
async function switchVodAudio(trackIndex: number, options: { announce: boolean }): Promise<void> {
  const session = vod;
  if (session === null) return;
  const episode = session.episodes[session.index];
  if (episode === undefined) return;

  const target = trackIndex === defaultAudioIndex(episode) ? null : trackIndex;
  if (target === session.audioIndex) return;

  const myPoll = ++variantPoll;

  const replay = async (): Promise<void> => {
    // Mesma trava de geracao do laco abaixo (e a mesma ideia de `settingsPatch`):
    // sem ela, um probe antigo que responde depois de o usuario ja ter escolhido
    // outra faixa recarregaria o video na dublagem abandonada.
    if (variantPoll !== myPoll) return;
    const current = vod;
    if (current === null || current.episodes[current.index]?.id !== episode.id) return;
    await playVod(current.index, {
      startMs: current.video.currentTime * 1000,
      audioIndex: target,
    });
  };

  // Default nao depende de variante nenhuma: troca imediata.
  if (target === null) {
    await replay();
    return;
  }

  let state = await probeStream(episode.id, target);
  if (state === 'ready') {
    await replay();
    return;
  }
  if (state === 'error') {
    notice('Não deu para trocar a dublagem');
    return;
  }

  if (options.announce) notice('Preparando a dublagem… a troca acontece sozinha', { sticky: true });
  for (let attempt = 0; attempt < VARIANT_POLL_LIMIT; attempt += 1) {
    await sleep(VARIANT_POLL_MS);
    // Poll antigo: outra escolha ou outro episodio assumiu no meio do caminho.
    if (variantPoll !== myPoll) return;
    if (vod === null || vod.episodes[vod.index]?.id !== episode.id) return;

    state = await probeStream(episode.id, target);
    if (state === 'ready') {
      if (options.announce) notice(null);
      await replay();
      return;
    }
    if (state === 'error') {
      notice('Não deu para preparar a dublagem');
      return;
    }
  }
  notice('A dublagem ainda não ficou pronta; tente de novo');
}

/* --- progresso (onde parei) ----------------------------------------------- */

/** Intervalo entre gravacoes; um tick perdido custa no maximo isto de recuo. */
const PROGRESS_INTERVAL_MS = 10_000;

/** Espelho da regra do servidor: daqui em diante a entrada e apagada. */
const FINISHED_RATIO = 0.95;

/** Grava a posicao atual do catalogo no servidor e no espelho local. */
function reportProgress(): void {
  const session = vod;
  if (session === null) return;
  const episode = session.episodes[session.index];
  if (episode === undefined) return;

  const video = session.video;
  const durationMs =
    Number.isFinite(video.duration) && video.duration > 0
      ? video.duration * 1000
      : episode.durationMs;
  const positionMs = video.currentTime * 1000;
  if (durationMs <= 0 || positionMs <= 0) return;

  saveProgress(episode.id, positionMs, durationMs);

  // Espelho local na hora: a barra da lista e a retomada nao esperam refetch.
  // A regra e a MESMA do servidor (`decideProgress`): terminar marca e zera a
  // posicao, em vez de apagar a linha — e o que deixa a lista de episodios
  // riscar o que ja passou.
  const finished = positionMs >= durationMs * FINISHED_RATIO;
  const channel = screen.name === 'player' || screen.name === 'series' ? screen.channel : 0;
  history.set(episode.id, {
    episodeId: episode.id,
    channelNumber: channel,
    positionMs: finished ? 0 : positionMs,
    durationMs,
    updatedAt: Date.now(),
    watchedAt: finished ? Date.now() : null,
  });
}

function startProgressReporter(): void {
  stopProgressReporter();
  progressTimer = window.setInterval(reportProgress, PROGRESS_INTERVAL_MS);
}

function stopProgressReporter(): void {
  if (progressTimer === null) return;
  window.clearInterval(progressTimer);
  progressTimer = null;
}

function onVodEnded(): void {
  const session = vod;
  if (session === null) return;

  // Fim de episodio apaga a retomada no servidor (posicao == duracao).
  const episode = session.episodes[session.index];
  if (episode !== undefined) {
    saveProgress(episode.id, episode.durationMs, episode.durationMs);
    history.delete(episode.id);
  }

  const decision = decideOnEnded(session.index, session.episodes.length);
  if (decision.type === 'next') {
    void playVod(decision.index);
    return;
  }
  // Serie acabou: de volta para a tela dela, que e de onde a maratona partiu.
  go({ type: 'back' });
}

function endVod(): void {
  if (vod === null) return;
  // Ultima posicao antes de largar o player: e ela que a proxima tela retoma.
  reportProgress();
  stopProgressReporter();
  const level = vod.player.volumeLevel;
  const wasMuted = vod.player.isMuted;
  clearSubtitles(vod.video);
  vod.player.stop();
  vod = null;

  // Volume mexido no catalogo continua valendo no ao vivo.
  live.setVolume(level);
  if (wasMuted !== live.isMuted) live.toggleMute();
}

function currentEpisode(): EpisodeRef | null {
  if (vod !== null) return vod.episodes[vod.index] ?? null;
  return live.nowPlaying?.episode ?? null;
}

/* --- overlay -------------------------------------------------------------- */

function stopOverlayTimer(): void {
  if (overlayTimer !== null) window.clearTimeout(overlayTimer);
  overlayTimer = null;
}

/** Marca atividade: o overlay volta e o relogio de sumir recomeca. */
function poke(): void {
  dom.overlay.hidden = false;
  dom.player.classList.remove('is-idle');
  stopOverlayTimer();
  overlayTimer = window.setTimeout(() => {
    // Fora do player o timeout nao tem tela para esconder, e reagendar aqui
    // seria o laco que `onLeave` acabou de cortar.
    if (screen.name !== 'player') return;
    // Painel aberto ou video pausado: o overlay e a unica coisa na tela dizendo
    // o que esta acontecendo, entao ele fica.
    if (tracks.open || currentVideo().paused) {
      poke();
      return;
    }
    dom.overlay.hidden = true;
    dom.player.classList.add('is-idle');
  }, OVERLAY_HOLD_MS);
}

/** true quando quem esta tocando e um episodio do catalogo, e nao a grade. */
function isVodScreen(): boolean {
  const current = screen;
  return current.name === 'player' && current.source === 'vod';
}

function renderOverlay(): void {
  const current = screen;
  if (current.name !== 'player') return;

  const isLive = current.source === 'live';
  // No ao vivo o servidor manda a serie junto do `/now`, entao ela vale mais do
  // que o catalogo em memoria: o zap mostra o canal certo antes de a lista
  // sequer ser consultada.
  const channel = (isLive ? live.nowPlaying?.channel : null) ?? channelAt(current.channel);
  const episode = currentEpisode();

  dom.liveBadge.hidden = !isLive;
  dom.channelBadge.textContent = channelLabel(channel?.number ?? current.channel);

  dom.overlayShow.textContent = channel?.name ?? '';
  dom.overlayTitle.textContent = episode === null ? 'Sintonizando…' : episodeHeadline(episode);

  dom.overlayHint.textContent = isLive
    ? '↑ ↓ trocar de canal · S áudio e legendas · M mudo · Esc voltar'
    : 'Espaço pausar · ← → 10 s · S áudio e legendas · M mudo · Esc voltar';

  // No ao vivo a grade e quem manda: o transporte mostra a posicao, mas nao
  // aceita pausa nem seek. Isto ja era a regra do app e continua sendo.
  dom.playToggle.disabled = isLive;
  dom.seekBack.disabled = isLive;
  dom.seekFwd.disabled = isLive;
  dom.scrubNote.textContent = isLive
    ? 'A grade continua correndo — voltar ao vivo é instantâneo'
    : '';

  renderUpNext(isLive);
  renderPlayIcon();
  renderScrub();
  renderVolume();
}

function renderUpNext(isLive: boolean): void {
  const next = isLive
    ? (live.nowPlaying?.next ?? null)
    : (vod === null ? null : (vod.episodes[vod.index + 1] ?? null));

  dom.upnext.hidden = next === null;
  if (next === null) return;

  dom.upnextTitle.textContent = next.title;

  // Hora de entrar no ar so existe na grade; no catalogo o proximo comeca
  // quando este acabar, e isso depende de quem esta assistindo.
  const endsAtMs = isLive ? (live.nowPlaying?.endsAtMs ?? null) : null;
  dom.upnextTime.textContent = endsAtMs === null ? '' : formatUpNext(endsAtMs - Date.now());
  dom.upnextTime.hidden = endsAtMs === null;
}

function renderPlayIcon(): void {
  const paused = currentVideo().paused;
  dom.playPause.hidden = paused;
  dom.playTri.hidden = !paused;
  dom.playToggle.setAttribute('aria-label', paused ? 'Reproduzir' : 'Pausar');
}

/** Fim do trecho ja baixado que contem a posicao atual, para o rastro do scrub. */
function bufferedEnd(video: HTMLVideoElement, position: number): number {
  const ranges = video.buffered;
  for (let i = 0; i < ranges.length; i += 1) {
    if (ranges.start(i) <= position && position <= ranges.end(i)) return ranges.end(i);
  }
  return position;
}

function renderScrub(): void {
  const current = screen;
  if (current.name !== 'player') return;

  const video = currentVideo();
  const episode = currentEpisode();
  const fallback = episode === null ? 0 : episode.durationMs / 1000;
  const duration =
    Number.isFinite(video.duration) && video.duration > 0 ? video.duration : fallback;
  const position = Math.min(Math.max(0, video.currentTime), duration > 0 ? duration : 0);
  const ratio = duration === 0 ? 0 : position / duration;

  dom.scrubFill.style.width = percent(ratio);
  dom.scrubBuffer.style.width = percent(duration === 0 ? 0 : bufferedEnd(video, position) / duration);
  dom.scrubKnob.style.left = percent(ratio);

  dom.scrubLeft.textContent = `${formatClock(position * 1000)} no episódio`;
  dom.scrubRight.textContent = formatClock(duration * 1000);
}

function renderVolume(): void {
  const audio = activeAudio();
  dom.volumeFill.style.width = percent(audio.isMuted ? 0 : audio.volumeLevel);
  dom.volumeIcon.textContent = audio.isMuted ? '✕' : '♪';
  dom.volumeIcon.classList.toggle('is-muted', audio.isMuted);
}

function seekBy(deltaMs: number): void {
  if (!isVodScreen()) return;
  const video = currentVideo();
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  const wanted = video.currentTime + deltaMs / 1000;
  video.currentTime = Math.min(Math.max(0, wanted), duration > 0 ? duration : wanted);
  renderScrub();
}

function togglePause(): void {
  // Pausa nao existe no ao vivo: a grade continua andando no servidor e o video
  // voltaria com um buraco que o loop de sincronia corrigiria com um pulo.
  if (!isVodScreen()) return;
  const video = currentVideo();
  if (video.paused) void video.play();
  else {
    video.pause();
    // Pausa e o momento classico de largar o sofa: melhor gravar agora do que
    // torcer pelo proximo tick.
    reportProgress();
  }
  renderPlayIcon();
  poke();
}

function zap(delta: number): void {
  const current = screen;
  if (current.name !== 'player' || current.source !== 'live' || channels.length === 0) return;
  const at = channels.findIndex((channel) => channel.number === current.channel);
  const next = channels[stepIndex(at, delta, channels.length)];
  if (next === undefined) return;
  go({ type: 'tuneTo', channel: next.number });
}

/* --- 6. painel de trilhas ------------------------------------------------- */

function tracksContext(): TracksContext {
  const episode = currentEpisode();
  return {
    subtitles: episode?.subtitleTracks.map((track) => track.index) ?? [],
    audios: episode?.audioTracks.map((track) => track.index) ?? [],
    // A troca de dublagem e servida pelo proprio servidor (`?audio=N`), entao
    // funciona em qualquer navegador - mas so no catalogo: o ao vivo persegue
    // a grade e nao pode parar para esperar uma variante ser gerada.
    audioSwitchable: vod !== null,
  };
}

function dispatchTracks(event: TracksEvent): void {
  const result = reduceTracks(tracks, event, tracksContext());
  tracks = result.state;

  const command = result.command;
  if (command !== null && command.type === 'subtitle') {
    const episode = currentEpisode();
    const chosen =
      command.index === null
        ? null
        : (episode?.subtitleTracks.find((track) => track.index === command.index) ?? null);
    preferredSubtitle = normalizeLang(chosen?.lang);
    if (command.remember) {
      writePreferredSubtitle(storage, preferredSubtitle);
      // Desligar a legenda tambem e escolha: vale para a casa toda.
      rememberPreference({ subtitleLang: preferredSubtitle });
    }
    if (episode !== null) applySubtitle(currentVideo(), episode, command.index);
  }
  if (command !== null && command.type === 'audio') {
    const episode = currentEpisode();
    const chosen = episode?.audioTracks.find((track) => track.index === command.index);
    // Preferencia por IDIOMA, como a legenda: o indice 1 e outra dublagem em
    // cada arquivo do acervo. Faixa sem tag nao vira preferencia - nao ha o que
    // lembrar, e apagaria a escolha anterior.
    const lang = normalizeLang(chosen?.lang);
    if (lang !== null) {
      preferredAudio = lang;
      if (command.remember) {
        writePreferredAudio(storage, lang);
        rememberPreference({ audioLang: lang });
      }
    }
    void switchVodAudio(command.index, { announce: true });
  }

  renderTracksPanel();
  poke();
}

function openTracks(): void {
  dispatchTracks({ type: 'open' });
  // Enter no painel seleciona a linha do cursor; com o foco ainda no botao que
  // abriu, ele reabriria o painel em vez disso.
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}

function closeTracks(): void {
  if (!tracks.open) return;
  dispatchTracks({ type: 'close' });
}

interface TrackRowOptions {
  label: string;
  detail: string;
  active: boolean;
  cursor: boolean;
  disabled: boolean;
  /** `padrão` na faixa marcada default; a ativa vira `Tocando`. */
  tag: string | null;
  onSelect: () => void;
}

function trackRow(options: TrackRowOptions): HTMLLIElement {
  const button = el('button', 'trk');
  button.type = 'button';
  button.disabled = options.disabled;
  if (options.active) button.classList.add('is-active');
  if (options.cursor) button.classList.add('is-cursor');

  const text = el('span', 'trk__text');
  text.append(el('span', 'trk__label', options.label), el('span', 'trk__detail', options.detail));

  button.append(el('span', 'trk__radio'), text);
  const tag = options.active ? 'Tocando' : options.tag;
  if (tag !== null) button.append(el('span', 'trk__tag', tag));

  button.addEventListener('click', options.onSelect);

  const item = el('li');
  item.append(button);
  return item;
}

function renderTracksPanel(): void {
  dom.tracksPanel.hidden = !tracks.open;
  dom.tracksVeil.hidden = !tracks.open;
  if (!tracks.open) return;

  const episode = currentEpisode();
  const context = tracksContext();
  const audios: readonly AudioTrackRef[] = episode?.audioTracks ?? [];
  const subtitles: readonly SubtitleTrackRef[] = episode?.subtitleTracks ?? [];

  dom.tracksSub.textContent = episode === null ? '' : episodeHeadline(episode);

  dom.tabAudio.classList.toggle('is-active', tracks.section === 'audio');
  dom.tabSubs.classList.toggle('is-active', tracks.section === 'subtitles');

  clear(dom.audioList);
  if (audios.length === 0) {
    dom.audioList.append(el('li', 'panel__note', 'Este episódio tem uma faixa de áudio só.'));
  }
  audios.forEach((track, row) => {
    // Sem troca de dublagem a faixa ainda e listada, mas apagada: esconder faria
    // parecer que o arquivo nao tem dublagem nenhuma.
    const active = context.audioSwitchable
      ? (tracks.audio ?? audios[0]?.index ?? -1) === track.index
      : track.isDefault;
    dom.audioList.append(
      trackRow({
        label: audioLabel(track),
        detail: trackDetail(track),
        active,
        cursor: tracks.section === 'audio' && tracks.cursor === row,
        disabled: !context.audioSwitchable,
        tag: track.isDefault ? 'padrão' : null,
        onSelect: () => selectRow('audio', row),
      }),
    );
  });
  dom.audioNote.hidden = context.audioSwitchable || audios.length === 0;

  clear(dom.subtitleList);
  dom.subtitleList.append(
    trackRow({
      label: 'Desativadas',
      detail: 'nenhuma legenda na tela',
      active: tracks.subtitle === null,
      cursor: tracks.section === 'subtitles' && tracks.cursor === 0,
      disabled: false,
      tag: null,
      onSelect: () => selectRow('subtitles', 0),
    }),
  );
  subtitles.forEach((track, row) => {
    dom.subtitleList.append(
      trackRow({
        label: subtitleLabel(track),
        detail: trackDetail(track),
        active: tracks.subtitle === track.index,
        cursor: tracks.section === 'subtitles' && tracks.cursor === row + 1,
        disabled: false,
        tag: track.isDefault ? 'padrão' : null,
        onSelect: () => selectRow('subtitles', row + 1),
      }),
    );
  });

  dom.tracksRemember.setAttribute('aria-pressed', String(tracks.remember));
  dom.rememberSwitch.classList.toggle('is-on', tracks.remember);
}

function selectRow(section: TrackSection, row: number): void {
  tracks = { ...tracks, section, cursor: row };
  dispatchTracks({ type: 'select' });
}

/**
 * As duas listas ficam sempre visiveis; a aba so leva o olho (e o cursor) ate a
 * secao. Rolar o painel e o que traduz "aba marcada" em "secao na tela".
 *
 * Rola para onde o reducer DEIXOU o cursor, e nao para onde a tecla apontou:
 * secao vazia nao recebe cursor, e rolar ate ela deixaria a marcacao numa lista
 * e a tela em outra.
 */
function switchSection(wanted: TrackSection): void {
  dispatchTracks({ type: 'section', value: wanted });
  const list = tracks.section === 'audio' ? dom.audioList : dom.subtitleList;
  list.scrollIntoView({ block: 'nearest', behavior: smooth() });
}

function scrollToSection(section: TrackSection): void {
  const list = section === 'audio' ? dom.audioList : dom.subtitleList;
  list.scrollIntoView({ block: 'nearest', behavior: smooth() });
}

/* --- legendas e audio no <video> ------------------------------------------ */

function clearSubtitles(video: HTMLVideoElement): void {
  for (const node of Array.from(video.querySelectorAll('track'))) node.remove();
  const list = video.textTracks;
  for (let i = 0; i < list.length; i += 1) {
    const track = list[i];
    if (track !== undefined) track.mode = 'disabled';
  }
}

function applySubtitle(video: HTMLVideoElement, episode: EpisodeRef, index: number | null): void {
  clearSubtitles(video);
  if (index === null) return;

  const ref = episode.subtitleTracks.find((track) => track.index === index);
  if (ref === undefined) return;

  const node = document.createElement('track');
  node.kind = 'subtitles';
  node.src = API.subtitle(episode.id, index);
  node.label = subtitleLabel(ref);
  if (ref.lang !== null) node.srclang = ref.lang;
  node.default = true;

  // Legenda em bitmap volta 415 e o `<track>` dispara `error`: melhor dizer do
  // que deixar o usuario esperando por um texto que nunca vai aparecer.
  node.addEventListener('error', () => notice('Legenda indisponível nesta faixa'));
  node.addEventListener('load', () => {
    node.track.mode = 'showing';
  });
  video.append(node);
  node.track.mode = 'showing';
}

function applyPreferredSubtitle(episode: EpisodeRef): void {
  // `subtitlesAuto` desligado: a legenda so aparece quando alguem escolhe no
  // painel. Antes de as configuracoes chegarem vale ligar - e o que o app
  // sempre fez, e a preferencia em cache ja diz qual idioma.
  const auto = settings?.subtitlesAuto ?? true;
  const index = auto ? pickPreferredSubtitle(episode.subtitleTracks, preferredSubtitle) : null;
  tracks = { ...tracks, subtitle: index };
  applySubtitle(currentVideo(), episode, index);
}

/* --- teclado -------------------------------------------------------------- */

const RAIL_KEYS: Readonly<Record<string, RailKey>> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
  Home: 'first',
  End: 'last',
};

function homeKeys(event: KeyboardEvent): void {
  // Com o foco na busca as setas movem o cursor de texto; roubar a tecla ali
  // tornaria o campo inutilizavel.
  if (document.activeElement === dom.searchInput) {
    if (event.key === 'Escape') {
      event.preventDefault();
      clearSearch();
    }
    return;
  }

  if (event.key === 'Escape') {
    if (searchQuery === '') return;
    event.preventDefault();
    clearSearch();
    return;
  }

  const key = RAIL_KEYS[event.key];
  if (key === undefined) return;
  event.preventDefault();

  const rows = homeRows();
  homeCursor = moveRail(
    homeCursor,
    key,
    rows.map((row) => row.length),
  );
  focusItem(rows, homeCursor);
  renderNav();
}

function seriesKeys(event: KeyboardEvent): void {
  if (event.key === 'Escape' || event.key === 'Backspace') {
    event.preventDefault();
    go({ type: 'back' });
    return;
  }
  const key = RAIL_KEYS[event.key];
  if (key === undefined) return;
  event.preventDefault();

  const rows = seriesRows();
  seriesCursor = moveRail(
    seriesCursor,
    key,
    rows.map((row) => row.length),
  );
  focusItem(rows, seriesCursor);
}

/**
 * Enter nao aparece aqui de proposito: as linhas sao `<button>` de verdade, e o
 * navegador ja transforma Enter em clique no que esta focado. Tratar a tecla
 * tambem faria a acao disparar duas vezes.
 */
function settingsKeys(event: KeyboardEvent): void {
  if (event.key === 'Escape' || event.key === 'Backspace') {
    event.preventDefault();
    go({ type: 'back' });
    return;
  }

  const key = RAIL_KEYS[event.key];
  if (key === undefined) return;
  // Home e End nao tem sentido numa lista de nove linhas.
  if (key === 'first' || key === 'last') return;
  event.preventDefault();
  dispatchSettings({ type: key });
}

function tracksKeys(event: KeyboardEvent): void {
  switch (event.key) {
    case 'ArrowUp':
      dispatchTracks({ type: 'up' });
      scrollToSection(tracks.section);
      return;
    case 'ArrowDown':
      dispatchTracks({ type: 'down' });
      scrollToSection(tracks.section);
      return;
    // As setas laterais sao as abas do segmented control, como no controle remoto.
    case 'ArrowLeft':
      switchSection('audio');
      return;
    case 'ArrowRight':
      switchSection('subtitles');
      return;
    case 'Enter':
      dispatchTracks({ type: 'select' });
      return;
    case 'Escape':
    case 'Backspace':
    case 's':
    case 'S':
      closeTracks();
      return;
    default:
      return;
  }
}

function playerKeys(event: KeyboardEvent): void {
  if (tracks.open) {
    event.preventDefault();
    tracksKeys(event);
    return;
  }

  switch (event.key) {
    case 'Escape':
    case 'Backspace':
      event.preventDefault();
      go({ type: 'back' });
      return;
    case ' ':
      event.preventDefault();
      togglePause();
      return;
    case 'ArrowLeft':
      event.preventDefault();
      seekBy(-SEEK_STEP_MS);
      return;
    case 'ArrowRight':
      event.preventDefault();
      seekBy(SEEK_STEP_MS);
      return;
    case 'ArrowUp':
      event.preventDefault();
      zap(1);
      return;
    case 'ArrowDown':
      event.preventDefault();
      zap(-1);
      return;
    case 's':
    case 'S':
      event.preventDefault();
      openTracks();
      return;
    case 'm':
    case 'M': {
      event.preventDefault();
      const muted = activeAudio().toggleMute();
      renderVolume();
      notice(muted ? 'Mudo' : 'Som ligado');
      return;
    }
    default:
      return;
  }
}

window.addEventListener('keydown', (event) => {
  // Atalho do navegador (recarregar, devtools) nunca e do app.
  if (event.ctrlKey || event.metaKey || event.altKey) return;

  switch (screen.name) {
    case 'home':
      homeKeys(event);
      return;
    case 'series':
      seriesKeys(event);
      return;
    case 'settings':
      settingsKeys(event);
      return;
    case 'player':
      poke();
      // Tecla e gesto valido para o navegador: destrava o som que a politica
      // de autoplay calou. Sem isto, quem so usa teclado (TV) nunca teria como
      // sair do mudo de politica - o unlock so existia no clique do mouse.
      if (isVodScreen()) vod?.player.unlock();
      else void live.unlock();
      playerKeys(event);
      return;
    default:
      // Login: o formulario cuida do Enter sozinho.
      return;
  }
});

/* --- mouse ---------------------------------------------------------------- */

dom.player.addEventListener('mousemove', () => {
  if (screen.name === 'player') poke();
});

for (const video of [dom.videoA, dom.videoB]) {
  video.addEventListener('click', () => {
    if (screen.name !== 'player') return;
    if (tracks.open) {
      closeTracks();
      return;
    }
    if (isVodScreen()) {
      // O mesmo clique que pausa tambem e o gesto que libera o som de politica.
      vod?.player.unlock();
      togglePause();
      return;
    }
    // Ao vivo: o clique e o gesto que o navegador esperava para liberar o som.
    void live.unlock();
    notice(null);
    poke();
  });

  video.addEventListener('play', () => renderPlayIcon());
  video.addEventListener('pause', () => renderPlayIcon());
}

dom.scrubBar.addEventListener('click', (event) => {
  // Ao vivo o scrub e so leitura: a grade e que manda na posicao.
  if (!isVodScreen()) return;
  const video = currentVideo();
  if (!Number.isFinite(video.duration) || video.duration <= 0) return;

  const box = dom.scrubBar.getBoundingClientRect();
  const ratio = Math.min(Math.max((event.clientX - box.left) / box.width, 0), 1);
  video.currentTime = ratio * video.duration;
  renderScrub();
  poke();
});

dom.playToggle.addEventListener('click', () => togglePause());
dom.seekBack.addEventListener('click', () => {
  seekBy(-SEEK_STEP_MS);
  poke();
});
dom.seekFwd.addEventListener('click', () => {
  seekBy(SEEK_STEP_MS);
  poke();
});

dom.volume.addEventListener('click', (event) => {
  const box = volumeTrack.getBoundingClientRect();
  if (box.width <= 0) return;
  const ratio = Math.min(Math.max((event.clientX - box.left) / box.width, 0), 1);
  activeAudio().setVolume(ratio);
  renderVolume();
  poke();
});

dom.fullscreen.addEventListener('click', () => {
  if (document.fullscreenElement !== null) {
    void document.exitFullscreen().catch(() => undefined);
    return;
  }
  void dom.player.requestFullscreen().catch(() => undefined);
});

dom.tracksOpen.addEventListener('click', () => openTracks());
dom.tracksClose.addEventListener('click', () => closeTracks());
dom.tracksVeil.addEventListener('click', () => closeTracks());
dom.tabAudio.addEventListener('click', () => switchSection('audio'));
dom.tabSubs.addEventListener('click', () => switchSection('subtitles'));
dom.tracksRemember.addEventListener('click', () => dispatchTracks({ type: 'toggleRemember' }));

dom.navHome.addEventListener('click', () => goToRail(RAIL_HERO));
dom.navLive.addEventListener('click', () => goToRail(RAIL_LIVE));
dom.navShelf.addEventListener('click', () => goToRail(RAIL_SHELF));

dom.searchInput.addEventListener('input', () => {
  searchQuery = dom.searchInput.value;
  renderShelfRail();
  homeCursor = clampRail(
    { rail: RAIL_SHELF, index: 0 },
    homeRows().map((row) => row.length),
  );
});

dom.seriesBack.addEventListener('click', () => go({ type: 'back' }));
dom.settingsBack.addEventListener('click', () => go({ type: 'back' }));
dom.openSettings.addEventListener('click', () => go({ type: 'openSettings' }));

dom.logout.addEventListener('click', () => {
  void (async () => {
    await logout();
    channelsLoaded = false;
    channels = [];
    episodeCache.clear();
    nowAll = null;
    resume = [];
    // Outra casa, outro acervo: o que estava pintado nao vale mais como cache.
    shelfPainted = null;
    resumePainted = null;
    episodesPainted = null;
    liveCards = [];
    // Outra senha pode ser outra casa: as preferencias vem de novo do servidor.
    settings = null;
    library = null;
    go({ type: 'unauthorized' });
  })();
});

dom.loginForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void (async () => {
    dom.loginError.textContent = '';
    dom.loginSubmit.disabled = true;
    try {
      if (await login(dom.loginPassword.value)) {
        dom.loginPassword.value = '';
        go({ type: 'authenticated' });
        return;
      }
      dom.loginError.textContent = 'Senha incorreta.';
    } catch {
      dom.loginError.textContent = 'Servidor fora do ar.';
    } finally {
      dom.loginSubmit.disabled = false;
    }
  })();
});

/* --- relogios ------------------------------------------------------------- */

window.setInterval(() => {
  if (screen.name !== 'player' || dom.overlay.hidden) return;
  renderScrub();
  if (screen.source === 'live') renderUpNext(true);
}, TICK_MS);

window.setInterval(() => {
  if (screen.name !== 'home') return;
  tickLiveRail();
  // A projecao local nao sabe de virada de episodio: de tempos em tempos a
  // grade inteira vem de novo do servidor, que e quem manda nela.
  const gate: PollGate = {
    lastAtMs: nowFetchedAtMs,
    inFlight: nowInFlight,
    intervalMs: NOW_REFRESH_MS,
  };
  if (shouldPoll(gate, Date.now())) void refreshNow();
}, HOME_TICK_MS);

// Aba fechada ou minimizada no meio do episodio: a ultima chance de gravar a
// posicao. `saveProgress` usa keepalive, entao o request sobrevive a pagina.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') reportProgress();
});

/* --- partida -------------------------------------------------------------- */

render();

void (async () => {
  let session = false;
  try {
    session = await hasSession();
  } catch {
    // Servidor fora do ar na abertura: a tela de senha e o lugar certo para
    // esperar, e o proprio login vai dizer o que houve na primeira tentativa.
    session = false;
  }
  go(session ? { type: 'authenticated' } : { type: 'unauthorized' });
})();
