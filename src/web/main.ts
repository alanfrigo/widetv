import type { ChannelSummary, DisplayMode, EpisodeRef } from '@shared/api-types';

import './crt/tv.css';
import './crt/crt.css';
import './app.css';
// Por ultimo, e inerte sem `body.mode-widescreen`: e ele quem anula a geometria
// de tubo dos tres de cima.
import './widescreen.css';

import {
  UnauthorizedError,
  fetchChannels,
  fetchConfig,
  fetchEpisodes,
  hasSession,
  login,
} from './api';
import { browserStorage, readLastChannel, writeLastChannel } from './last-channel';
import {
  initialMenu,
  reduceMenu,
  type MenuCommand,
  type MenuContext,
  type MenuEvent,
  type MenuState,
} from './menu';
import { bindMenuClicks, renderMenu, type MenuRoot } from './menu-view';
import { formatTuneLine, formatVolumeBar } from './osd';
import { ChannelPlayer } from './player';
import { TUNE_COMMIT_DELAY_MS, initialTuner, reduceTuner, type TunerState } from './tuner';
import { decideOnEnded } from './vod';
import { VodPlayer } from './vod-player';

/**
 * Cola entre teclado, OSD e player.
 *
 * Toda a decisao esta em `tuner.ts`, `sync.ts`, `osd.ts`, `menu.ts` e `vod.ts`,
 * que sao puros e testados. Este arquivo so mexe no DOM.
 *
 * Sao dois modos de apresentacao, escolhidos pelo servidor em `/api/config`. O
 * modo `crt` e o que sempre existiu e passa por caminhos inalterados - inclusive
 * o teclado; o modo `widescreen` acrescenta menu e catalogo sob demanda. Na
 * duvida vale `crt`.
 */

const OSD_HOLD_MS = 3_000;
const VOLUME_STEP = 0.1;
const STATIC_MS = 320;

function need<T extends Element>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`elemento #${id} ausente no HTML`);
  return element as unknown as T;
}

const dom = {
  crt: need<HTMLDivElement>('crt'),
  screen: need<HTMLDivElement>('screen'),
  videoA: need<HTMLVideoElement>('video-a'),
  videoB: need<HTMLVideoElement>('video-b'),
  osd: need<HTMLParagraphElement>('osd'),
  static: need<HTMLDivElement>('static'),
  gate: need<HTMLDivElement>('gate'),
  gateForm: need<HTMLFormElement>('gate-form'),
  gatePassword: need<HTMLInputElement>('gate-password'),
  gateError: need<HTMLParagraphElement>('gate-error'),
  menu: need<HTMLDivElement>('menu'),
  menuTitle: need<HTMLHeadingElement>('menu-title'),
  menuList: need<HTMLUListElement>('menu-list'),
  menuHints: need<HTMLElement>('menu-hints'),
};

const menuRoot: MenuRoot = { title: dom.menuTitle, list: dom.menuList, hints: dom.menuHints };

/** Episodio do catalogo tocando agora, fora da grade ao vivo. */
type Playback =
  | { mode: 'live' }
  | { mode: 'vod'; channelIndex: number; episodes: EpisodeRef[]; index: number; player: VodPlayer };

/** Recorte comum de `ChannelPlayer` e `VodPlayer`: quem estiver no ar leva o som. */
interface AudioControl {
  readonly volumeLevel: number;
  readonly isMuted: boolean;
  setVolume(level: number): number;
  toggleMute(): boolean;
}

const storage = browserStorage();
let channels: ChannelSummary[] = [];
let tuner: TunerState = initialTuner(0);
let displayMode: DisplayMode = 'crt';
let playback: Playback = { mode: 'live' };
let menu: MenuState = initialMenu();
/** Catalogo por numero de canal. Uma serie so e buscada uma vez por sessao. */
const episodeCache = new Map<number, EpisodeRef[]>();
let osdTimer: number | null = null;
let staticTimer: number | null = null;

const player = new ChannelPlayer(dom.videoA, dom.videoB, {
  onTuned: (playing) => {
    showOsd(formatTuneLine(playing.channel, playing.episode));
    if (player.audioLocked) showOsd('SEM SOM  APERTE UMA TECLA');
  },
  onEpisodeChange: (playing) => showOsd(formatTuneLine(playing.channel, playing.episode)),
  // So aparece quando nem o video mudo foi aceito, o que e raro.
  onBlocked: () => showOsd('PRESSIONE QUALQUER TECLA', { sticky: true }),
  // O arquivo nao respondeu no prazo. Melhor dizer do que deixar tela preta
  // muda: numa TV isso e indistinguivel de app quebrado.
  onStalled: (reason) => showOsd(reason === 'error' ? 'SEM SINAL' : 'SINAL FRACO'),
  onError: (error) => {
    if (error instanceof UnauthorizedError) openGate();
  },
});

/**
 * O navegador so libera som depois de um gesto real. Qualquer coisa serve, e
 * depois disso este listener nao precisa mais existir.
 */
function unlockAudioOnce(): void {
  void player.unlock();
  for (const event of ['keydown', 'pointerdown', 'click'] as const) {
    window.removeEventListener(event, unlockAudioOnce);
  }
}

for (const event of ['keydown', 'pointerdown', 'click'] as const) {
  window.addEventListener(event, unlockAudioOnce);
}

function showOsd(text: string, options: { sticky?: boolean } = {}): void {
  dom.osd.textContent = text;
  dom.osd.classList.add('is-visible');
  if (osdTimer !== null) window.clearTimeout(osdTimer);
  if (options.sticky === true) return;
  osdTimer = window.setTimeout(() => dom.osd.classList.remove('is-visible'), OSD_HOLD_MS);
}

/** Estalo de estatica na troca de canal. Curto: e tempero, nao espera. */
function flashStatic(): void {
  // A camada de estatica e um efeito do tubo; no widescreen ela esta escondida
  // pelo .crt-off e a chamada so mexeria em classe de um elemento invisivel.
  if (displayMode !== 'crt') return;
  dom.static.classList.add('is-on');
  if (staticTimer !== null) window.clearTimeout(staticTimer);
  staticTimer = window.setTimeout(() => dom.static.classList.remove('is-on'), STATIC_MS);
}

async function tune(channelNumber: number): Promise<void> {
  // Sintonizar e sempre sair do catalogo: e o unico ponto por onde o ao vivo
  // reassume o <video>, venha a ordem do menu, das setas ou da digitacao.
  leaveVod();
  flashStatic();
  tuner = { ...tuner, current: channelNumber };
  const ok = await player.tune(channelNumber);
  if (!ok) {
    showOsd('SEM SINAL');
    return;
  }
  // So grava depois de sintonizar de verdade: guardar um canal que nao abriu
  // deixaria o proximo carregamento comecando errado.
  writeLastChannel(storage, channelNumber);
}

function channelNumbers(): number[] {
  return channels.map((c) => c.number);
}

async function applyTunerResult(result: ReturnType<typeof reduceTuner>): Promise<void> {
  tuner = result.state;
  if (result.invalid) {
    showOsd('SEM SINAL');
    return;
  }
  if (result.display !== null) {
    showOsd(`${result.display}_`);
    return;
  }
  if (result.tuneTo !== null) await tune(result.tuneTo);
}

/* --- catalogo sob demanda ------------------------------------------------ */

function episodesFor(channelIndex: number): EpisodeRef[] | null {
  const channel = channels[channelIndex];
  if (channel === undefined) return null;
  return episodeCache.get(channel.number) ?? null;
}

/** Lista do canal em que o menu entrou; null quando esta no nivel de canais. */
function drilledEpisodes(): EpisodeRef[] | null {
  return menu.drilledChannel === null ? null : episodesFor(menu.drilledChannel);
}

async function loadEpisodes(channelNumber: number): Promise<void> {
  try {
    const episodes = await fetchEpisodes(channelNumber);
    // 404 aqui e canal que sumiu num rescan: guardar lista vazia mostra o mesmo
    // recado do erro, que e a verdade do ponto de vista de quem esta olhando.
    episodeCache.set(channelNumber, episodes ?? []);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      // Sem cache: depois do login a lista precisa ser tentada de novo.
      openGate();
      return;
    }
    episodeCache.set(channelNumber, []);
  }
  renderMenuNow();
}

/* --- menu ---------------------------------------------------------------- */

function menuContext(): MenuContext {
  return { channelCount: channels.length, episodeCount: drilledEpisodes()?.length ?? 0 };
}

function currentChannelIndex(): number {
  if (playback.mode === 'vod') return playback.channelIndex;
  const at = channels.findIndex((channel) => channel.number === tuner.current);
  return at === -1 ? 0 : at;
}

function renderMenuNow(): void {
  dom.menu.hidden = !menu.open;
  if (!menu.open) return;
  renderMenu(menuRoot, menu, { channels, episodes: drilledEpisodes() });
}

function runMenuCommand(command: MenuCommand): void {
  if (command === null) return;

  switch (command.type) {
    case 'tune': {
      const channel = channels[command.channelIndex];
      if (channel === undefined) return;
      // Fluxo normal de sintonia, com estatica e memoria de ultimo canal.
      void tune(channel.number);
      return;
    }

    case 'loadEpisodes': {
      const channel = channels[command.channelIndex];
      if (channel === undefined || episodeCache.has(channel.number)) return;
      void loadEpisodes(channel.number);
      return;
    }

    case 'play': {
      const episodes = episodesFor(command.channelIndex);
      if (episodes === null) return;
      void startVod(command.channelIndex, episodes, command.episodeIndex);
      return;
    }
  }
}

function dispatchMenu(event: MenuEvent): void {
  const result = reduceMenu(menu, event, menuContext());
  menu = result.state;
  runMenuCommand(result.command);
  renderMenuNow();
}

/* --- reproducao do catalogo ---------------------------------------------- */

function activeAudio(): AudioControl {
  return playback.mode === 'vod' ? playback.player : player;
}

async function startVod(
  channelIndex: number,
  episodes: EpisodeRef[],
  index: number,
): Promise<void> {
  const channel = channels[channelIndex];
  const episode = episodes[index];
  if (channel === undefined || episode === undefined) return;

  flashStatic();

  const level = player.volumeLevel;
  const wasMuted = player.isMuted;
  const video = player.stop();

  const vod = new VodPlayer(video, {
    onEnded: () => onVodEnded(),
    onStalled: (reason) => showOsd(reason === 'error' ? 'SEM SINAL' : 'SINAL FRACO'),
    onError: (error) => {
      if (error instanceof UnauthorizedError) openGate();
    },
  });

  vod.setVolume(level);
  // `setVolume` zera o mudo (comportamento igual nas duas classes de player);
  // sem esta linha, escolher um episodio devolveria o som que o usuario tinha
  // desligado.
  if (wasMuted !== vod.isMuted) vod.toggleMute();

  playback = { mode: 'vod', channelIndex, episodes, index, player: vod };
  // As setas de canal passam a andar a partir da serie que esta na tela, nao do
  // canal que estava antes. Nao grava ultimo canal: catalogo nao e sintonia.
  tuner = { ...tuner, current: channel.number, buffer: '', lastDigitAtMs: null };

  showOsd(formatTuneLine(channel, episode));
  const ok = await vod.play(episode.id);
  if (!ok) showOsd('PRESSIONE QUALQUER TECLA', { sticky: true });
}

function onVodEnded(): void {
  const current = playback;
  if (current.mode !== 'vod') return;

  const decision = decideOnEnded(current.index, current.episodes.length);
  if (decision.type === 'backToLive') {
    exitVod();
    return;
  }

  const episode = current.episodes[decision.index];
  if (episode === undefined) {
    exitVod();
    return;
  }

  playback = { ...current, index: decision.index };
  const channel = channels[current.channelIndex];
  if (channel !== undefined) showOsd(formatTuneLine(channel, episode));
  void current.player.play(episode.id);
}

/** Encerra a sessao de catalogo sem sintonizar nada. */
function leaveVod(): void {
  const current = playback;
  if (current.mode !== 'vod') return;

  const level = current.player.volumeLevel;
  const wasMuted = current.player.isMuted;
  current.player.stop();
  playback = { mode: 'live' };

  // Volume mexido durante o catalogo continua valendo no ao vivo - o caminho de
  // volta do que `startVod` faz. `setVolume` zera o mudo do player que recebe a
  // chamada, dai a restauracao explicita logo abaixo.
  player.setVolume(level);
  if (wasMuted !== player.isMuted) player.toggleMute();
}

/** Sai do catalogo de volta para a grade ao vivo do mesmo canal. */
function exitVod(): void {
  const current = playback;
  if (current.mode !== 'vod') return;
  const channel = channels[current.channelIndex];
  // `tune` encerra o VOD; chamar `leaveVod` antes so daria tela preta a mais.
  void tune(channel?.number ?? tuner.current);
}

/* --- teclado ------------------------------------------------------------- */

/** Caminho do modo CRT, palavra por palavra como sempre foi. */
function crtKeys(event: KeyboardEvent): void {
  switch (event.key) {
    case 'ArrowUp':
    case 'ArrowDown': {
      event.preventDefault();
      const delta = event.key === 'ArrowUp' ? 1 : -1;
      void applyTunerResult(reduceTuner(tuner, { type: 'step', delta }, channelNumbers()));
      return;
    }
    case 'ArrowRight':
    case 'ArrowLeft': {
      event.preventDefault();
      const delta = event.key === 'ArrowRight' ? VOLUME_STEP : -VOLUME_STEP;
      const level = player.setVolume(player.volumeLevel + delta);
      showOsd(formatVolumeBar(level, false));
      return;
    }
    case 'm':
    case 'M': {
      event.preventDefault();
      showOsd(formatVolumeBar(player.volumeLevel, player.toggleMute()));
      return;
    }
    default:
      break;
  }

  if (/^\d$/.test(event.key)) {
    event.preventDefault();
    void applyTunerResult(
      reduceTuner(tuner, { type: 'digit', value: event.key, atMs: Date.now() }, channelNumbers()),
    );
  }
}

/**
 * Menu aberto engole o teclado inteiro: digito solto aqui significaria trocar de
 * canal por baixo de uma lista aberta, que e a pior coisa que uma TV faz.
 */
function menuKeys(event: KeyboardEvent): void {
  // Tecla com modificador e atalho do navegador (recarregar, devtools): engolir
  // isso nao protege o menu de nada e prende quem esta usando.
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  event.preventDefault();

  switch (event.key) {
    case 'ArrowUp':
      dispatchMenu({ type: 'up' });
      return;
    case 'ArrowDown':
      dispatchMenu({ type: 'down' });
      return;
    case 'ArrowRight':
      dispatchMenu({ type: 'drill' });
      return;
    case 'ArrowLeft':
    case 'Escape':
    case 'Backspace':
      dispatchMenu({ type: 'back' });
      return;
    case 'Enter':
      dispatchMenu({ type: 'select' });
      return;
    case 'm':
    case 'M': {
      // Unico controle que continua valendo: o episodio segue tocando atras.
      const audio = activeAudio();
      showOsd(formatVolumeBar(audio.volumeLevel, audio.toggleMute()));
      return;
    }
    default:
      return;
  }
}

/** Modo widescreen com o menu fechado. */
function widescreenKeys(event: KeyboardEvent): void {
  switch (event.key) {
    case 'Enter': {
      event.preventDefault();
      dispatchMenu({ type: 'open', currentChannelIndex: currentChannelIndex() });
      return;
    }
    case 'Escape': {
      event.preventDefault();
      exitVod();
      return;
    }
    case 'ArrowUp':
    case 'ArrowDown': {
      event.preventDefault();
      const delta = event.key === 'ArrowUp' ? 1 : -1;
      void applyTunerResult(reduceTuner(tuner, { type: 'step', delta }, channelNumbers()));
      return;
    }
    case 'ArrowRight':
    case 'ArrowLeft': {
      event.preventDefault();
      const audio = activeAudio();
      const delta = event.key === 'ArrowRight' ? VOLUME_STEP : -VOLUME_STEP;
      showOsd(formatVolumeBar(audio.setVolume(audio.volumeLevel + delta), false));
      return;
    }
    case 'm':
    case 'M': {
      event.preventDefault();
      const audio = activeAudio();
      showOsd(formatVolumeBar(audio.volumeLevel, audio.toggleMute()));
      return;
    }
    default:
      break;
  }

  if (/^\d$/.test(event.key)) {
    event.preventDefault();
    void applyTunerResult(
      reduceTuner(tuner, { type: 'digit', value: event.key, atMs: Date.now() }, channelNumbers()),
    );
  }
}

function onKeyDown(event: KeyboardEvent): void {
  if (!dom.gate.hidden) return;

  // O modo CRT nao passa por nenhum caminho novo: e o mesmo switch de sempre.
  if (displayMode === 'crt') {
    crtKeys(event);
    return;
  }
  if (menu.open) {
    menuKeys(event);
    return;
  }
  widescreenKeys(event);
}

function openGate(): void {
  // Menu por cima da tela de senha prenderia o usuario numa lista que nao
  // responde mais: o teclado inteiro para no gate.
  if (menu.open) dispatchMenu({ type: 'close' });
  dom.gate.hidden = false;
  dom.gatePassword.focus();
}

function applyDisplayMode(): void {
  if (displayMode !== 'widescreen') return;
  document.body.classList.add('mode-widescreen');
  // Kill-switch que ja existia em crt.css: apaga camadas, curvatura e brilho.
  dom.crt.classList.add('crt-off');
}

async function start(): Promise<void> {
  // Depois da sessao, porque /api/config fica atras do guard: perguntar antes do
  // login voltaria 401 e o modo cairia em crt.
  displayMode = await fetchConfig();
  applyDisplayMode();

  channels = await fetchChannels();
  if (channels.length === 0) {
    showOsd('SEM CANAIS', { sticky: true });
    return;
  }
  // Volta no canal onde parou. Canal salvo que sumiu do acervo cai no primeiro.
  const inicial = readLastChannel(storage, channelNumbers()) ?? channels[0]!.number;
  tuner = initialTuner(inicial);
  await tune(inicial);
}

dom.gateForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  dom.gateError.textContent = '';
  if (await login(dom.gatePassword.value)) {
    dom.gate.hidden = true;
    dom.gatePassword.value = '';
    await start();
    return;
  }
  dom.gateError.textContent = 'SENHA INCORRETA';
});

// Clique vale o mesmo que ENTER na linha em que caiu: mover o cursor primeiro
// deixa o reducer decidir se aquilo sintoniza, toca ou nao faz nada.
bindMenuClicks(dom.menuList, (index) => {
  menu =
    menu.drilledChannel === null
      ? { ...menu, channelCursor: index }
      : { ...menu, episodeCursor: index };
  dispatchMenu({ type: 'select' });
});

window.addEventListener('keydown', onKeyDown);

// O commit por tempo do sintonizador precisa de um pulso externo: o reducer e
// puro justamente para nao ter timer proprio.
window.setInterval(() => {
  if (tuner.buffer === '') return;
  void applyTunerResult(reduceTuner(tuner, { type: 'tick', atMs: Date.now() }, channelNumbers()));
}, TUNE_COMMIT_DELAY_MS / 4);

void (async () => {
  if (await hasSession()) {
    dom.gate.hidden = true;
    await start();
  } else {
    openGate();
  }
})();
