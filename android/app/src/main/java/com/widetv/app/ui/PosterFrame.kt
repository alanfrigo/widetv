package com.widetv.app.ui

import android.content.Context
import android.util.AttributeSet
import android.widget.FrameLayout

/**
 * Quadro de capa: altura sempre 3/2 da largura.
 *
 * Existe porque a largura do card vem da grade (tela dividida em 5 colunas) e
 * varia com a resolucao do aparelho. Fixar altura em `dp` daria capa esticada
 * numa TV e cortada na outra; derivar do proprio `onMeasure` resolve nas duas
 * sem ninguem precisar medir nada em codigo.
 */
class PosterFrame @JvmOverloads constructor(
  context: Context,
  attrs: AttributeSet? = null,
  defStyleAttr: Int = 0,
) : FrameLayout(context, attrs, defStyleAttr) {

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val width = MeasureSpec.getSize(widthMeasureSpec)
    super.onMeasure(
      MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY),
      MeasureSpec.makeMeasureSpec(width * 3 / 2, MeasureSpec.EXACTLY),
    )
  }
}
