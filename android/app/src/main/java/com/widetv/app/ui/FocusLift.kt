package com.widetv.app.ui

import android.view.View

/** 1.03 e o numero do design; acima disso o card come o vizinho da faixa. */
private const val FOCUS_SCALE = 1.03f
private const val FOCUS_MS = 140L
private const val FOCUS_ELEVATION = 16f

/**
 * Animacao de foco compartilhada pelos cards das faixas (`PosterAdapter` e
 * `WideCardAdapter`; contrato documentado nos layouts `item_card_*`).
 *
 * O card em foco cresce e sobe. So o contorno de acento nao bastaria: a tres
 * metros de distancia, o que o olho pega e o card maior.
 */
fun lift(view: View, focused: Boolean) {
  val scale = if (focused) FOCUS_SCALE else 1f
  view.animate()
    .scaleX(scale)
    .scaleY(scale)
    .translationZ(if (focused) FOCUS_ELEVATION else 0f)
    .setDuration(FOCUS_MS)
    .start()
}
