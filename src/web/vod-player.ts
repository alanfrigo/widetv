import { streamUrl } from './api';
import { awaitMediaReady, startPlayback, type ReadyOutcome } from './playback';

/**
 * Reproducao de um episodio escolhido no menu.
 *
 * Classe separada do `ChannelPlayer` de proposito: ao vivo e VOD sao dois
 * contratos diferentes - la o relogio do servidor manda e nao existe comeco, e
 * aqui o arquivo toca do zero ate o fim e quem manda e o usuario. Enfiar os dois
 * na mesma classe custaria um `if (mode)` em cada metodo e poria em risco o
 * unico caminho que ja funciona.
 *
 * O elemento <video> e emprestado do `ChannelPlayer`, que continua com os
 * listeners dele pendurados para sempre. Por isso a flag de sessao: este player
 * so age enquanto estiver ativo.
 */

/** Prazo para a metadata do arquivo chegar antes de seguir sem posicionar. */
const METADATA_TIMEOUT_MS = 8_000;

export interface VodPlayerEvents {
  /** Episodio chegou ao fim; quem decide o que vem depois e o `vod.ts`. */
  onEnded?: () => void;
  /** Metadata do arquivo nao chegou no prazo, ou o arquivo deu erro. */
  onStalled?: (reason: ReadyOutcome) => void;
  onError?: (error: unknown) => void;
}

export class VodPlayer {
  /** false depois do `stop()`: listener que sobrar nao mexe mais em nada. */
  private active = false;
  private volume = 1;
  private muted = false;
  /** Mudo imposto pela politica de autoplay, nao escolhido pelo usuario. */
  private policyMuted = false;

  private readonly handleEnded = (): void => {
    if (!this.active) return;
    this.events.onEnded?.();
  };

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly events: VodPlayerEvents = {},
  ) {
    video.addEventListener('ended', this.handleEnded);
  }

  /**
   * Toca o episodio.
   *
   * @param options.startMs     posicao inicial (retomada ou troca de dublagem
   *                            no meio). Default: 0.
   * @param options.audioIndex  faixa FONTE de dublagem; null/ausente toca a
   *                            default. Vira `?audio=N` na URL - a troca e um
   *                            arquivo diferente, nao uma faixa do mesmo.
   * @returns false quando nem mudo o navegador aceitou tocar - so um gesto do
   *          usuario resolve, e quem avisa e o chamador.
   */
  async play(
    episodeId: string,
    options?: { startMs?: number; audioIndex?: number | null },
  ): Promise<boolean> {
    try {
      this.active = true;
      this.video.src = streamUrl(episodeId, options?.audioIndex ?? null);
      this.video.load();
      // Uma troca de episodio no meio da maratona nao pode herdar a velocidade
      // que o loop de sincronia do ao vivo tenha deixado no elemento.
      this.video.playbackRate = 1;
      this.applyAudio();

      const ready = await awaitMediaReady(this.video, METADATA_TIMEOUT_MS);
      if (ready === 'ready') {
        this.video.currentTime = Math.max(0, options?.startMs ?? 0) / 1000;
      } else {
        this.events.onStalled?.(ready);
      }

      const outcome = await startPlayback(this.video, this.muted);
      this.policyMuted = outcome === 'playing-muted';
      // `startPlayback` mexe em `video.muted` direto; realinha com o estado real.
      this.applyAudio();
      return outcome !== 'blocked';
    } catch (error) {
      this.events.onError?.(error);
      return false;
    }
  }

  /** Encerra a sessao e devolve o elemento limpo para o ao vivo reassumir. */
  stop(): void {
    this.active = false;
    this.video.removeEventListener('ended', this.handleEnded);
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
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

  private applyAudio(): void {
    this.video.volume = this.volume;
    // O mudo imposto pelo navegador soma com o do usuario: aplicar so o do
    // usuario aqui desfaria o mudo de politica e o video pararia na hora.
    this.video.muted = this.muted || this.policyMuted;
  }
}
