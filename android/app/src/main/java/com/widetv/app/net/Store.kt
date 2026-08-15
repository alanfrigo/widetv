package com.widetv.app.net

import android.content.Context
import android.content.SharedPreferences
import com.widetv.app.BuildConfig

/**
 * Tudo que o app precisa lembrar entre aberturas: endereco do servidor, senha,
 * cookie de sessao, ultimo canal ao vivo e a preferencia de trilhas.
 *
 * A senha fica em `SharedPreferences` privado, sem `EncryptedSharedPreferences`.
 * E escolha, nao esquecimento: a lib de cripto do Jetpack esta depreciada e o
 * modelo de ameaca aqui e uma TV nao rooteada na sala de casa. Quem tiver acesso
 * de root ao aparelho ja tem acesso ao app.
 */
class Store(context: Context) {

  private val prefs: SharedPreferences =
    context.applicationContext.getSharedPreferences("widetv", Context.MODE_PRIVATE)

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
   * Ultimo canal sintonizado ao vivo. Devolve null quando nunca houve um, ou
   * quando o canal guardado sumiu do acervo depois de um rescan.
   */
  fun readLastChannel(available: List<Int>): Int? {
    val stored = prefs.getInt(KEY_LAST_CHANNEL, -1)
    return if (stored >= 0 && available.contains(stored)) stored else null
  }

  fun writeLastChannel(channel: Int) {
    prefs.edit().putInt(KEY_LAST_CHANNEL, channel).apply()
  }

  /**
   * Idioma de audio escolhido no painel de trilhas, como tag do container
   * ("por", "eng", "und"). null = nunca foi escolhido, e a ordem do arquivo
   * decide.
   *
   * Guarda-se o IDIOMA, e nao o indice da faixa: o indice muda de episodio para
   * episodio, e a preferencia precisa atravessar a maratona inteira — e os
   * reinicios do app.
   */
  var audioLang: String?
    get() = prefs.getString(KEY_AUDIO_LANG, null)
    set(value) = prefs.edit().putString(KEY_AUDIO_LANG, value).apply()

  /**
   * Idioma de legenda escolhido. **null = legendas desligadas**, que tambem e o
   * estado de fabrica: numa TV de sala, legenda que aparece sem ninguem ter
   * pedido incomoda mais do que legenda que falta.
   */
  var subtitleLang: String?
    get() = prefs.getString(KEY_SUBTITLE_LANG, null)
    set(value) = prefs.edit().putString(KEY_SUBTITLE_LANG, value).apply()

  companion object {
    private const val KEY_SERVER = "server-url"
    private const val KEY_PASSWORD = "password"
    private const val KEY_LAST_CHANNEL = "last-channel"
    private const val KEY_AUDIO_LANG = "audio-lang"
    private const val KEY_SUBTITLE_LANG = "subtitle-lang"

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
