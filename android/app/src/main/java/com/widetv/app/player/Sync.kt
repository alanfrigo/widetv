package com.widetv.app.player

import kotlin.math.abs

/**
 * Motor de sincronia do canal ao vivo. Porte de `src/web/sync.ts`.
 *
 * O servidor e a unica fonte de verdade da grade. O cliente so sabe duas coisas:
 * onde o episodio estava num instante do relogio do SERVIDOR, e quanto o relogio
 * LOCAL difere daquele. Tudo aqui e funcao pura, sem ExoPlayer e sem relogio
 * proprio, justamente para poder ser testado na JVM.
 */

/** Abaixo disso o desvio e inaudivel; corrigir so causaria oscilacao. */
const val DRIFT_DEADBAND_MS = 300L

/** Acima disso nao da para disfarcar mudando velocidade: pula direto. */
const val DRIFT_SEEK_MS = 2_000L

/**
 * Uma correcao em andamento so e solta quando o desvio cai abaixo disto.
 * Sem essa histerese, o desvio ficaria batendo na borda da banda morta e a
 * velocidade oscilaria audivelmente.
 */
const val DRIFT_HYSTERESIS_MS = 50L

/** 5% de desvio de velocidade. Acima disso o audio comeca a denunciar. */
const val RATE_CORRECTION = 0.05f

/** Tolerancia para comparar velocidade com 1, ja que ela e float. */
private const val RATE_EPSILON = 0.001f

data class NowSample(
  /** Relogio do servidor (epoch ms) quando ele calculou `offsetMs`. */
  val serverTimeMs: Long,
  /** Posicao dentro do episodio, em ms, valida em `serverTimeMs`. */
  val offsetMs: Long,
  val durationMs: Long,
  /** Relogio local ao disparar o request. */
  val sentAtMs: Long,
  /** Relogio local ao receber a resposta. */
  val receivedAtMs: Long,
)

enum class CorrectionAction { NONE, RATE, SEEK }

data class Correction(
  val action: CorrectionAction,
  val playbackRate: Float,
  val driftMs: Long,
)

/**
 * Quanto o relogio do servidor esta adiantado em relacao ao local.
 * Assume latencia simetrica: o carimbo do servidor vale para o meio do
 * round-trip.
 */
fun estimateSkewMs(sample: NowSample): Long {
  val midpoint = sample.sentAtMs + (sample.receivedAtMs - sample.sentAtMs) / 2
  return sample.serverTimeMs - midpoint
}

/**
 * Onde o episodio deveria estar agora, projetando a amostra adiante.
 * Passar de `durationMs` e esperado e significativo: e o sinal de que a grade
 * ja virou para o proximo episodio.
 */
fun expectedOffsetMs(sample: NowSample, localNowMs: Long): Long {
  val serverNow = localNowMs + estimateSkewMs(sample)
  return sample.offsetMs + (serverNow - sample.serverTimeMs)
}

/**
 * @param driftMs posicao real menos posicao esperada. Negativo = video atrasado.
 * @param currentRate velocidade aplicada agora, para saber se ja ha correcao em curso.
 */
fun decideCorrection(driftMs: Long, currentRate: Float): Correction {
  val magnitude = abs(driftMs)

  if (magnitude > DRIFT_SEEK_MS) {
    return Correction(CorrectionAction.SEEK, 1f, driftMs)
  }

  val correcting = abs(currentRate - 1f) > RATE_EPSILON
  val threshold = if (correcting) DRIFT_HYSTERESIS_MS else DRIFT_DEADBAND_MS

  if (magnitude < threshold) {
    return Correction(CorrectionAction.NONE, 1f, driftMs)
  }

  // Atrasado (drift negativo) acelera; adiantado desacelera.
  val rate = if (driftMs < 0) 1f + RATE_CORRECTION else 1f - RATE_CORRECTION
  return Correction(CorrectionAction.RATE, rate, driftMs)
}
