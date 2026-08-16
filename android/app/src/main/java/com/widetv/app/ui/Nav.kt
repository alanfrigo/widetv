package com.widetv.app.ui

/**
 * Navegacao entre as cinco telas do app.
 *
 * Reducer puro, no espirito do `Tuner.kt`: aqui mora so a regra de para onde
 * cada evento leva. Quem pinta a tela, busca no servidor e move o foco e a
 * Activity — sao mundo, nao decisao, e trazer qualquer um deles para dentro
 * tornaria isto intestavel sem Android.
 *
 * A pilha e sintetica e rasa: ACERVO → SERIE → PLAYER, com os atalhos
 * ACERVO → PLAYER e ACERVO → CONFIGURACOES. O unico historico guardado e
 * `cameFrom`: VOLTAR do player refaz o caminho de quem o abriu, e nao ha
 * caminho alternativo para nenhuma das outras telas.
 *
 * As configuracoes ficam FORA dessa pilha: penduradas no acervo, com um degrau
 * so. Quem entra la nao esta a caminho de assistir nada, e empilhar a tela por
 * cima da serie ou do player daria um VOLTAR que ninguem consegue prever.
 */

/** Janela do duplo-VOLTAR no acervo: o segundo toque dentro dela sai do app. */
const val EXIT_CONFIRM_WINDOW_MS = 2_000L

enum class ScreenId {
  /** Portao de acesso. So aparece quando nao ha sessao valida. */
  GATE,

  /** Grade de capas. E a casa: sair do app e daqui, com confirmacao. */
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
   * Zapear ao vivo muda este numero sem mudar de tela — quando o player veio da
   * serie, VOLTAR cai na serie que esta tocando agora, e nao na que o abriu.
   */
  val channelNumber: Int? = null,
  /**
   * Quem abriu o player (ACERVO ou SERIE). VOLTAR do player refaz esse caminho:
   * quem entrou pelo hero do acervo nao merece cair numa tela de serie que
   * nunca viu. Zapear preserva o valor — trocar de canal nao muda a origem.
   */
  val cameFrom: ScreenId = ScreenId.SERIES,
  /**
   * Momento do primeiro VOLTAR no acervo; null quando nada esta armado. O
   * segundo VOLTAR dentro de [EXIT_CONFIRM_WINDOW_MS] sai do app de verdade.
   */
  val exitArmedAtMs: Long? = null,
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

  /**
   * Tecla VOLTAR, com o relogio de quem chamou: o reducer nao le hora nenhuma,
   * e a janela do duplo-VOLTAR vira aritmetica testavel.
   */
  data class Back(val atMs: Long) : NavEvent
}

data class NavResult(
  val state: NavState,
  /** true quando VOLTAR nao tem para onde ir e o app deve fechar. */
  val exit: Boolean = false,
  /**
   * true quando o VOLTAR armou a saida e a Activity deve avisar ("toque de
   * novo para sair"). Nunca vem junto com [exit].
   */
  val confirmExit: Boolean = false,
)

/**
 * O que um VOLTAR consome dentro do player, na ordem: painel de trilhas aberto,
 * digitacao de canal pendente, cursor aceso na fileira de acoes, overlay/OSD
 * visivel e, por fim, a navegacao.
 */
enum class BackLayer { CLOSE_PANEL, CLEAR_TUNER, CLEAR_RAIL, HIDE_OVERLAY, NAVIGATE }

/**
 * Hierarquia pura do VOLTAR no player: cada camada aberta engole a tecla antes
 * de deixar a navegacao andar. A Activity so descreve o que esta na tela.
 *
 * O cursor da fileira entra ANTES do overlay porque ele e uma camada de escolha
 * por cima da informacao: quem abriu o menu e desistiu quer o video de volta com
 * a barra ainda na tela, e nao a tela toda limpa de uma vez.
 */
fun backLayer(
  panelOpen: Boolean,
  typingChannel: Boolean,
  railCursorOn: Boolean,
  overlayVisible: Boolean,
): BackLayer = when {
  panelOpen -> BackLayer.CLOSE_PANEL
  typingChannel -> BackLayer.CLEAR_TUNER
  railCursorOn -> BackLayer.CLEAR_RAIL
  overlayVisible -> BackLayer.HIDE_OVERLAY
  else -> BackLayer.NAVIGATE
}

/**
 * Snapshot da navegacao para sobreviver a recriacao da Activity (rotacao,
 * processo morto em segundo plano). Guarda so o que se restaura: tela, canal e
 * origem do player. O relogio do duplo-VOLTAR fica de fora — uma confirmacao
 * armada nao deve atravessar uma recriacao.
 */
fun packNav(state: NavState): String =
  listOf(state.screen.name, state.channelNumber?.toString() ?: "", state.cameFrom.name)
    .joinToString("|")

/**
 * Desfaz o [packNav], ja rebaixado para uma tela que faz sentido reabrir:
 *
 * - PLAYER nao retoma — a grade andou e a posicao sob demanda se perdeu — e cai
 *   para quem o abriu (`cameFrom`), como o proprio VOLTAR faria;
 * - SERIES mantem o canal; as demais telas nao tem canal a manter.
 *
 * Snapshot ilegivel (de uma versao antiga do app, por exemplo) devolve null: a
 * abertura padrao no acervo e melhor que adivinhar uma tela.
 */
fun unpackNav(packed: String?): NavState? {
  val parts = packed?.split("|") ?: return null
  if (parts.size != 3) return null
  val screen = runCatching { ScreenId.valueOf(parts[0]) }.getOrNull() ?: return null
  val cameFrom = runCatching { ScreenId.valueOf(parts[2]) }.getOrNull() ?: return null
  val restored = if (screen == ScreenId.PLAYER) cameFrom else screen
  val channel = if (restored == ScreenId.SERIES) parts[1].toIntOrNull() else null
  return NavState(restored, channel, cameFrom)
}

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

  // O acervo tambem abre o player direto: o hero tem "Entrar no canal" e a faixa
  // "No ar agora" existe justamente para entrar sem passar pela serie. VOLTAR
  // refaz o caminho: `cameFrom` grava quem abriu, e e para la que a tecla leva.
  is NavEvent.OpenPlayer ->
    if (state.screen == ScreenId.SERIES || state.screen == ScreenId.HOME) {
      NavResult(NavState(ScreenId.PLAYER, event.channelNumber, cameFrom = state.screen))
    } else {
      NavResult(state)
    }

  // Sem sessao nao ha configuracoes: elas moram no servidor, e a tela abriria
  // vazia so para dizer que nao conseguiu ler nada.
  NavEvent.OpenSettings ->
    if (state.screen == ScreenId.GATE) NavResult(state)
    else NavResult(NavState(ScreenId.SETTINGS))

  // `copy` de proposito: zapear troca o canal e nada mais — a origem gravada em
  // `cameFrom` sobrevive ao zap.
  is NavEvent.LiveTuned ->
    if (state.screen == ScreenId.PLAYER) NavResult(state.copy(channelNumber = event.channelNumber))
    else NavResult(state)

  is NavEvent.Back -> when (state.screen) {
    // O portao nao tem degrau abaixo: sem senha nao ha app, e nao ha o que
    // confirmar.
    ScreenId.GATE -> NavResult(state, exit = true)

    // Duplo-VOLTAR para sair: o primeiro toque (ou um toque com a janela ja
    // vencida) arma o relogio e pede confirmacao; o segundo, dentro da janela,
    // fecha o app.
    ScreenId.HOME -> {
      val armedAt = state.exitArmedAtMs
      if (armedAt != null && event.atMs - armedAt <= EXIT_CONFIRM_WINDOW_MS) {
        NavResult(state, exit = true)
      } else {
        NavResult(state.copy(exitArmedAtMs = event.atMs), confirmExit = true)
      }
    }

    ScreenId.SERIES -> NavResult(NavState(ScreenId.HOME))

    // Retrace: volta para quem abriu o player. Vindo da serie, o canal atual
    // (ja zapeado ou nao) segue junto; vindo do acervo, nao ha serie a mostrar.
    ScreenId.PLAYER -> NavResult(
      NavState(
        state.cameFrom,
        channelNumber = if (state.cameFrom == ScreenId.SERIES) state.channelNumber else null,
      ),
    )

    ScreenId.SETTINGS -> NavResult(NavState(ScreenId.HOME))
  }
}
