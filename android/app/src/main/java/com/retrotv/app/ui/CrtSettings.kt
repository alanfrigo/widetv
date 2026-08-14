package com.retrotv.app.ui

/**
 * Ajuste do tubo, a parte da estetica que so pode ser decidida na sala.
 *
 * O valor que parece certo num monitor de 27" vira tunel numa TV de 55" no
 * escuro, e nao ha como acertar isso compilando: por isso os quatro numeros
 * moram aqui, sao gravados no aparelho e mudam ao vivo pelo painel de servico.
 */
data class CrtSettings(
  /** Forca das scanlines. O tile e preto puro; isto e o alpha da camada. */
  val scanlineAlpha: Float = DEFAULT_SCANLINE,
  /** Escurecimento no canto da tela. */
  val vignetteStrength: Float = DEFAULT_VIGNETTE_STRENGTH,
  /** 1.0 = o degrade termina exatamente no canto. Menor fecha, maior abre. */
  val vignetteRadius: Float = DEFAULT_VIGNETTE_RADIUS,
  /** Pico do chuvisco no instante da troca de canal. */
  val staticPeak: Float = DEFAULT_STATIC_PEAK,
) {
  companion object {
    const val DEFAULT_SCANLINE = 0.12f
    const val DEFAULT_VIGNETTE_STRENGTH = 0.30f
    const val DEFAULT_VIGNETTE_RADIUS = 1.0f
    const val DEFAULT_STATIC_PEAK = 0.40f
  }
}

/** Faixa e passo de cada ajuste, para o painel nao precisar saber de nada. */
enum class CrtKnob(
  val label: String,
  val min: Float,
  val max: Float,
  val step: Float,
) {
  SCANLINES("SCANLINES", 0f, 0.40f, 0.02f),
  VIGNETTE_STRENGTH("VINHETA", 0f, 0.80f, 0.05f),
  VIGNETTE_RADIUS("RAIO DA VINHETA", 0.60f, 1.60f, 0.05f),
  STATIC("CHUVISCO", 0f, 1f, 0.05f);

  fun read(settings: CrtSettings): Float = when (this) {
    SCANLINES -> settings.scanlineAlpha
    VIGNETTE_STRENGTH -> settings.vignetteStrength
    VIGNETTE_RADIUS -> settings.vignetteRadius
    STATIC -> settings.staticPeak
  }

  fun write(settings: CrtSettings, value: Float): CrtSettings {
    val clamped = value.coerceIn(min, max)
    return when (this) {
      SCANLINES -> settings.copy(scanlineAlpha = clamped)
      VIGNETTE_STRENGTH -> settings.copy(vignetteStrength = clamped)
      VIGNETTE_RADIUS -> settings.copy(vignetteRadius = clamped)
      STATIC -> settings.copy(staticPeak = clamped)
    }
  }

  /** Passo dado em cima do valor atual, ja limitado a faixa. */
  fun nudge(settings: CrtSettings, direction: Int): CrtSettings =
    write(settings, read(settings) + step * direction)

  /** Barra de dez casas, no mesmo espirito do indicador de volume. */
  fun bar(settings: CrtSettings): String {
    val fraction = ((read(settings) - min) / (max - min)).coerceIn(0f, 1f)
    val filled = Math.round(fraction * BAR_STEPS)
    return "[" + "#".repeat(filled) + "-".repeat(BAR_STEPS - filled) + "]"
  }

  fun format(settings: CrtSettings): String =
    "${bar(settings)}  ${String.format(java.util.Locale.ROOT, "%.2f", read(settings))}"

  private companion object {
    const val BAR_STEPS = 10
  }
}
