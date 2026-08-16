package com.widetv.app.player

/**
 * Quando gravar no servidor onde o episodio parou.
 *
 * Ate esta versao o app Android nao gravava nada: a faixa "Continuar
 * assistindo" aparecia na TV porque o cliente WEB a alimentava, e quem
 * maratonava na sala nunca voltava para onde tinha parado. A rota
 * (`PUT /api/history/:id`) sempre existiu; faltava o cliente chamar.
 *
 * A politica mora aqui, pura, porque ela e feita de aritmetica de relogio - o
 * tipo de coisa que so da para conferir de verdade num teste sem Android.
 */

/**
 * Intervalo entre gravacoes durante a reproducao.
 *
 * Mesmo valor do cliente web: um tick perdido custa no maximo dez segundos de
 * recuo na proxima abertura, e mais frequente do que isto so gastaria rede para
 * mover uma barra que ninguem esta olhando.
 */
const val PROGRESS_INTERVAL_MS = 10_000L

/**
 * Abaixo disto nao vale gravar nada: os primeiros segundos ainda sao a vinheta,
 * e uma linha de historico com dois segundos so suja a faixa de retomada com
 * episodios que ninguem chegou a assistir.
 */
const val PROGRESS_MIN_POSITION_MS = 5_000L

/** O que ja foi mandado. Comeca zerado a cada episodio. */
data class ProgressState(
  val lastSentAtMs: Long = 0L,
  /** -1 significa "nada mandado ainda"; zero e uma posicao valida. */
  val lastPositionMs: Long = -1L,
  /**
   * A pessoa marcou este episodio na mao ("Já vi" / "Não vi").
   *
   * Enquanto isto vale, a gravacao automatica CALA ate o episodio virar. Sem
   * este freio o botao nao funcionava de verdade: marcar como visto com o video
   * ainda rodando durava dez segundos, porque o proximo tique mandava uma
   * posicao no meio do episodio e o servidor entendia, corretamente, que a
   * pessoa estava assistindo de novo — desmarcando o que ela acabara de marcar.
   */
  val manual: Boolean = false,
)

/** O que o player esta mostrando agora. */
data class ProgressSnapshot(
  /** Ao vivo nao ha o que retomar: a posicao pertence a grade, nao a pessoa. */
  val live: Boolean,
  val positionMs: Long,
  val durationMs: Long,
)

data class ProgressDecision(
  val state: ProgressState,
  /** true quando a Activity deve chamar `saveProgress`. */
  val send: Boolean = false,
)

/**
 * Decide se esta gravacao sai.
 *
 * @param forced momento em que perder a posicao seria irreversivel: pausa, troca
 *   de episodio, saida do player, app indo para segundo plano. Nestes o
 *   intervalo nao vale - esperar o proximo tique pode significar nunca.
 * @return o estado novo e se manda. O estado so avanca quando manda: um tique
 *   recusado nao pode adiar o proximo.
 */
fun decideProgress(
  state: ProgressState,
  snapshot: ProgressSnapshot,
  nowMs: Long,
  forced: Boolean = false,
): ProgressDecision {
  if (snapshot.live) return ProgressDecision(state)
  // Marcacao manual manda: o botao venceu, e nada automatico a desfaz.
  if (state.manual) return ProgressDecision(state)
  if (snapshot.durationMs <= 0L) return ProgressDecision(state)
  if (snapshot.positionMs < PROGRESS_MIN_POSITION_MS) return ProgressDecision(state)

  // Mesma posicao ja mandada: o video esta pausado ou parado, e regravar o
  // mesmo numero so gastaria rede.
  if (snapshot.positionMs == state.lastPositionMs) return ProgressDecision(state)

  // A PRIMEIRA gravacao do episodio nao espera o intervalo. O relogio comeca em
  // zero, e compara-lo com o relogio de parede diria "ainda nao" para sempre;
  // alem disso e justamente ela que faz sair depois de vinte segundos deixar
  // alguma coisa gravada.
  val first = state.lastPositionMs < 0L
  if (!first && !forced && nowMs - state.lastSentAtMs < PROGRESS_INTERVAL_MS) {
    return ProgressDecision(state)
  }

  return ProgressDecision(
    ProgressState(lastSentAtMs = nowMs, lastPositionMs = snapshot.positionMs),
    send = true,
  )
}
