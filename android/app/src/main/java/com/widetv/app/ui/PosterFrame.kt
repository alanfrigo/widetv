package com.widetv.app.ui

import android.content.Context
import android.util.AttributeSet
import android.widget.FrameLayout

/**
 * Quadro de proporcao fixa: a altura sai da largura medida.
 *
 * Existe porque a largura do card vem da faixa e varia com a resolucao do
 * aparelho. Fixar altura em `dp` daria arte esticada numa TV e cortada na outra
 * — e, pior, deixaria a altura mentindo assim que alguem mexesse em
 * `card_wide_width` ou `ep_thumb_w`. Derivar do proprio `onMeasure` resolve nas
 * duas sem ninguem precisar recalcular nada a mao.
 *
 * A razao e uma constante de subclasse, e nao um atributo de XML, porque um
 * atributo customizado exigiria um `attrs.xml` — e sao duas proporcoes no app
 * inteiro, nao um sistema.
 */
abstract class AspectFrame @JvmOverloads constructor(
  context: Context,
  attrs: AttributeSet? = null,
  defStyleAttr: Int = 0,
) : FrameLayout(context, attrs, defStyleAttr) {

  /** Altura = largura * [heightNumerator] / [heightDenominator]. */
  protected abstract val heightNumerator: Int

  protected abstract val heightDenominator: Int

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val width = MeasureSpec.getSize(widthMeasureSpec)
    super.onMeasure(
      MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY),
      MeasureSpec.makeMeasureSpec(
        width * heightNumerator / heightDenominator,
        MeasureSpec.EXACTLY,
      ),
    )
  }
}

/** Capa 2:3 — o card do acervo e a capa da tela de serie. */
class PosterFrame @JvmOverloads constructor(
  context: Context,
  attrs: AttributeSet? = null,
  defStyleAttr: Int = 0,
) : AspectFrame(context, attrs, defStyleAttr) {

  override val heightNumerator = 3

  override val heightDenominator = 2
}

/** Arte 16:9 — o card largo das faixas de cima e a miniatura do episodio. */
class WideFrame @JvmOverloads constructor(
  context: Context,
  attrs: AttributeSet? = null,
  defStyleAttr: Int = 0,
) : AspectFrame(context, attrs, defStyleAttr) {

  override val heightNumerator = 9

  override val heightDenominator = 16
}
