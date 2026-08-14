import type { NowPlaying } from '@shared/api-types';

import { fetchNow, streamUrl, type TimedNow } from './api';
import { awaitMediaReady, startPlayback, type ReadyOutcome } from './playback';
import { decideCorrection, expectedOffsetMs, type NowSample } from './sync';

/**
 * Reproducao do canal ao vivo.
 *
 * O servidor manda no relogio; este modulo so persegue. Duas responsabilidades:
 * manter o video colado na posicao que a grade dita, e trocar de episodio sem
 * buraco preto usando um segundo elemento pre-carregado.
 */

/** De quanto em quanto tempo conferir o desvio. */
const SYNC_INTERVAL_MS = 1_000;

/** Antecedencia para comecar a carregar o proximo episodio. */
const PRELOAD_LEAD_MS = 15_000;

/** Reconsulta o servidor de tempos em tempos para nao acumular erro de relogio. */
const RESYNC_INTERVAL_MS = 60_000;

/** Prazo para a metadata do arquivo chegar antes de seguir sem posicionar. */
const METADATA_TIMEOUT_MS = 8_000;

export interface PlayerEvents {
  onTuned?: (playing: NowPlaying) => void;
  onEpisodeChange?: (playing: NowPlaying) => void;
  /** Chamado quando o browser recusa o autoplay e precisa de um gesto do usuario. */
  onBlocked?: () => void;
  /** Metadata do arquivo nao chegou no prazo, ou o arquivo deu erro. */
  onStalled?: (reason: ReadyOutcome) => void;
  onError?: (error: unknown) => void;
}

function toSample(timed: TimedNow): NowSample {
  return {
    serverTimeMs: timed.data.serverTimeMs,
    offsetMs: timed.data.offsetMs,
    durationMs: timed.data.episode.durationMs,
    sentAtMs: timed.sentAtMs,
    receivedAtMs: timed.receivedAtMs,
  };
}

export class ChannelPlayer {
  private active: HTMLVideoElement;
  private spare: HTMLVideoElement;
  private sample: NowSample | null = null;
  private playing: NowPlaying | null = null;
  private preloadedEpisodeId: string | null = null;
  private lastResyncMs = 0;
  private timer: number | null = null;
  private channelNumber: number | null = null;
  private volume = 1;
  private muted = false;
  /** Mudo imposto pela politica de autoplay, nao escolhido pelo usuario. */
  private policyMuted = false;
  private blocked = false;
  private advancing = false;
  /** Id do episodio carregado em `active`, para nao comparar URLs. */
  private activeEpisodeId: string | null = null;

  constructor(
    a: HTMLVideoElement,
    b: HTMLVideoElement,
    private readonly events: PlayerEvents = {},
  ) {
    this.active = a;
    this.spare = b;
    for (const video of [a, b]) {
      video.preload = 'auto';
      video.playsInline = true;
      // Controles nativos quebrariam a ilusao de TV; a grade tambem nao aceita
      // pause nem rewind.
      video.controls = false;

      // O tick de 1s ja detecta o fim pela grade, mas o arquivo pode acabar um
      // pouco antes da duracao medida. Reagir ao evento tira ate um segundo de
      // tela parada na virada.
      video.addEventListener('ended', () => {
        if (video !== this.active || this.channelNumber === null) return;
        void this.advance(this.channelNumber);
      });

      // O aviso de bloqueio e fixo na tela, entao alguem precisa apaga-lo
      // quando o video volta sozinho (aba que estava em segundo plano, rede que
      // destravou). Sem isso o usuario ve o desenho rodando com um recado
      // mandando apertar uma tecla.
      video.addEventListener('playing', () => {
        if (video !== this.active || !this.blocked) return;
        this.blocked = false;
        if (this.playing !== null) this.events.onTuned?.(this.playing);
      });
    }
    this.showOnly(this.active);
  }

  get currentChannel(): number | null {
    return this.channelNumber;
  }

  get nowPlaying(): NowPlaying | null {
    return this.playing;
  }

  async tune(channelNumber: number): Promise<boolean> {
    this.stopLoop();
    this.channelNumber = channelNumber;
    this.preloadedEpisodeId = null;

    const timed = await fetchNow(channelNumber);
    if (timed === null) return false;

    await this.load(this.active, timed);
    this.events.onTuned?.(timed.data);
    // Depois do onTuned, senao o aviso de autoplay bloqueado seria sobrescrito
    // pelo OSD do canal e o usuario ficaria olhando uma tela parada sem saber
    // que basta apertar uma tecla.
    if (this.blocked) this.events.onBlocked?.();
    this.startLoop();
    return true;
  }

  setVolume(level: number): number {
    this.volume = Math.min(1, Math.max(0, level));
    this.muted = false;
    this.applyAudio();
    return this.volume;
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    this.applyAudio();
    return this.muted;
  }

  get volumeLevel(): number {
    return this.volume;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** true enquanto o som depende de um gesto do usuario para ser liberado. */
  get audioLocked(): boolean {
    return this.policyMuted;
  }

  /**
   * Chamado no primeiro gesto real do usuario. Devolve o som que o navegador
   * negou no carregamento e, se nem a imagem tinha comecado, tenta de novo
   * ressincronizando: enquanto estava parado, a grade andou.
   */
  async unlock(): Promise<void> {
    if (this.policyMuted) {
      this.policyMuted = false;
      this.applyAudio();
    }
    if (!this.blocked && !this.active.paused) return;

    try {
      await this.active.play();
      this.blocked = false;
      if (this.channelNumber !== null) await this.resync(this.channelNumber);
    } catch (error) {
      this.events.onError?.(error);
    }
  }

  /**
   * Para o ao vivo por completo e devolve o <video> que ficou visivel, para o
   * VOD reusar.
   *
   * Zerar `channelNumber` e o que importa: e a guarda do listener de `ended`
   * (veja o construtor). Sem isso, o fim de um episodio do catalogo dispararia
   * `advance()` da grade em cima do elemento que o VodPlayer esta usando.
   */
  stop(): HTMLVideoElement {
    this.stopLoop();
    this.channelNumber = null;
    this.playing = null;
    this.sample = null;
    this.preloadedEpisodeId = null;
    this.activeEpisodeId = null;
    this.showOnly(this.active);
    for (const video of [this.active, this.spare]) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
    return this.active;
  }

  destroy(): void {
    this.stopLoop();
    for (const video of [this.active, this.spare]) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
  }

  private applyAudio(): void {
    for (const video of [this.active, this.spare]) {
      video.volume = this.volume;
      // O mudo imposto pelo navegador soma com o do usuario: aplicar so o do
      // usuario aqui desfaria o mudo de politica e o video pararia na hora.
      video.muted = this.muted || this.policyMuted;
    }
  }

  private showOnly(visible: HTMLVideoElement): void {
    for (const video of [this.active, this.spare]) {
      video.classList.toggle('is-live', video === visible);
      video.hidden = video !== visible;
    }
  }

  private async load(video: HTMLVideoElement, timed: TimedNow): Promise<void> {
    this.sample = toSample(timed);
    this.playing = timed.data;
    this.lastResyncMs = Date.now();
    this.activeEpisodeId = timed.data.episode.id;

    video.src = streamUrl(timed.data.episode.id);
    video.load();
    this.applyAudio();

    const ready = await awaitMediaReady(video, METADATA_TIMEOUT_MS);
    if (ready === 'ready') {
      // Projeta o offset ate o instante do seek: o request e o metadata custam
      // centenas de ms, e sem isso o canal ja nasce atrasado.
      video.currentTime = Math.max(0, expectedOffsetMs(this.sample, Date.now()) / 1000);
    } else {
      // Sem metadata nao da para posicionar, mas seguir em frente e melhor do
      // que parar: o `play` ainda pode pegar e o loop de sincronia corrige a
      // posicao no proximo tick.
      this.events.onStalled?.(ready);
    }

    const outcome = await startPlayback(video, this.muted);
    this.policyMuted = outcome === 'playing-muted';
    this.blocked = outcome === 'blocked';
    // `startPlayback` mexe em `video.muted` direto; realinha os dois elementos.
    this.applyAudio();
  }


  private startLoop(): void {
    this.timer = window.setInterval(() => void this.step(), SYNC_INTERVAL_MS);
  }

  private stopLoop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async step(): Promise<void> {
    const { sample, playing, channelNumber } = this;
    if (sample === null || playing === null || channelNumber === null) return;

    const now = Date.now();
    const expected = expectedOffsetMs(sample, now);

    // O fim do episodio e avaliado ANTES de qualquer guarda de pausa. Um video
    // que chega ao fim dispara `ended` e fica pausado, entao verificar pausa
    // primeiro travaria a grade para sempre exatamente na virada.
    if (expected >= sample.durationMs) {
      await this.advance(channelNumber);
      return;
    }

    if (sample.durationMs - expected <= PRELOAD_LEAD_MS) {
      this.preload(playing.next.id);
    }

    // Video parado nao se corrige com velocidade: acelerar um <video> pausado
    // so afasta mais a posicao real da grade. Espera o gesto do usuario.
    if (this.active.paused) {
      this.active.playbackRate = 1;
      return;
    }

    const correction = decideCorrection(this.active.currentTime * 1000 - expected, this.active.playbackRate);
    if (correction.action === 'seek') {
      this.active.currentTime = expected / 1000;
      this.active.playbackRate = 1;
    } else {
      this.active.playbackRate = correction.playbackRate;
    }

    if (now - this.lastResyncMs >= RESYNC_INTERVAL_MS) {
      await this.resync(channelNumber);
    }
  }

  private preload(episodeId: string): void {
    if (this.preloadedEpisodeId === episodeId) return;
    this.preloadedEpisodeId = episodeId;
    this.spare.src = streamUrl(episodeId);
    this.spare.currentTime = 0;
    this.spare.load();
  }

  /**
   * Troca para o proximo episodio. Faz a troca local primeiro para nao abrir
   * buraco na tela, e so depois confirma com o servidor.
   */
  private async advance(channelNumber: number): Promise<void> {
    // `advance` faz um round-trip; sem esta trava o tick de 1s entraria de novo
    // enquanto o anterior ainda espera o servidor, e trocaria de video duas vezes.
    if (this.advancing) return;
    this.advancing = true;

    try {
      const next = this.playing?.next;
      if (next !== undefined && this.preloadedEpisodeId === next.id) {
        const incoming = this.spare;
        this.spare = this.active;
        this.active = incoming;
        this.activeEpisodeId = next.id;
        this.showOnly(this.active);
        this.applyAudio();
        this.active.playbackRate = 1;
        void startPlayback(this.active, this.muted).then((outcome) => {
          this.policyMuted = outcome === 'playing-muted';
          this.blocked = outcome === 'blocked';
          this.applyAudio();
          if (this.blocked) this.events.onBlocked?.();
        });

        this.spare.pause();
        this.preloadedEpisodeId = null;
      }
      await this.resync(channelNumber, true);
    } finally {
      this.advancing = false;
    }
  }

  private async resync(channelNumber: number, episodeChanged = false): Promise<void> {
    try {
      const timed = await fetchNow(channelNumber);
      if (timed === null) return;

      // stop() ou um tune() no meio do round-trip: a resposta e de uma sintonia
      // que ja nao existe. Usa-la aqui carregaria o episodio errado no <video>
      // que outro dono (o VodPlayer ou o canal novo) acabou de assumir.
      if (this.channelNumber !== channelNumber) return;

      const wanted = timed.data.episode.id;
      this.sample = toSample(timed);
      this.playing = timed.data;
      this.lastResyncMs = Date.now();

      // Compara pelo id do episodio, nao por `video.src`: o elemento devolve a
      // URL ja resolvida em absoluta, entao comparar com a relativa nunca bate e
      // recarregaria o arquivo a cada resync.
      const mismatch = this.activeEpisodeId !== wanted;
      if (mismatch) {
        await this.load(this.active, timed);
      }
      if (episodeChanged || mismatch) {
        this.events.onEpisodeChange?.(timed.data);
      }
    } catch (error) {
      this.events.onError?.(error);
    }
  }
}
