package com.widetv.app.ui

/**
 * Fileira de acoes do player e o cursor que anda nela.
 *
 * Existe porque o controle da sala tem D-PAD, OK e VOLTAR — e mais nada. Antes
 * daqui, o painel de audio e legenda sob demanda so abria com `KEYCODE_MENU`, e
 * MENU e uma tecla que a maioria dos controles de Google TV nao tem: o botao
 * "Audio e legendas" estava desenhado na tela e era inalcancavel. Mudo e a troca
 * de episodio tinham o mesmo problema, escondidos em teclas de midia.
 *
 * Reducer puro, no molde do [TrackPanel]: o cursor e daqui, e nao do sistema de
 * foco do Android. Os botoes do overlay continuam `focusable="false"` — foco
 * nativo criaria um segundo cursor disputando as mesmas setas.
 *
 * ## O modelo de teclas
 *
 * O cursor comeca DESLIGADO. Com ele desligado, cada tecla faz o que sempre fez:
 *
 * | Tecla | Ao vivo | Sob demanda |
 * |---|---|---|
 * | OK | abre audio e legendas | pausa |
 * | ← → | liga o cursor na fileira | salta 10 s |
 * | ↑ ↓ | troca de canal | ↑ liga o cursor na fileira |
 *
 * Com o cursor LIGADO, ← → andam entre os botoes e OK ativa o que estiver sob
 * ele. VOLTAR desliga o cursor antes de esconder o overlay.
 *
 * A entrada na fileira muda de eixo entre os dois modos de proposito: ao vivo,
 * ↑ ↓ pertencem ao zapear e nao podem ser tomados; sob demanda, ← → pertencem ao
 * salto. Cada modo cede o eixo que sobra, e a dica do rodape ([playerHint])
 * anuncia o gesto certo em cada um — inventar um terceiro gesto igual nos dois
 * custaria o zap ou o salto, que sao o que mais se usa.
 */

/** Um botao da fileira de acoes. A ordem de [controlRail] e a que aparece. */
enum class ControlId {
  TRACKS,
  EPISODES,
  PREV,
  NEXT,
  WATCHED,
  MUTE,
}

data class PlayerControlsState(
  /** O overlay esta na tela. */
  val visible: Boolean = false,
  /** Coluna do cursor em [controlRail]; null quando o cursor esta desligado. */
  val cursor: Int? = null,
  val live: Boolean = false,
  val muted: Boolean = false,
  /** O episodio no ar ja esta marcado como visto. So muda o rotulo do botao. */
  val watched: Boolean = false,
  /** Ha episodio anterior na fila sob demanda. */
  val hasPrev: Boolean = false,
  val hasNext: Boolean = false,
)

sealed interface PlayerControlsEvent {
  /**
   * O mundo mudou (trocou de episodio, virou o mudo, sintonizou outro canal).
   * Nao mexe no cursor — so no que a fileira precisa saber para se montar.
   */
  data class Sync(
    val live: Boolean,
    val muted: Boolean,
    val watched: Boolean,
    val hasPrev: Boolean,
    val hasNext: Boolean,
  ) : PlayerControlsEvent

  data object Up : PlayerControlsEvent

  data object Down : PlayerControlsEvent

  data object Left : PlayerControlsEvent

  data object Right : PlayerControlsEvent

  data object Ok : PlayerControlsEvent

  /** VOLTAR consumiu o cursor; o overlay continua na tela. */
  data object ClearCursor : PlayerControlsEvent

  /** O overlay saiu da tela, pelo timer ou pelo VOLTAR. */
  data object Hide : PlayerControlsEvent
}

/** O que a Activity tem que executar. O reducer nao toca no ExoPlayer. */
sealed interface ControlAction {
  data object TogglePause : ControlAction

  /** -1 volta, +1 avanca. O tamanho do passo e do [Scrub], nao daqui. */
  data class Seek(val delta: Int) : ControlAction

  /** Seta lateral ao vivo com o cursor desligado: so ha o que explicar. */
  data object LiveSeekRefused : ControlAction

  data object ZapUp : ControlAction

  data object ZapDown : ControlAction

  data object OpenTracks : ControlAction

  data object OpenEpisodes : ControlAction

  data object PrevEpisode : ControlAction

  data object NextEpisode : ControlAction

  data object ToggleMute : ControlAction

  /** "Ja vi" / "Nao vi" do episodio no ar. */
  data object ToggleWatched : ControlAction
}

data class PlayerControlsResult(
  val state: PlayerControlsState,
  val action: ControlAction? = null,
)

/**
 * Botoes da fileira, na ordem em que aparecem.
 *
 * Trilhas primeiro porque e o que mais se procura — e a razao de este arquivo
 * existir. Anterior e proximo so sob demanda: ao vivo "proximo" e outro canal, e
 * isso ja mora nas setas de cima e de baixo. "Ja vi" tambem e so sob demanda: a
 * grade ao vivo segue andando sozinha, e marcar o que ela esta passando nao
 * mudaria nada do que vem depois. Mudo por ultimo, encostado no medidor de
 * volume que o overlay ja desenha naquele canto.
 */
fun controlRail(state: PlayerControlsState): List<ControlId> {
  val out = mutableListOf(ControlId.TRACKS, ControlId.EPISODES)
  if (!state.live && state.hasPrev) out += ControlId.PREV
  if (!state.live && state.hasNext) out += ControlId.NEXT
  if (!state.live) out += ControlId.WATCHED
  out += ControlId.MUTE
  return out
}

/**
 * O overlay tem que ficar parado na tela.
 *
 * Com o cursor aceso a pessoa esta escolhendo alguma coisa, e o timer de 3 s
 * apagaria o menu debaixo do dedo. Sem cursor, some como sempre somiu.
 */
fun railSticky(state: PlayerControlsState): Boolean = state.visible && state.cursor != null

/** Botao sob o cursor, ou null com o cursor desligado. */
fun focusedControl(state: PlayerControlsState): ControlId? {
  val at = state.cursor ?: return null
  return controlRail(state).getOrNull(at)
}

fun reducePlayerControls(
  state: PlayerControlsState,
  event: PlayerControlsEvent,
): PlayerControlsResult = when (event) {
  is PlayerControlsEvent.Sync -> sync(state, event)
  PlayerControlsEvent.Hide -> PlayerControlsResult(state.copy(visible = false, cursor = null))
  PlayerControlsEvent.ClearCursor -> PlayerControlsResult(state.copy(cursor = null))
  PlayerControlsEvent.Up -> up(shown(state))
  PlayerControlsEvent.Down -> down(shown(state))
  PlayerControlsEvent.Left -> sideways(shown(state), -1)
  PlayerControlsEvent.Right -> sideways(shown(state), 1)
  PlayerControlsEvent.Ok -> ok(shown(state))
}

/**
 * Qualquer tecla traz o overlay de volta — e a mesma regra do `poke()` da
 * Activity, escrita aqui para o estado do reducer nao discordar da tela.
 */
private fun shown(state: PlayerControlsState): PlayerControlsState =
  if (state.visible) state else state.copy(visible = true)

/**
 * O mundo mudou: a fileira pode ter encolhido (o ultimo episodio perde o botao
 * "proximo") e o cursor precisa continuar dentro dela. Prender na ultima coluna
 * em vez de zerar mantem a mao perto de onde estava.
 */
private fun sync(state: PlayerControlsState, event: PlayerControlsEvent.Sync): PlayerControlsResult {
  val next = state.copy(
    live = event.live,
    muted = event.muted,
    watched = event.watched,
    hasPrev = event.hasPrev,
    hasNext = event.hasNext,
  )
  val at = state.cursor ?: return PlayerControlsResult(next)
  return PlayerControlsResult(next.copy(cursor = at.coerceIn(0, controlRail(next).lastIndex)))
}

private fun up(state: PlayerControlsState): PlayerControlsResult {
  // Ao vivo o eixo vertical e do zap, com o cursor ligado ou nao: trocar de
  // canal e o gesto mais usado da tela e nao pode depender de onde o cursor
  // esta.
  if (state.live) return PlayerControlsResult(state, ControlAction.ZapUp)
  return PlayerControlsResult(state.copy(cursor = state.cursor ?: 0))
}

private fun down(state: PlayerControlsState): PlayerControlsResult {
  if (state.live) return PlayerControlsResult(state, ControlAction.ZapDown)
  // Descer da fileira devolve o player ao normal: sem cursor, ← → voltam a
  // saltar e OK volta a pausar. E o caminho de volta do menu, sem VOLTAR.
  return PlayerControlsResult(state.copy(cursor = null))
}

private fun sideways(state: PlayerControlsState, delta: Int): PlayerControlsResult {
  val at = state.cursor
  if (at != null) {
    // Borda nao da a volta, mesma regra do painel de trilhas: saltar do ultimo
    // botao para o primeiro move a mao para um lugar que ela nao pediu.
    val to = (at + delta).coerceIn(0, controlRail(state).lastIndex)
    return PlayerControlsResult(state.copy(cursor = to))
  }
  // Ao vivo a seta lateral nao tem para onde saltar — a grade nao para. Em vez
  // de morrer num aviso, ela e a porta de entrada da fileira.
  if (state.live) return PlayerControlsResult(state.copy(cursor = 0))
  return PlayerControlsResult(state, ControlAction.Seek(delta))
}

private fun ok(state: PlayerControlsState): PlayerControlsResult {
  val focused = focusedControl(state)
  if (focused == null) {
    // Cursor desligado: o OK continua fazendo o que sempre fez em cada modo.
    val action =
      if (state.live) ControlAction.OpenTracks else ControlAction.TogglePause
    return PlayerControlsResult(state, action)
  }
  val action = when (focused) {
    ControlId.TRACKS -> ControlAction.OpenTracks
    ControlId.EPISODES -> ControlAction.OpenEpisodes
    ControlId.PREV -> ControlAction.PrevEpisode
    ControlId.NEXT -> ControlAction.NextEpisode
    ControlId.WATCHED -> ControlAction.ToggleWatched
    ControlId.MUTE -> ControlAction.ToggleMute
  }
  return PlayerControlsResult(state, action)
}
