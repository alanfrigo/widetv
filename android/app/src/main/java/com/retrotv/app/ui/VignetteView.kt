package com.retrotv.app.ui

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RadialGradient
import android.graphics.Shader
import android.util.AttributeSet
import android.view.View
import kotlin.math.hypot

/**
 * Vinheta do tubo: centro limpo, cantos apagados.
 *
 * Existe como View em vez de drawable XML por um motivo so: o raio precisa mudar
 * ao vivo enquanto alguem ajusta o painel de servico com o controle na mao, e
 * `%p` de arquivo e valor de compilacao.
 *
 * Custo: um `drawRect` com shader por frame de composicao — o mesmo que o
 * drawable fazia.
 */
class VignetteView @JvmOverloads constructor(
  context: Context,
  attrs: AttributeSet? = null,
) : View(context, attrs) {

  /** Alpha no canto. 0 apaga a vinheta. */
  var strength: Float = CrtSettings.DEFAULT_VIGNETTE_STRENGTH
    set(value) {
      field = value
      rebuild()
      invalidate()
    }

  /** 1.0 = o degrade termina exatamente no canto. Menor fecha, maior abre. */
  var radiusFraction: Float = CrtSettings.DEFAULT_VIGNETTE_RADIUS
    set(value) {
      field = value
      rebuild()
      invalidate()
    }

  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    rebuild()
  }

  private fun rebuild() {
    if (width == 0 || height == 0) return

    val cx = width / 2f
    val cy = height / 2f
    // Distancia ao canto: com fracao 1.0 o preto so chega no vertice, que e o
    // ponto onde a vinheta some sem virar tunel.
    val radius = radiusFraction.coerceAtLeast(0.05f) * hypot(cx, cy)
    val alpha = (strength.coerceIn(0f, 1f) * 255).toInt()

    paint.shader = RadialGradient(
      cx,
      cy,
      radius,
      intArrayOf(0x00000000, 0x00000000, alpha shl 24),
      floatArrayOf(0f, 0.5f, 1f),
      Shader.TileMode.CLAMP,
    )
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    if (paint.shader == null) return
    canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), paint)
  }
}
