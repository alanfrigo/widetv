/**
 * Resultado do ffprobe. Fica num arquivo separado porque `index-store.ts`
 * precisa do tipo para cachear, mas nao deve depender do modulo que executa
 * o binario.
 */
import type { AudioTrackRef, SubtitleTrackRef } from '@shared/api-types';

export interface ProbeResult {
  durationMs: number;
  videoCodec: string | null;
  audioCodec: string | null;
  width: number | null;
  height: number | null;
  /** true quando o atomo `moov` vem antes do `mdat` (seek inicial rapido). */
  faststart: boolean;
  /**
   * Audios embutidos, na ordem do container. `index` e a posicao RELATIVA
   * entre audios (0-based), nao o indice do stream no container.
   */
  audioTracks: AudioTrackRef[];
  /** Legendas embutidas. `index` relativo entre legendas: casa com `-map 0:s:N`. */
  subtitleTracks: SubtitleTrackRef[];
}
