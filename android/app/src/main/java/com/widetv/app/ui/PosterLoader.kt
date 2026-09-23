package com.widetv.app.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.LruCache
import com.widetv.app.net.ApiClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.IOException

/**
 * Imagens do acervo: baixa, reduz e guarda. Serve capa 2:3, arte 16:9 do card
 * largo, o backdrop do hero e o quadro do episodio — a diferenca entre elas e
 * so o alvo.
 *
 * Nao ha biblioteca de imagem aqui de proposito. O acervo tem algumas centenas
 * de series, a imagem vem do proprio servidor (atras do guard de sessao, pelo
 * MESMO OkHttp da API — um cliente novo nasceria sem cookie) e o unico requisito
 * de verdade e nao decodificar 1280x720 para caber num card de 230dp. Um cache
 * LRU e um `inSampleSize` controlam a memoria; uma dependencia nova
 * custaria mais do que resolve.
 *
 * O cancelamento e de quem chama: o ViewHolder guarda o `Job` e o cancela quando
 * a linha e reciclada.
 */
object PosterLoader {

  /**
   * Teto do cache, em bytes.
   *
   * A conta em xhdpi (1 dp = 2 px), com `Bitmap` em ARGB_8888: uma capa 2:3
   * entra a 340x510 (~694 KB), um quadro de episodio a 480x270 (~518 KB, sem
   * reducao — o slot da linha tem 258 px e reduzir pela metade daria 240,
   * borrado). Ou seja, 48 MB seguram ~69 capas ou ~94 quadros.
   *
   * Uma temporada de 200 episodios rolada de ponta a ponta portanto EXPULSA o
   * comeco, e isso e aceitavel de proposito: o que volta a custar e um JPEG de
   * ~25 KB na rede de casa, enquanto subir o teto custaria heap num aparelho
   * que tambem esta decodificando video. A recomendacao do Android para cache
   * de bitmap e 1/8 da memoria disponivel; 48 MB ja e o dobro disso num
   * aparelho de 192 MB de heap, e o `coerceAtMost` abaixo e o que impede que
   * numa caixa menor ele vire OOM em vez de cache.
   */
  private val CACHE_BYTES: Int =
    (Runtime.getRuntime().maxMemory() / 4).coerceAtMost(48L * 1024 * 1024).toInt()

  private val cache = object : LruCache<String, Bitmap>(CACHE_BYTES) {
    override fun sizeOf(key: String, value: Bitmap): Int = value.byteCount
  }

  /**
   * Sincrono e barato: serve para pintar o card antes de decidir baixar.
   *
   * @param targetHeightPx 0 quando so a largura importa — e o caso da capa 2:3,
   *   cuja altura sai da propria proporcao.
   */
  fun cached(api: ApiClient, path: String, targetWidthPx: Int, targetHeightPx: Int = 0): Bitmap? =
    cache.get(key(api.imageUrl(path), targetWidthPx, targetHeightPx))

  /**
   * @param path rota relativa da imagem, como vem de `ChannelSummary.posterUrl`
   *   ou `backdropUrl`.
   * @param targetWidthPx largura do destino em pixels.
   * @param targetHeightPx altura do destino em pixels; 0 para ignorar.
   * @return null quando o servidor nao tem a imagem, ou quando a rede falhou —
   *   sao a mesma coisa para o card, que fica com o placeholder listrado.
   */
  suspend fun load(
    api: ApiClient,
    path: String,
    targetWidthPx: Int,
    targetHeightPx: Int = 0,
  ): Bitmap? {
    val url = api.imageUrl(path)
    val cacheKey = key(url, targetWidthPx, targetHeightPx)
    cache.get(cacheKey)?.let { return it }
    val flight = synchronized(pending) {
      pending.getOrPut(cacheKey) {
        Flight(scope.async(start = CoroutineStart.LAZY) {
          permits.withPermit {
            cache.get(cacheKey) ?: run {
              val bytes = try { api.bytes(path, url) } catch (error: IOException) { null }
                ?: return@withPermit null
              val bitmap = decode(bytes, targetWidthPx, targetHeightPx) ?: return@withPermit null
              synchronized(pending) {
                coroutineContext.ensureActive()
                cache.put(cacheKey, bitmap)
              }
              bitmap
            }
          }
        })
      }.also { it.readers++ }
    }
    try {
      return flight.job.await()
    } finally {
      synchronized(pending) {
        flight.readers--
        if (flight.readers == 0) {
          if (pending[cacheKey] === flight) pending.remove(cacheKey)
          flight.job.cancel()
        }
      }
    }
  }

  private class Flight(val job: Deferred<Bitmap?>, var readers: Int = 0)
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val permits = Semaphore(4)
  private val pending = mutableMapOf<String, Flight>()

  fun clear() = synchronized(pending) {
    pending.values.forEach { it.job.cancel() }
    pending.clear()
    cache.evictAll()
  }

  /**
   * A mesma imagem em dois tamanhos e duas entradas: o backdrop do hero tem tres
   * vezes a altura do card largo, e servir o bitmap pequeno no hero deixaria a
   * tela de abertura borrada.
   */
  private fun key(path: String, targetWidthPx: Int, targetHeightPx: Int) =
    "$path@${targetWidthPx}x$targetHeightPx"

  private fun decode(bytes: ByteArray, targetWidthPx: Int, targetHeightPx: Int): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)

    val options = BitmapFactory.Options().apply {
      inSampleSize = sampleSizeFor(
        bounds.outWidth,
        bounds.outHeight,
        targetWidthPx,
        targetHeightPx,
      )
    }
    return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
  }
}
