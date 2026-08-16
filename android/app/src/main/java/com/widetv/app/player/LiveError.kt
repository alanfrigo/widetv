package com.widetv.app.player

/**
 * O que fazer quando o ExoPlayer reporta erro fatal no canal ao vivo.
 *
 * Funcao pura, sem ExoPlayer, pelo mesmo motivo do Sync.kt: e na JVM que este
 * criterio precisa ser provado, nao na TV.
 */
enum class LiveErrorAction {
  /** A culpa e do `next` pre-carregado: tira so ele da fila e retoma o atual. */
  DROP_NEXT,
  /** O proprio item no ar falhou: resintoniza o canal. */
  RETUNE,
}

/**
 * A playlist ao vivo tem [atual, next], e o ExoPlayer prepara o `next`
 * antecipadamente - uma falha DELE (ex.: stream respondendo 202 "preparando",
 * cujo JSON morre no extractor) vira erro fatal que para tambem o episodio que
 * tocava sem culpa nenhuma. Derrubar o canal inteiro por isso realimenta o
 * loop tune -> toca um pedaco -> erro -> retune.
 *
 * O erro so e atribuido ao `next` quando o atual ja tinha chegado a READY
 * (senao foi ele mesmo que nao preparou) e quando existe um item DEPOIS do
 * atual na fila (senao nao ha next para culpar).
 *
 * @param currentItemStarted o item atual chegou a STATE_READY desde o load.
 * @param currentIndex `currentMediaItemIndex` no instante do erro.
 * @param mediaItemCount tamanho da fila no instante do erro.
 */
fun decideLiveError(
  currentItemStarted: Boolean,
  currentIndex: Int,
  mediaItemCount: Int,
): LiveErrorAction =
  if (currentItemStarted && mediaItemCount > currentIndex + 1) {
    LiveErrorAction.DROP_NEXT
  } else {
    LiveErrorAction.RETUNE
  }
