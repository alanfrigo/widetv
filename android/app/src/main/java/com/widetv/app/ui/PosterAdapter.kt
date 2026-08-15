package com.widetv.app.ui

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.recyclerview.widget.RecyclerView
import com.widetv.app.R
import com.widetv.app.databinding.ItemPosterBinding
import com.widetv.app.net.ApiClient
import com.widetv.app.net.ChannelSummary
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/**
 * Grade de capas do acervo.
 *
 * A capa e carregada por linha, com o `Job` guardado no ViewHolder: rolar
 * rapido recicla dezenas de cards, e sem cancelar cada um deles continuaria
 * baixando uma imagem que ninguem mais vai ver.
 */
class PosterAdapter(
  private val scope: CoroutineScope,
  private val api: ApiClient,
  private val onOpen: (ChannelSummary) -> Unit,
) : RecyclerView.Adapter<PosterAdapter.Holder>() {

  /**
   * Lista inteira de uma vez: o acervo chega pronto do servidor e so muda em
   * bloco (login, rescan). Diff aqui seria maquinario sem nada para diferenciar.
   */
  @set:SuppressLint("NotifyDataSetChanged")
  var items: List<ChannelSummary> = emptyList()
    set(value) {
      field = value
      notifyDataSetChanged()
    }

  class Holder(val views: ItemPosterBinding) : RecyclerView.ViewHolder(views.root) {
    var job: Job? = null
  }

  override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder {
    val views = ItemPosterBinding.inflate(LayoutInflater.from(parent.context), parent, false)
    // Arredondar a capa: o `background` do quadro ja tem raio, e o clip faz a
    // imagem obedecer a ele sem precisar de bitmap mascarado.
    views.cardArt.clipToOutline = true

    val holder = Holder(views)
    views.card.setOnClickListener {
      val position = holder.bindingAdapterPosition
      if (position != RecyclerView.NO_POSITION) onOpen(items[position])
    }
    views.card.setOnFocusChangeListener { view, focused -> lift(view, focused) }
    return holder
  }

  override fun onBindViewHolder(holder: Holder, position: Int) {
    val channel = items[position]
    val views = holder.views

    views.cardName.text = channel.name
    views.cardMeta.text = formatCardMeta(channel.year, channel.episodeCount)
    views.cardInitials.text = initialsOf(channel.name)

    holder.job?.cancel()
    holder.job = null

    val path = channel.posterUrl
    val width = views.root.resources.getDimensionPixelSize(R.dimen.poster_decode_width)

    val ready = if (path == null) null else PosterLoader.cached(path, width)
    showPoster(holder, ready)
    if (path == null || ready != null) return

    // O card ja esta pintado com as iniciais; a capa entra por cima quando (e
    // se) chegar. Nao ha estado de "carregando" na tela: um spinner por card
    // faria a grade inteira piscar a cada rolagem.
    holder.job = scope.launch {
      val bitmap = PosterLoader.load(api, path, width)
      if (holder.bindingAdapterPosition == position) showPoster(holder, bitmap)
    }
  }

  override fun onViewRecycled(holder: Holder) {
    holder.job?.cancel()
    holder.job = null
    showPoster(holder, null)
  }

  override fun getItemCount(): Int = items.size

  private fun showPoster(holder: Holder, bitmap: Bitmap?) {
    holder.views.cardPoster.setImageBitmap(bitmap)
    holder.views.cardPoster.visibility = if (bitmap == null) View.GONE else View.VISIBLE
    holder.views.cardInitials.visibility = if (bitmap == null) View.VISIBLE else View.GONE
  }

  private companion object {
    const val FOCUS_SCALE = 1.06f
    const val FOCUS_MS = 140L
    const val FOCUS_ELEVATION = 16f

    /**
     * O card em foco cresce e sobe. So a borda de acento nao bastaria: a tres
     * metros de distancia, o que o olho pega e o card maior, nao o contorno.
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
  }
}
