/**
 * Motor de sincronia do canal ao vivo.
 *
 * O servidor e a unica fonte de verdade da grade. O cliente so sabe duas
 * coisas: onde o episodio estava num instante do relogio do SERVIDOR, e quanto
 * o relogio LOCAL difere daquele. Tudo aqui e funcao pura, sem DOM e sem
 * Date.now(), justamente para poder ser testado sem browser.
 */

/** Abaixo disso o desvio e inaudivel; corrigir so causaria oscilacao. */
export const DRIFT_DEADBAND_MS = 300;

/** Acima disso nao da para disfarcar mudando velocidade: pula direto. */
export const DRIFT_SEEK_MS = 2_000;

/**
 * Uma correcao em andamento so e solta quando o desvio cai abaixo disto.
 * Sem essa histerese, o desvio ficaria batendo na borda da banda morta e a
 * velocidade oscilaria audivelmente.
 */
export const DRIFT_HYSTERESIS_MS = 50;

/** 5% de desvio de velocidade. Acima disso o audio comeca a denunciar. */
export const RATE_CORRECTION = 0.05;

export interface NowSample {
  /** Relogio do servidor (epoch ms) quando ele calculou `offsetMs`. */
  serverTimeMs: number;
  /** Posicao dentro do episodio, em ms, valida em `serverTimeMs`. */
  offsetMs: number;
  durationMs: number;
  /** Relogio local ao disparar o request. */
  sentAtMs: number;
  /** Relogio local ao receber a resposta. */
  receivedAtMs: number;
}

export type CorrectionAction = 'none' | 'rate' | 'seek';

export interface Correction {
  action: CorrectionAction;
  playbackRate: number;
  driftMs: number;
}

/**
 * Quanto o relogio do servidor esta adiantado em relacao ao local.
 * Assume latencia simetrica: o carimbo do servidor vale para o meio do
 * round-trip.
 */
export function estimateSkewMs(sample: NowSample): number {
  const midpoint = sample.sentAtMs + (sample.receivedAtMs - sample.sentAtMs) / 2;
  return sample.serverTimeMs - midpoint;
}

/**
 * Onde o episodio deveria estar agora, projetando a amostra adiante.
 * Passar de `durationMs` e esperado e significativo: e o sinal de que a grade
 * ja virou para o proximo episodio.
 */
export function expectedOffsetMs(sample: NowSample, localNowMs: number): number {
  const skew = estimateSkewMs(sample);
  const serverNow = localNowMs + skew;
  return sample.offsetMs + (serverNow - sample.serverTimeMs);
}

/**
 * @param driftMs  posicao real menos posicao esperada. Negativo = video atrasado.
 * @param currentRate  velocidade aplicada agora, para saber se ja ha correcao em curso.
 */
export function decideCorrection(driftMs: number, currentRate: number): Correction {
  const magnitude = Math.abs(driftMs);

  if (magnitude > DRIFT_SEEK_MS) {
    return { action: 'seek', playbackRate: 1, driftMs };
  }

  const correcting = currentRate !== 1;
  const threshold = correcting ? DRIFT_HYSTERESIS_MS : DRIFT_DEADBAND_MS;

  if (magnitude < threshold) {
    return { action: 'none', playbackRate: 1, driftMs };
  }

  // Atrasado (drift negativo) acelera; adiantado desacelera.
  const rate = driftMs < 0 ? 1 + RATE_CORRECTION : 1 - RATE_CORRECTION;
  return { action: 'rate', playbackRate: rate, driftMs };
}
