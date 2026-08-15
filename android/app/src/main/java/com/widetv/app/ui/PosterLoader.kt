package com.widetv.app.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.LruCache
import com.widetv.app.net.ApiClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.IOException

/**
 * Capas do acervo: baixa, reduz e guarda.
 *
 * Nao ha biblioteca de imagem aqui de proposito. O acervo tem algumas centenas
 * de series, a capa vem do proprio servidor (atras do guard de sessao, pelo
 * MESMO OkHttp da API — um cliente novo nasceria sem cookie) e o unico requisito
 * de verdade e nao decodificar 680x1000 para caber num card de 200dp. Um cache
 * LRU e um `inSampleSize` resolvem isso em trinta linhas; uma dependencia nova
 * custaria mais do que resolve.
 *
 * O cancelamento e de quem chama: o ViewHolder guarda o `Job` e o cancela quando
 * a linha e reciclada.
 */
object PosterLoader {

  /**
   * ~46 capas de 200dp em xhdpi. Numa TV isto cobre a tela inteira do acervo
   * mais algumas rolagens, que e todo o proposito: rolar de volta nao pode
   * baixar de novo.
   */
  private const val CACHE_BYTES = 48 * 1024 * 1024

  private val cache = object : LruCache<String, Bitmap>(CACHE_BYTES) {
    override fun sizeOf(key: String, value: Bitmap): Int = value.byteCount
  }

  /** Sincrono e barato: serve para pintar o card antes de decidir baixar. */
  fun cached(path: String, targetWidthPx: Int): Bitmap? = cache.get(key(path, targetWidthPx))

  /**
   * @param path rota relativa da capa, como vem de `ChannelSummary.posterUrl`.
   * @param targetWidthPx largura do destino em pixels.
   * @return null quando o servidor nao tem a capa, ou quando a rede falhou —
   *   sao a mesma coisa para o card, que fica com o placeholder de iniciais.
   */
  suspend fun load(api: ApiClient, path: String, targetWidthPx: Int): Bitmap? {
    cached(path, targetWidthPx)?.let { return it }

    return withContext(Dispatchers.IO) {
      val bytes = try {
        api.bytes(path)
      } catch (error: IOException) {
        null
      } ?: return@withContext null

      val bitmap = decode(bytes, targetWidthPx) ?: return@withContext null
      cache.put(key(path, targetWidthPx), bitmap)
      bitmap
    }
  }

  private fun key(path: String, targetWidthPx: Int) = "$path@$targetWidthPx"

  private fun decode(bytes: ByteArray, targetWidthPx: Int): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)

    val options = BitmapFactory.Options().apply {
      inSampleSize = sampleSizeFor(bounds.outWidth, targetWidthPx)
    }
    return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
  }
}
