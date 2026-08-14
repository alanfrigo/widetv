package com.retrotv.app.ui

/**
 * Menu de canais e episodios, exclusivo do modo panoramico.
 *
 * Reducer puro, no espirito do `Tuner.kt`: aqui mora so a regra de qual tecla
 * vale em qual nivel. A lista de episodios, o foco da linha e a busca no
 * servidor ficam de fora — sao mundo, nao decisao, e trazer qualquer um deles
 * para dentro tornaria isto intestavel sem Android.
 */

sealed interface MenuLevel {
  /** Grade de canais, como a lista de um controle remoto antigo. */
  data object Channels : MenuLevel

  /** Catalogo de um canal so. */
  data class Episodes(val channelNumber: Int) : MenuLevel
}

data class MenuState(
  val open: Boolean = false,
  val level: MenuLevel = MenuLevel.Channels,
)

sealed interface MenuEvent {
  data object Open : MenuEvent

  /** Voltar: sobe um nivel, e no topo fecha. */
  data object Back : MenuEvent

  /** OK numa linha de canal: sintoniza ao vivo e sai da frente. */
  data class ActivateChannel(val number: Int) : MenuEvent

  /** Seta para a direita numa linha de canal: entra no catalogo dele. */
  data class DrillChannel(val number: Int) : MenuEvent

  /** OK numa linha de episodio. O indice e da lista que a Activity carregou. */
  data class ActivateEpisode(val index: Int) : MenuEvent
}

data class MenuResult(
  val state: MenuState,
  /** Canal a sintonizar ao vivo, ou null. */
  val tuneTo: Int? = null,
  /** Canal cujo catalogo precisa ser buscado, ou null. */
  val loadEpisodes: Int? = null,
  /** Indice do episodio a reproduzir sob demanda, ou null. */
  val playFrom: Int? = null,
  /** true quando o menu tem que sair da frente. */
  val close: Boolean = false,
)

/**
 * Evento que nao faz sentido no nivel atual devolve o estado intacto: a tecla
 * ja foi consumida pelo menu (que e modal), e inventar uma transicao para ela
 * seria pior do que nao fazer nada.
 */
fun reduceMenu(state: MenuState, event: MenuEvent): MenuResult =
  when (event) {
    MenuEvent.Open ->
      if (state.open) MenuResult(state)
      else MenuResult(MenuState(open = true, level = MenuLevel.Channels))

    MenuEvent.Back -> when (state.level) {
      is MenuLevel.Episodes -> MenuResult(state.copy(level = MenuLevel.Channels))
      is MenuLevel.Channels -> MenuResult(MenuState(), close = true)
    }

    is MenuEvent.ActivateChannel ->
      if (state.level is MenuLevel.Channels) MenuResult(MenuState(), tuneTo = event.number, close = true)
      else MenuResult(state)

    is MenuEvent.DrillChannel ->
      if (state.level is MenuLevel.Channels) {
        MenuResult(
          state = state.copy(level = MenuLevel.Episodes(event.number)),
          loadEpisodes = event.number,
        )
      } else {
        MenuResult(state)
      }

    is MenuEvent.ActivateEpisode ->
      if (state.level is MenuLevel.Episodes) MenuResult(MenuState(), playFrom = event.index, close = true)
      else MenuResult(state)
  }
