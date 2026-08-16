package com.widetv.app.net

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.util.concurrent.TimeUnit

/** A sessao acabou e nao foi possivel refaze-la sozinho. */
class UnauthorizedException : IOException("sessao ausente ou expirada")

/** O endereco guardado nao forma uma URL. */
class BadServerUrlException(url: String) : IOException("endereco invalido: $url")

/**
 * Resposta de `/now` com o relogio local dos dois lados do request.
 * Os dois carimbos alimentam `Sync.estimateSkewMs`.
 */
data class TimedNow(
  val data: NowPlaying,
  val sentAtMs: Long,
  val receivedAtMs: Long,
)

/**
 * Resultado do probe de `/api/stream/:id`. Porte do `StreamProbe` do web.
 *
 * PREPARING e o 202 do servidor gerando o remux do episodio: entregar essa
 * resposta ao ExoPlayer nao daria "aguarde" - o corpo JSON morreria no
 * extractor como erro fatal e derrubaria o canal. Quem toca pergunta aqui
 * primeiro e espera.
 */
enum class StreamProbe { READY, PREPARING, ERROR }

/** Funcao pura, separada do OkHttp de proposito: e ela que o teste exercita. */
fun classifyProbe(statusCode: Int): StreamProbe = when {
  statusCode == 202 -> StreamProbe.PREPARING
  statusCode in 200..299 -> StreamProbe.READY
  else -> StreamProbe.ERROR
}

/**
 * Resolve um path que chegou PRONTO do servidor (`posterUrl`, `backdropUrl`,
 * `thumbUrl`) contra a base, sem re-encodar nada.
 *
 * NAO passa por `addPathSegments` de proposito, por duas razoes que ja foram
 * 404 silencioso em todos os cards:
 * - os segmentos ja vem percent-encoded do servidor (o id do episodio no
 *   `thumbUrl` carrega `%2F` e `%20`); re-encodar o `%` viraria `%252F`, o
 *   servidor decodificaria uma vez so e procuraria um episodio que nao existe;
 * - o poster/backdrop vem com query de cache-buster (`?v=...`), e o `?`
 *   encodado como `%3F` viraria parte do path — a rota do Fastify nao casa.
 *
 * Funcao pura, separada do OkHttp de proposito: e ela que o teste exercita.
 */
fun resolveServerPath(base: HttpUrl, path: String): HttpUrl {
  val trimmed = path.trimStart('/')
  val question = trimmed.indexOf('?')
  val builder = base.newBuilder()
  return if (question < 0) {
    builder.addEncodedPathSegments(trimmed).build()
  } else {
    builder
      .addEncodedPathSegments(trimmed.take(question))
      .encodedQuery(trimmed.substring(question + 1))
      .build()
  }
}

/**
 * Cliente HTTP do app.
 *
 * Duas responsabilidades alem de falar JSON: guardar o cookie de sessao entre
 * aberturas, e refazer o login sozinho quando ele vence. Numa TV nao ha teclado
 * confortavel, entao expirar a sessao nao pode significar digitar a senha de novo.
 */
class ApiClient(private val store: Store) {

  private val json = Json { ignoreUnknownKeys = true }

  private val cookieJar = PersistentCookieJar(store)

  /** Sem o interceptor de relogin: e o cliente que o proprio relogin usa. */
  private val bare: OkHttpClient = OkHttpClient.Builder()
    .cookieJar(cookieJar)
    .connectTimeout(10, TimeUnit.SECONDS)
    .readTimeout(30, TimeUnit.SECONDS)
    .build()

  /**
   * Cliente de uso geral. O ExoPlayer tambem stream por ele, senao o request do
   * video sairia sem cookie e o servidor devolveria 401 no meio do episodio.
   */
  val http: OkHttpClient = bare.newBuilder()
    .addInterceptor(ReloginInterceptor())
    .build()

  private fun base(): HttpUrl =
    store.serverUrl.toHttpUrlOrNull() ?: throw BadServerUrlException(store.serverUrl)

  private fun url(path: String): HttpUrl =
    base().newBuilder().addPathSegments(path).build()

  fun streamUrl(episodeId: String): String =
    base().newBuilder()
      .addPathSegments(Routes.STREAM)
      // Segmento unico: as barras do id viram %2F, como no cliente web.
      .addPathSegment(episodeId)
      .build()
      .toString()

  /**
   * Pergunta se o stream do episodio ja existe, sem baixar nada (HEAD).
   *
   * ERROR nao lanca de proposito: um probe falhado nao prova que o arquivo nao
   * vem, e quem chama segue em frente e deixa o fluxo normal avisar - mesma
   * regra do `probeStream` do web player.
   */
  suspend fun probeStream(episodeId: String): StreamProbe = withContext(Dispatchers.IO) {
    try {
      val request = Request.Builder().url(streamUrl(episodeId)).head().build()
      http.newCall(request).execute().use { response -> classifyProbe(response.code) }
    } catch (error: IOException) {
      StreamProbe.ERROR
    }
  }

  suspend fun login(password: String): Boolean = withContext(Dispatchers.IO) {
    performLogin(password)
  }

  suspend fun hasSession(): Boolean = withContext(Dispatchers.IO) {
    // Vai pelo `bare`: aqui a pergunta e justamente se ha sessao, e um relogin
    // automatico transformaria "nao tem" em "tem" e esconderia a resposta.
    bare.newCall(Request.Builder().url(url(Routes.SESSION)).build()).execute().use { it.isSuccessful }
  }

  suspend fun channels(): List<ChannelSummary> = withContext(Dispatchers.IO) {
    json.decodeFromString(getBody(url(Routes.CHANNELS)))
  }

  /** Encerra a sessao no servidor. Falhar aqui nao muda nada do lado de ca. */
  suspend fun logout() {
    withContext(Dispatchers.IO) {
      runCatching {
        http.newCall(
          Request.Builder().url(url(Routes.LOGOUT)).post(EMPTY_BODY).build(),
        ).execute().close()
      }
    }
  }

  /**
   * Estado de todos os canais, na ordem do catalogo.
   *
   * Rota NOVA: um servidor mais antigo devolve 404, e a lista vazia faz a faixa
   * "No ar agora" simplesmente nao aparecer. Derrubar o catalogo inteiro por
   * causa de uma faixa seria trocar o app por um detalhe dele.
   */
  suspend fun nowAll(): List<NowPlaying> = withContext(Dispatchers.IO) {
    val body = getBodyOrNull(url(Routes.NOW_ALL)) ?: return@withContext emptyList()
    json.decodeFromString(body)
  }

  /** Mesma regra do `nowAll`: rota nova, ausencia vira faixa que nao aparece. */
  suspend fun resume(): List<ResumeEntry> = withContext(Dispatchers.IO) {
    val body = getBodyOrNull(url(Routes.HISTORY_RESUME)) ?: return@withContext emptyList()
    json.decodeFromString(body)
  }

  /**
   * Rota da arte 16:9 do canal, relativa como `PosterLoader` espera.
   *
   * Existe para quem so tem o numero do canal na mao (a faixa ao vivo monta o
   * card a partir do `NowPlaying`); quem tem o `ChannelSummary` usa o
   * `backdropUrl` que veio no proprio objeto.
   */
  fun backdropUrl(channelNumber: Int): String = Routes.backdrop(channelNumber)

  /** null quando o canal nao existe (404). */
  suspend fun now(channelNumber: Int): TimedNow? = withContext(Dispatchers.IO) {
    val request = Request.Builder().url(url(Routes.now(channelNumber))).build()
    val sentAtMs = System.currentTimeMillis()
    http.newCall(request).execute().use { response ->
      val receivedAtMs = System.currentTimeMillis()
      if (response.code == 404) return@withContext null
      if (response.code == 401) throw UnauthorizedException()
      if (!response.isSuccessful) throw IOException("${request.url} respondeu ${response.code}")
      val body = response.body?.string() ?: throw IOException("${request.url} sem corpo")
      TimedNow(json.decodeFromString(body), sentAtMs, receivedAtMs)
    }
  }

  /**
   * Bytes crus de um recurso binario da API — capas, backdrops e quadros.
   *
   * Vai pelo `http` de sempre porque a capa esta atras do mesmo guard de sessao
   * do resto: um cliente HTTP separado nasceria sem cookie e receberia 401.
   *
   * @param path rota relativa como vem PRONTA do servidor (`posterUrl`,
   *   `backdropUrl`, `thumbUrl`), com ou sem a barra inicial — os segmentos ja
   *   chegam percent-encoded e pode haver query; ver `resolveServerPath`.
   * @return null quando o recurso nao existe (404).
   */
  suspend fun bytes(path: String): ByteArray? = withContext(Dispatchers.IO) {
    val target = resolveServerPath(base(), path)
    http.newCall(Request.Builder().url(target).build()).execute().use { response ->
      if (response.code == 404) return@withContext null
      if (response.code == 401) throw UnauthorizedException()
      if (!response.isSuccessful) throw IOException("$target respondeu ${response.code}")
      response.body?.bytes() ?: throw IOException("$target sem corpo")
    }
  }

  /** Catalogo do canal, na ordem da grade. null quando o canal nao existe (404). */
  suspend fun episodes(channelNumber: Int): List<EpisodeRef>? = withContext(Dispatchers.IO) {
    getBodyOrNull(url(Routes.episodes(channelNumber)))?.let { json.decodeFromString<List<EpisodeRef>>(it) }
  }

  suspend fun settings(): AppSettings = withContext(Dispatchers.IO) {
    json.decodeFromString(getBody(url(Routes.SETTINGS)))
  }

  /**
   * @param patch corpo montado em `SettingsPatch`, com UMA chave: campo ausente
   *   significa "nao mexe", e mandar o objeto inteiro sobrescreveria escolha que
   *   outra tela acabou de fazer.
   * @return o `AppSettings` inteiro ja com a mudanca — e o que a tela adota como
   *   novo estado, em vez de confiar no palpite que ela pintou antes.
   */
  suspend fun patchSettings(patch: JsonObject): AppSettings = withContext(Dispatchers.IO) {
    val target = url(Routes.SETTINGS)
    val body = json.encodeToString(JsonObject.serializer(), patch).toRequestBody(JSON_MEDIA_TYPE)
    http.newCall(Request.Builder().url(target).patch(body).build()).execute().use { response ->
      if (response.code == 401) throw UnauthorizedException()
      if (!response.isSuccessful) throw IOException("$target respondeu ${response.code}")
      json.decodeFromString<AppSettings>(
        response.body?.string() ?: throw IOException("$target sem corpo"),
      )
    }
  }

  suspend fun libraryStatus(): LibraryStatus = withContext(Dispatchers.IO) {
    json.decodeFromString(getBody(url(Routes.LIBRARY_STATUS)))
  }

  /** @param mode `SCAN_MODE_INCREMENTAL` ou `SCAN_MODE_FULL`. */
  suspend fun startScan(mode: String): TaskAccepted = withContext(Dispatchers.IO) {
    postTask(
      url(Routes.LIBRARY_SCAN),
      json.encodeToString(ScanRequest.serializer(), ScanRequest(mode)),
    )
  }

  /** @param reset apaga a metadata gravada antes de buscar — conserta capa errada. */
  suspend fun refreshMetadata(reset: Boolean): TaskAccepted = withContext(Dispatchers.IO) {
    postTask(
      url(Routes.LIBRARY_METADATA),
      json.encodeToString(MetadataRefreshRequest.serializer(), MetadataRefreshRequest(reset)),
    )
  }

  /**
   * Fila de extracao de quadros.
   *
   * @param reset refaz o quadro de quem ja tem; sem ele a fila so oferece o que
   *   ainda esta sem miniatura.
   */
  suspend fun generateThumbs(reset: Boolean): TaskAccepted = withContext(Dispatchers.IO) {
    postTask(
      url(Routes.LIBRARY_THUMBS),
      json.encodeToString(ThumbsRequest.serializer(), ThumbsRequest(reset)),
    )
  }

  /**
   * Dispara uma tarefa de fundo.
   *
   * 202 e 409 NAO sao erro: os dois trazem `TaskAccepted` no corpo e viram uma
   * linha na tela ("iniciado" / "ja esta rodando"). Tratar 409 como excecao
   * transformaria uma resposta perfeitamente util em pilha de erro, e quem
   * apertou OK duas vezes veria "servidor fora do ar". So o resto do nao-2xx
   * (400 de modo invalido, 500) e falha de verdade.
   */
  private fun postTask(target: HttpUrl, body: String): TaskAccepted {
    val request = Request.Builder().url(target).post(body.toRequestBody(JSON_MEDIA_TYPE)).build()
    http.newCall(request).execute().use { response ->
      if (response.code == 401) throw UnauthorizedException()
      if (!response.isSuccessful && response.code != 409) {
        throw IOException("$target respondeu ${response.code}")
      }
      return json.decodeFromString(
        response.body?.string() ?: throw IOException("$target sem corpo"),
      )
    }
  }

  /** null quando o recurso nao existe (404). */
  private fun getBodyOrNull(target: HttpUrl): String? {
    http.newCall(Request.Builder().url(target).build()).execute().use { response ->
      if (response.code == 404) return null
      if (response.code == 401) throw UnauthorizedException()
      if (!response.isSuccessful) throw IOException("$target respondeu ${response.code}")
      return response.body?.string() ?: throw IOException("$target sem corpo")
    }
  }

  private fun getBody(target: HttpUrl): String =
    getBodyOrNull(target) ?: throw IOException("$target respondeu 404")

  private fun performLogin(password: String): Boolean {
    val body = json.encodeToString(LoginRequest.serializer(), LoginRequest(password))
      .toRequestBody(JSON_MEDIA_TYPE)
    val request = Request.Builder().url(url(Routes.LOGIN)).post(body).build()
    return try {
      bare.newCall(request).execute().use { it.isSuccessful }
    } catch (error: IOException) {
      false
    }
  }

  /**
   * 401 em qualquer rota significa sessao vencida, nao senha errada: a senha
   * so muda quando alguem a digita. Refaz o login com a credencial guardada e
   * repete o request UMA vez.
   */
  private inner class ReloginInterceptor : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
      val response = chain.proceed(chain.request())
      if (response.code != 401) return response

      val password = store.password ?: return response
      // Devolve o 401 original quando o relogin falha: quem chamou decide se
      // abre a tela de senha. Repetir o request so gastaria outro round-trip.
      if (!performLogin(password)) return response

      response.close()
      return chain.proceed(chain.request())
    }
  }

  private companion object {
    val JSON_MEDIA_TYPE = "application/json".toMediaType()

    /** POST sem corpo: o logout so precisa do cookie. */
    val EMPTY_BODY = ByteArray(0).toRequestBody(null, 0, 0)
  }
}

@kotlinx.serialization.Serializable
private data class LoginRequest(val password: String)

/**
 * Cookie de sessao que sobrevive a reinicio do app e da TV.
 *
 * Guarda por host: o mesmo aparelho pode falar com o dominio publico hoje e com
 * o IP da LAN amanha, e misturar as sessoes daria 401 aleatorio.
 */
private class PersistentCookieJar(private val store: Store) : CookieJar {

  private val memory = mutableMapOf<String, MutableList<Cookie>>()

  @Synchronized
  override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
    val host = url.host
    val current = load(host)
    for (cookie in cookies) {
      current.removeAll { it.name == cookie.name }
      current.add(cookie)
    }
    memory[host] = current
    store.writeCookies(host, current.filter { it.persistent }.map { it.toString() }.toSet())
  }

  @Synchronized
  override fun loadForRequest(url: HttpUrl): List<Cookie> {
    val now = System.currentTimeMillis()
    val current = load(url.host)
    val alive = current.filter { it.expiresAt > now }
    if (alive.size != current.size) {
      memory[url.host] = alive.toMutableList()
      store.writeCookies(url.host, alive.filter { it.persistent }.map { it.toString() }.toSet())
    }
    return alive.filter { it.matches(url) }
  }

  private fun load(host: String): MutableList<Cookie> {
    memory[host]?.let { return it }
    // `Cookie.parse` precisa de uma URL para resolver dominio e caminho; o host
    // guardado e o suficiente para reconstruir a que o servidor viu.
    val seed = "https://$host/".toHttpUrlOrNull()
    val restored = if (seed == null) mutableListOf()
    else store.readCookies(host).mapNotNull { Cookie.parse(seed, it) }.toMutableList()
    memory[host] = restored
    return restored
  }
}
