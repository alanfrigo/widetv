package com.widetv.app.ui

/**
 * Navegacao entre as cinco telas do app.
 *
 * Reducer puro, no espirito do `Tuner.kt`: aqui mora so a regra de para onde
 * cada evento leva. Quem pinta a tela, busca no servidor e move o foco e a
 * Activity — sao mundo, nao decisao, e trazer qualquer um deles para dentro
 * tornaria isto intestavel sem Android.
 *
 * A pilha e rasa de proposito: ACERVO → SERIE → PLAYER, e VOLTAR desce um
 * degrau. Nao ha historico a guardar porque nao ha caminho alternativo para
 * chegar a nenhuma das telas.
 *
 * As configuracoes ficam FORA dessa pilha: penduradas no acervo, com um degrau
 * so. Quem entra la nao esta a caminho de assistir nada, e empilhar a tela por
 * cima da serie ou do player daria um VOLTAR que ninguem consegue prever.
 */

enum class ScreenId {
  /** Portao de acesso. So aparece quando nao ha sessao valida. */
  GATE,

  /** Grade de capas. E a casa: VOLTAR daqui sai do app. */
  HOME,

  /** Uma serie: sinopse, acoes e catalogo de episodios. */
  SERIES,

  /** Reproducao, ao vivo ou sob demanda. */
  PLAYER,

  /** Preferencias e manutencao da biblioteca. Pendurada no acervo. */
  SETTINGS,
}

data class NavState(
  val screen: ScreenId = ScreenId.GATE,
  /**
   * Serie aberta na tela de serie e no player; null no portao e no acervo.
   * Zapear ao vivo muda este numero sem mudar de tela — e por isso que VOLTAR
   * do player cai na serie que esta tocando agora, e nao na que abriu o player.
   */
  val channelNumber: Int? = null,
)

sealed interface NavEvent {
  /** Ha sessao valida: o acervo pode aparecer. */
  data object Authenticated : NavEvent

  /** 401 em qualquer lugar. Cai no portao venha de onde vier. */
  data object SessionLost : NavEvent

  data class OpenSeries(val channelNumber: Int) : NavEvent

  data class OpenPlayer(val channelNumber: Int) : NavEvent

  data object OpenSettings : NavEvent

  /** Zapeou ao vivo dentro do player. */
  data class LiveTuned(val channelNumber: Int) : NavEvent

  data object Back : NavEvent
}

data class NavResult(
  val state: NavState,
  /** true quando VOLTAR nao tem para onde ir e o app deve fechar. */
  val exit: Boolean = false,
)

/**
 * Evento que nao faz sentido na tela atual devolve o estado intacto. Inventar
 * uma transicao para ele seria pior do que nao fazer nada.
 */
fun reduceNav(state: NavState, event: NavEvent): NavResult = when (event) {
  NavEvent.Authenticated -> NavResult(NavState(ScreenId.HOME))

  NavEvent.SessionLost -> NavResult(NavState(ScreenId.GATE))

  is NavEvent.OpenSeries ->
    if (state.screen == ScreenId.GATE) NavResult(state)
    else NavResult(NavState(ScreenId.SERIES, event.channelNumber))

  is NavEvent.OpenPlayer ->
    if (state.screen == ScreenId.SERIES) NavResult(NavState(ScreenId.PLAYER, event.channelNumber))
    else NavResult(state)

  // Sem sessao nao ha configuracoes: elas moram no servidor, e a tela abriria
  // vazia so para dizer que nao conseguiu ler nada.
  NavEvent.OpenSettings ->
    if (state.screen == ScreenId.GATE) NavResult(state)
    else NavResult(NavState(ScreenId.SETTINGS))

  is NavEvent.LiveTuned ->
    if (state.screen == ScreenId.PLAYER) NavResult(state.copy(channelNumber = event.channelNumber))
    else NavResult(state)

  NavEvent.Back -> when (state.screen) {
    // O portao nao tem degrau abaixo: sem senha nao ha app.
    ScreenId.GATE -> NavResult(state, exit = true)
    ScreenId.HOME -> NavResult(state, exit = true)
    ScreenId.SERIES -> NavResult(NavState(ScreenId.HOME))
    ScreenId.PLAYER -> NavResult(NavState(ScreenId.SERIES, state.channelNumber))
    ScreenId.SETTINGS -> NavResult(NavState(ScreenId.HOME))
  }
}
