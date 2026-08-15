import { API, type ChannelSummary, type EpisodeRef, type WatchProgress } from '@shared/api-types';

import './app.css';

import {
  UnauthorizedError,
  fetchChannels,
  fetchEpisodes,
  fetchHistory,
  hasSession,
  login,
  logout,
  probeVariant,
  saveProgress,
} from './api';
import {
  formatChannelMeta,
  formatClock,
  formatDurationMin,
  formatEpisodeLabel,
  initialsOf,
  resolutionBadge,
} from './format';
import { browserStorage, readLastChannel, writeLastChannel } from './last-channel';
import { countColumns, moveCursor, stepIndex, type NavKey } from './nav';
import { ChannelPlayer } from './player';
import { initialScreen, reduceScreen, type Screen, type ScreenEvent } from './screen';
import { progressRatio, resumeStartMs } from './resume';
import {
  audioLabel,
  initialTracks,
  pickPreferredAudio,
  pickPreferredSubtitle,
  readPreferredAudio,
  readPreferredSubtitle,
  reduceTracks,
  subtitleLabel,
  writePreferredAudio,
  writePreferredSubtitle,
  type TracksContext,
  type TracksEvent,
  type TracksState,
} from './tracks';
import { decideOnEnded } from './vod';
import { VodPlayer } from './vod-player';

/**
 * Cola entre teclado, mouse, DOM e players.
 *
 * As decisoes moram nos reducers puros - `screen.ts` (que tela), `nav.ts` (onde
 * esta o foco), `tracks.ts` (o painel de trilhas), `vod.ts` (o que vem depois do
 * episodio) e `sync.ts` (a perseguicao da grade). Este arquivo so descobre o
 * evento, entrega ao reducer e desenha o resultado. Quando bater a duvida de
 * onde por uma regra nova: se ela da para escrever sem `document`, ela nao mora
 * aqui.
 */

/** Tempo sem atividade antes de o overlay do player sumir. */
const OVERLAY_HOLD_MS = 3_000;
/** Passo do seek no catalogo. */
const SEEK_STEP_MS = 10_000;
const VOLUME_STEP = 0.1;
const NOTICE_HOLD_MS = 3_000;
/** Relogio do overlay: meio segundo e suave o bastante e nao custa nada. */
const TICK_MS = 500;

function need<T extends Element>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`elemento #${id} ausente no HTML`);
  return element as unknown as T;
}

const dom = {
  topbar: need<HTMLElement>('topbar'),
  logout: need<HTMLButtonElement>('logout'),

  login: need<HTMLElement>('screen-login'),
  loginForm: need<HTMLFormElement>('login-form'),
  loginPassword: need<HTMLInputElement>('login-password'),
  loginSubmit: need<HTMLButtonElement>('login-submit'),
  loginError: need<HTMLParagraphElement>('login-error'),

  home: need<HTMLElement>('screen-home'),
  grid: need<HTMLDivElement>('grid'),
  homeEmpty: need<HTMLDivElement>('home-empty'),
  homeEmptyTitle: need<HTMLHeadingElement>('home-empty-title'),
  homeEmptyText: need<HTMLParagraphElement>('home-empty-text'),

  series: need<HTMLElement>('screen-series'),
  seriesPoster: need<HTMLDivElement>('series-poster'),
  seriesTitle: need<HTMLHeadingElement>('series-title'),
  seriesMeta: need<HTMLParagraphElement>('series-meta'),
  seriesOverview: need<HTMLParagraphElement>('series-overview'),
  watchLive: need<HTMLButtonElement>('watch-live'),
  watchFirst: need<HTMLButtonElement>('watch-first'),
  episodeList: need<HTMLOListElement>('episode-list'),

  player: need<HTMLElement>('screen-player'),
  videoA: need<HTMLVideoElement>('video-a'),
  videoB: need<HTMLVideoElement>('video-b'),
  overlay: need<HTMLDivElement>('overlay'),
  liveBadge: need<HTMLParagraphElement>('live-badge'),
  overlayShow: need<HTMLParagraphElement>('overlay-show'),
  overlayTitle: need<HTMLParagraphElement>('overlay-title'),
  overlayHint: need<HTMLParagraphElement>('overlay-hint'),
  scrub: need<HTMLDivElement>('scrub'),
  scrubBar: need<HTMLDivElement>('scrub-bar'),
  scrubFill: need<HTMLDivElement>('scrub-fill'),
  scrubTime: need<HTMLParagraphElement>('scrub-time'),
  notice: need<HTMLParagraphElement>('player-notice'),

  tracksPanel: need<HTMLElement>('tracks-panel'),
  tracksOpen: need<HTMLButtonElement>('tracks-open'),
  tracksClose: need<HTMLButtonElement>('tracks-close'),
  subtitleList: need<HTMLUListElement>('subtitle-list'),
  audioList: need<HTMLUListElement>('audio-list'),
  audioNote: need<HTMLParagraphElement>('audio-note'),
};

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

const storage = browserStorage();

let screen: Screen = initialScreen();
let channels: ChannelSummary[] = [];
let channelsLoaded = false;
/** Catalogo por numero de canal; uma serie so e buscada uma vez por sessao. */
const episodeCache = new Map<number, EpisodeRef[]>();
let gridCursor = 0;
/** Linhas da tela da serie: 0 e "ao vivo", 1 e "do inicio", 2+ sao episodios. */
let seriesCursor = 0;
let tracks: TracksState = initialTracks();
let vod: VodSession | null = null;
/** Episodio a tocar quando a tela do player abrir com `source: 'vod'`. */
let vodIntent = 0;
let preferredSubtitle = readPreferredSubtitle(storage);
let preferredAudio = readPreferredAudio(storage);

/** Onde o usuario parou, por episodio. Vem do servidor; atualizado localmente. */
let history = new Map<string, WatchProgress>();
let progressTimer: number | null = null;
/** Invalida um poll de variante antigo quando o usuario troca de novo no meio. */
let variantPoll = 0;

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

function focusRow(row: Element | undefined): void {
  if (!(row instanceof HTMLElement)) return;
  row.focus({ preventScroll: true });
  row.scrollIntoView({ block: 'nearest', behavior: reducedMotion.matches ? 'auto' : 'smooth' });
}

/** Elemento de video que esta na tela agora - o ao vivo troca os dois na virada. */
function currentVideo(): HTMLVideoElement {
  return dom.videoA.hidden ? dom.videoB : dom.videoA;
}

/* --- players -------------------------------------------------------------- */

const live = new ChannelPlayer(dom.videoA, dom.videoB, {
  onTuned: (playing) => {
    notice(null);
    renderOverlay();
    applyPreferredSubtitle(playing.episode);
  },
  onEpisodeChange: (playing) => {
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
  onStalled: (reason) => notice(reason === 'error' ? 'Sem sinal' : 'Sinal fraco'),
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
  if (before.name !== 'player' || after.name === 'player') return;
  // Sair do player e sempre parar de tocar: som de episodio continuando por
  // baixo do catalogo seria assombracao.
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
  dom.player.hidden = screen.name !== 'player';
  dom.topbar.hidden = screen.name !== 'home' && screen.name !== 'series';
  if (screen.name === 'player') renderOverlay();
}

/* --- 2. catalogo ---------------------------------------------------------- */

function channelAt(number: number): ChannelSummary | null {
  return channels.find((channel) => channel.number === number) ?? null;
}

function episodesOf(number: number): EpisodeRef[] | null {
  return episodeCache.get(number) ?? null;
}

/** Recado no lugar do catalogo: acervo vazio e falha de rede tem o mesmo espaco. */
function homeMessage(title: string, text: string): void {
  clear(dom.grid);
  dom.homeEmptyTitle.textContent = title;
  dom.homeEmptyText.textContent = text;
  dom.homeEmpty.hidden = false;
}

async function openHome(before: Screen): Promise<void> {
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
    // Volta o foco na serie de onde o usuario saiu da ultima vez.
    const last = readLastChannel(
      storage,
      channels.map((channel) => channel.number),
    );
    if (last !== null) gridCursor = channels.findIndex((channel) => channel.number === last);
    renderGrid();
    // Historico junto do catalogo, sem segurar a grade: ele so pinta barras e
    // decide retomadas, e chega quando chegar.
    void refreshHistory();
  }

  // Voltando da serie: o foco cai no card de onde se saiu, nao no primeiro.
  if (before.name === 'series') {
    const at = channels.findIndex((channel) => channel.number === before.channel);
    if (at !== -1) gridCursor = at;
  }
  focusRow(dom.grid.children[gridCursor]);
}

function posterInto(box: HTMLElement, channel: ChannelSummary): void {
  clear(box);
  const fallback = el('div', 'poster__fallback', initialsOf(channel.name));

  if (channel.posterUrl === null) {
    box.append(fallback);
    return;
  }

  const img = el('img', 'poster__img');
  img.src = channel.posterUrl;
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  // Capa apagada do volume com a linha ainda no indice: 404 vira as iniciais em
  // vez do icone de imagem quebrada do navegador.
  img.addEventListener('error', () => {
    clear(box);
    box.append(fallback);
  });
  box.append(img);
}

function renderSkeleton(): void {
  clear(dom.grid);
  dom.homeEmpty.hidden = true;
  for (let i = 0; i < 12; i += 1) {
    const card = el('div', 'card skeleton');
    card.append(el('div', 'poster'), el('div', 'skeleton__line'), el('div', 'skeleton__line skeleton__line--short'));
    dom.grid.append(card);
  }
}

function renderGrid(): void {
  clear(dom.grid);
  dom.homeEmpty.hidden = channels.length > 0;
  if (channels.length === 0) return;

  gridCursor = Math.min(Math.max(gridCursor, 0), channels.length - 1);

  channels.forEach((channel, index) => {
    const card = el('button', 'card');
    card.type = 'button';

    const poster = el('div', 'poster');
    posterInto(poster, channel);

    card.append(
      poster,
      el('span', 'card__name', channel.name),
      el('span', 'card__meta', formatChannelMeta(channel.year, channel.episodeCount)),
    );

    // O foco do DOM E o cursor: mouse e teclado escrevem no mesmo lugar.
    card.addEventListener('focus', () => {
      gridCursor = index;
    });
    card.addEventListener('click', () => go({ type: 'openSeries', channel: channel.number }));
    dom.grid.append(card);
  });
}

/** Colunas que a grade formou agora, lidas do proprio layout. */
function gridColumns(): number {
  const tops = Array.from(dom.grid.children, (child) => (child as HTMLElement).offsetTop);
  return countColumns(tops);
}

/* --- 3. tela da serie ----------------------------------------------------- */

async function openSeries(number: number): Promise<void> {
  seriesCursor = 0;
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
        dom.episodeList.append(
          el('li', 'episode__empty', 'Não foi possível carregar os episódios.'),
        );
      }
      return;
    }
    if (screen.name !== 'series' || screen.channel !== number) return;
    renderSeries(number);
  }

  focusRow(seriesRows()[seriesCursor]);
}

function seriesRows(): HTMLElement[] {
  const episodes = Array.from(dom.episodeList.querySelectorAll<HTMLElement>('.episode'));
  return [dom.watchLive, dom.watchFirst, ...episodes];
}

function renderSeries(number: number): void {
  const channel = channelAt(number);
  if (channel === null) return;

  const episodes = episodesOf(number);
  posterInto(dom.seriesPoster, channel);
  dom.seriesTitle.textContent = channel.name;
  dom.seriesOverview.textContent = channel.overview ?? 'Sem sinopse para esta série.';

  clear(dom.seriesMeta);
  dom.seriesMeta.append(formatChannelMeta(channel.year, channel.episodeCount));
  const first = episodes?.[0];
  const badge = first === undefined ? null : resolutionBadge(first.width, first.height);
  if (badge !== null) dom.seriesMeta.append(el('span', 'badge', badge));

  dom.watchFirst.disabled = episodes === null || episodes.length === 0;

  clear(dom.episodeList);
  if (episodes === null) {
    dom.episodeList.append(el('li', 'episode__empty', 'Carregando episódios…'));
    return;
  }
  if (episodes.length === 0) {
    dom.episodeList.append(el('li', 'episode__empty', 'Nenhum episódio indexado nesta série.'));
    return;
  }

  episodes.forEach((episode, index) => {
    const row = el('button', 'episode');
    row.type = 'button';
    row.append(
      el('span', 'episode__label', formatEpisodeLabel(episode)),
      el('span', 'episode__title', episode.title),
      el('span', 'episode__duration', formatDurationMin(episode.durationMs)),
    );

    const mark = resolutionBadge(episode.width, episode.height);
    if (mark !== null) row.append(el('span', 'badge', mark));

    // Barra fina de "onde parei": so aparece em episodio comecado e nao
    // terminado - e o mapa da maratona quando a serie tem 100 episodios.
    const ratio = progressRatio(history.get(episode.id));
    if (ratio > 0) {
      const bar = el('span', 'episode__progress');
      const fill = el('span', 'episode__progress-fill');
      fill.style.width = `${(ratio * 100).toFixed(1)}%`;
      bar.append(fill);
      row.append(bar);
    }

    row.addEventListener('focus', () => {
      seriesCursor = index + 2;
    });
    row.addEventListener('click', () => watchEpisode(index));

    const item = el('li');
    item.append(row);
    dom.episodeList.append(item);
  });
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

/* --- 4. player ------------------------------------------------------------ */

function watchEpisode(index: number): void {
  vodIntent = index;
  go({ type: 'watch', source: 'vod' });
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

  const episodes = episodesOf(target.channel);
  if (episodes === null || episodes.length === 0) {
    notice('Sem episódios');
    return;
  }
  await startVod(episodes, vodIntent);
}

async function startVod(episodes: EpisodeRef[], index: number): Promise<void> {
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

  await playVod(index);
}

/** Faixa que o arquivo toca sem `?audio`: a marcada default, senao a primeira. */
function defaultAudioIndex(episode: EpisodeRef): number | null {
  const chosen = episode.audioTracks.find((track) => track.isDefault) ?? episode.audioTracks[0];
  return chosen?.index ?? null;
}

async function playVod(
  index: number,
  options?: { startMs?: number; audioIndex?: number | null },
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

  const ok = await session.player.play(episode.id, { startMs, audioIndex });
  if (!ok) {
    notice('Clique na tela para começar', { sticky: true });
    return;
  }
  if (options?.startMs === undefined && startMs > 0) {
    notice(`Retomando de ${formatClock(startMs)}`);
  }
  applyPreferredSubtitle(episode);
  tracks = { ...tracks, audio: audioIndex ?? defaultAudioIndex(episode) };
  startProgressReporter();
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

  let state = await probeVariant(episode.id, target);
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

    state = await probeVariant(episode.id, target);
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
  if (positionMs >= durationMs * FINISHED_RATIO) {
    history.delete(episode.id);
  } else {
    const channel = screen.name === 'player' || screen.name === 'series' ? screen.channel : 0;
    history.set(episode.id, {
      episodeId: episode.id,
      channelNumber: channel,
      positionMs,
      durationMs,
      updatedAt: Date.now(),
    });
  }
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

/** Marca atividade: o overlay volta e o relogio de sumir recomeca. */
function poke(): void {
  dom.overlay.hidden = false;
  dom.player.classList.remove('is-idle');
  if (overlayTimer !== null) window.clearTimeout(overlayTimer);
  overlayTimer = window.setTimeout(() => {
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
  dom.scrub.hidden = isLive;

  const label = episode === null ? '' : formatEpisodeLabel(episode);
  dom.overlayShow.textContent =
    channel === null ? '' : label === '' ? channel.name : `${channel.name} · ${label}`;
  dom.overlayTitle.textContent = episode?.title ?? 'Sintonizando…';

  dom.overlayHint.textContent = isLive
    ? '↑ ↓ trocar de série · S trilhas · M mudo · Esc voltar'
    : 'Espaço pausar · ← → 10 s · S trilhas · M mudo · Esc voltar';

  if (!isLive) renderScrub();
}

function renderScrub(): void {
  const video = currentVideo();
  const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
  const position = Math.min(video.currentTime, duration);
  const ratio = duration === 0 ? 0 : position / duration;

  dom.scrubFill.style.width = `${(ratio * 100).toFixed(2)}%`;
  dom.scrubTime.textContent = `${formatClock(position * 1000)} / ${formatClock(duration * 1000)}`;
}

/** true quando quem esta tocando e um episodio do catalogo, e nao a grade. */
function isVodScreen(): boolean {
  const current = screen;
  return current.name === 'player' && current.source === 'vod';
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

/* --- 5. painel de trilhas ------------------------------------------------- */

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
    preferredSubtitle = chosen?.lang ?? null;
    writePreferredSubtitle(storage, preferredSubtitle);
    if (episode !== null) applySubtitle(currentVideo(), episode, command.index);
  }
  if (command !== null && command.type === 'audio') {
    const episode = currentEpisode();
    const chosen = episode?.audioTracks.find((track) => track.index === command.index);
    if (chosen !== undefined) {
      // Preferencia por IDIOMA, como a legenda: o indice 1 e outra dublagem em
      // cada arquivo do acervo.
      writePreferredAudio(storage, chosen.lang);
      preferredAudio = readPreferredAudio(storage);
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

function trackRow(
  label: string,
  options: { active: boolean; cursor: boolean; disabled: boolean; onSelect: () => void },
): HTMLLIElement {
  const button = el('button', 'track');
  button.type = 'button';
  button.disabled = options.disabled;
  if (options.active) button.classList.add('is-active');
  if (options.cursor) button.classList.add('is-cursor');
  button.append(el('span', 'track__check', '✓'), el('span', 'track__label', label));
  button.addEventListener('click', options.onSelect);

  const item = el('li');
  item.append(button);
  return item;
}

function renderTracksPanel(): void {
  dom.tracksPanel.hidden = !tracks.open;
  if (!tracks.open) return;

  const episode = currentEpisode();
  const context = tracksContext();
  const subtitles = episode?.subtitleTracks ?? [];
  const audios = episode?.audioTracks ?? [];

  clear(dom.subtitleList);
  dom.subtitleList.append(
    trackRow('Desativadas', {
      active: tracks.subtitle === null,
      cursor: tracks.section === 'subtitles' && tracks.cursor === 0,
      disabled: false,
      onSelect: () => selectRow('subtitles', 0),
    }),
  );
  subtitles.forEach((track, row) => {
    dom.subtitleList.append(
      trackRow(subtitleLabel(track), {
        active: tracks.subtitle === track.index,
        cursor: tracks.section === 'subtitles' && tracks.cursor === row + 1,
        disabled: false,
        onSelect: () => selectRow('subtitles', row + 1),
      }),
    );
  });

  clear(dom.audioList);
  if (audios.length === 0) {
    dom.audioList.append(el('li', 'tracks__note', 'Este episódio tem uma faixa de áudio só.'));
  }
  audios.forEach((track, row) => {
    // Sem `video.audioTracks` a faixa ainda e listada, mas apagada: esconder
    // faria parecer que o arquivo nao tem dublagem nenhuma.
    const active = context.audioSwitchable
      ? (tracks.audio ?? audios[0]?.index ?? -1) === track.index
      : track.isDefault;
    dom.audioList.append(
      trackRow(audioLabel(track), {
        active,
        cursor: tracks.section === 'audio' && tracks.cursor === row,
        disabled: !context.audioSwitchable,
        onSelect: () => selectRow('audio', row),
      }),
    );
  });

  dom.audioNote.hidden = context.audioSwitchable || audios.length === 0;
}

function selectRow(section: 'subtitles' | 'audio', row: number): void {
  tracks = { ...tracks, section, cursor: row };
  dispatchTracks({ type: 'select' });
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
  const index = pickPreferredSubtitle(episode.subtitleTracks, preferredSubtitle);
  tracks = { ...tracks, subtitle: index };
  applySubtitle(currentVideo(), episode, index);
}

/* --- teclado -------------------------------------------------------------- */

const ARROWS: Readonly<Record<string, NavKey>> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
  Home: 'first',
  End: 'last',
};

function homeKeys(event: KeyboardEvent): void {
  const key = ARROWS[event.key];
  if (key === undefined) return;
  event.preventDefault();
  gridCursor = moveCursor(gridCursor, key, channels.length, gridColumns());
  focusRow(dom.grid.children[gridCursor]);
}

function seriesKeys(event: KeyboardEvent): void {
  if (event.key === 'Escape' || event.key === 'Backspace') {
    event.preventDefault();
    go({ type: 'back' });
    return;
  }
  const key = ARROWS[event.key];
  if (key === undefined) return;
  event.preventDefault();

  const rows = seriesRows();
  // Uma coluna: a tela da serie e uma lista, e ← → andam nela como ↑ ↓.
  seriesCursor = moveCursor(seriesCursor, key, rows.length, 1);
  focusRow(rows[seriesCursor]);
}

function tracksKeys(event: KeyboardEvent): void {
  switch (event.key) {
    case 'ArrowUp':
      dispatchTracks({ type: 'up' });
      return;
    case 'ArrowDown':
      dispatchTracks({ type: 'down' });
      return;
    case 'ArrowLeft':
      dispatchTracks({ type: 'section', value: 'subtitles' });
      return;
    case 'ArrowRight':
      dispatchTracks({ type: 'section', value: 'audio' });
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
    case 'player':
      poke();
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
      togglePause();
      return;
    }
    // Ao vivo: o clique e o gesto que o navegador esperava para liberar o som.
    void live.unlock();
    notice(null);
    poke();
  });
}

dom.scrubBar.addEventListener('click', (event) => {
  if (!isVodScreen()) return;
  const video = currentVideo();
  if (!Number.isFinite(video.duration) || video.duration <= 0) return;

  const box = dom.scrubBar.getBoundingClientRect();
  const ratio = Math.min(Math.max((event.clientX - box.left) / box.width, 0), 1);
  video.currentTime = ratio * video.duration;
  renderScrub();
  poke();
});

dom.tracksOpen.addEventListener('click', () => openTracks());
dom.tracksClose.addEventListener('click', () => closeTracks());
dom.watchLive.addEventListener('click', () => go({ type: 'watch', source: 'live' }));
dom.watchFirst.addEventListener('click', () => watchEpisode(0));
dom.watchLive.addEventListener('focus', () => {
  seriesCursor = 0;
});
dom.watchFirst.addEventListener('focus', () => {
  seriesCursor = 1;
});

dom.logout.addEventListener('click', () => {
  void (async () => {
    await logout();
    channelsLoaded = false;
    channels = [];
    episodeCache.clear();
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

/* --- relogio do overlay --------------------------------------------------- */

window.setInterval(() => {
  if (!isVodScreen() || dom.overlay.hidden) return;
  renderScrub();
}, TICK_MS);

// A grade muda de coluna quando a janela muda de tamanho; o cursor continua no
// mesmo card porque ele e um indice na lista, nao uma coordenada.
window.addEventListener('resize', () => {
  if (screen.name === 'home') focusRow(dom.grid.children[gridCursor]);
});

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
