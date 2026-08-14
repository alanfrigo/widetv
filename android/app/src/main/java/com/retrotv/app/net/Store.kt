package com.retrotv.app.net

import android.content.Context
import android.content.SharedPreferences
import com.retrotv.app.BuildConfig
import com.retrotv.app.ui.CrtSettings

/**
 * Tudo que o app precisa lembrar entre aberturas: endereco do servidor, senha,
 * cookie de sessao e ultimo canal.
 *
 * A senha fica em `SharedPreferences` privado, sem `EncryptedSharedPreferences`.
 * E escolha, nao esquecimento: a lib de cripto do Jetpack esta depreciada e o
 * modelo de ameaca aqui e uma TV nao rooteada na sala de casa. Quem tiver acesso
 * de root ao aparelho ja tem acesso ao app.
 */
class Store(context: Context) {

  private val prefs: SharedPreferences =
    context.applicationContext.getSharedPreferences("retro-tv", Context.MODE_PRIVATE)

  var serverUrl: String
    get() = prefs.getString(KEY_SERVER, null) ?: BuildConfig.DEFAULT_SERVER_URL
    set(value) = prefs.edit().putString(KEY_SERVER, normalizeUrl(value)).apply()

  var password: String?
    get() = prefs.getString(KEY_PASSWORD, null)
    set(value) = prefs.edit().putString(KEY_PASSWORD, value).apply()

  /** Cookies crus (`Set-Cookie`), um por linha do conjunto, por host. */
  fun readCookies(host: String): Set<String> =
    prefs.getStringSet(cookieKey(host), emptySet()) ?: emptySet()

  fun writeCookies(host: String, values: Set<String>) {
    prefs.edit().putStringSet(cookieKey(host), values).apply()
  }

  /**
   * Ultimo canal sintonizado. Devolve null quando nunca houve um, ou quando o
   * canal guardado sumiu do acervo depois de um rescan.
   */
  fun readLastChannel(available: List<Int>): Int? {
    val stored = prefs.getInt(KEY_LAST_CHANNEL, -1)
    return if (stored >= 0 && available.contains(stored)) stored else null
  }

  fun writeLastChannel(channel: Int) {
    prefs.edit().putInt(KEY_LAST_CHANNEL, channel).apply()
  }

  /**
   * Ultimo modo de apresentacao que o servidor disse. So serve para a abertura
   * com a rede fora: servidor alcancavel sempre vence.
   */
  var displayMode: String
    get() = prefs.getString(KEY_DISPLAY_MODE, null) ?: "crt"
    set(value) = prefs.edit().putString(KEY_DISPLAY_MODE, value).apply()

  /** Ajuste do tubo, feito na sala pelo painel de servico. */
  var crt: CrtSettings
    get() = CrtSettings(
      scanlineAlpha = prefs.getFloat(KEY_CRT_SCANLINE, CrtSettings.DEFAULT_SCANLINE),
      vignetteStrength = prefs.getFloat(KEY_CRT_VIGNETTE, CrtSettings.DEFAULT_VIGNETTE_STRENGTH),
      vignetteRadius = prefs.getFloat(KEY_CRT_RADIUS, CrtSettings.DEFAULT_VIGNETTE_RADIUS),
      staticPeak = prefs.getFloat(KEY_CRT_STATIC, CrtSettings.DEFAULT_STATIC_PEAK),
    )
    set(value) {
      prefs.edit()
        .putFloat(KEY_CRT_SCANLINE, value.scanlineAlpha)
        .putFloat(KEY_CRT_VIGNETTE, value.vignetteStrength)
        .putFloat(KEY_CRT_RADIUS, value.vignetteRadius)
        .putFloat(KEY_CRT_STATIC, value.staticPeak)
        .apply()
    }

  companion object {
    private const val KEY_SERVER = "server-url"
    private const val KEY_PASSWORD = "password"
    private const val KEY_LAST_CHANNEL = "last-channel"
    private const val KEY_DISPLAY_MODE = "display-mode"
    private const val KEY_CRT_SCANLINE = "crt-scanline"
    private const val KEY_CRT_VIGNETTE = "crt-vignette"
    private const val KEY_CRT_RADIUS = "crt-radius"
    private const val KEY_CRT_STATIC = "crt-static"

    private fun cookieKey(host: String) = "cookies:$host"

    /**
     * Aceita o que der para digitar num controle remoto: "192.168.1.50:8080"
     * vira `http://192.168.1.50:8080`, e a barra final some para nao duplicar
     * na hora de montar o caminho. Devolve string vazia quando nao ha o que
     * normalizar — quem chama trata isso como "ainda falta o endereco".
     */
    fun normalizeUrl(input: String): String {
      val trimmed = input.trim().trimEnd('/')
      if (trimmed.isEmpty()) return ""
      return if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) trimmed
      else "http://$trimmed"
    }
  }
}
