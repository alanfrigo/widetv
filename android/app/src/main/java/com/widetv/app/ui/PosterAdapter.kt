package com.widetv.app.ui

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.recyclerview.widget.RecyclerView
import com.widetv.app.R
import com.widetv.app.databinding.ItemCardTallBinding
import com.widetv.app.net.ApiClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/**
 * Faixa "Todo o acervo": o card 2:3, um por canal.
 *
 * Continua sendo um adapter separado do `WideCardAdapter` porque a forma do card
 * e outra — proporcao, selos e placeholder de iniciais nao tem equivalente no
 * card largo, e um adapter unico com dois `viewType` serviria duas listas que
 * nunca se misturam.
 *
 * A capa e carregada por card, com o `Job` guardado no ViewHolder: rolar rapido
 * recicla dezenas de cards, e sem cancelar cada um deles continuaria baixando
 * uma imagem que ninguem mais vai ver.
 */
class PosterAdapter(
  private val scope: CoroutineScope,
  private val api: ApiClient,
  private val onOpen: (TallCard) -> Unit,
) : RecyclerView.Adapter<PosterAdapter.Holder>() {

  /**
   * Lista inteira de uma vez: o acervo chega pronto do servidor e so muda em
   * bloco (login, rescan, busca). Diff aqui seria maquinario sem nada para
   * diferenciar.
   */
  @set:SuppressLint("NotifyDataSetChanged")
  var items: List<TallCard> = emptyList()
    set(value) {
      field = value
      notifyDataSetChanged()
    }

  private var focusUpId: Int = View.NO_ID
  private var focusDownId: Int = View.NO_ID

  /** Vizinhos verticais do D-pad. Ver `WideCardAdapter.wireFocus`. */
  fun wireFocus(upId: Int, downId: Int) {
    if (upId == focusUpId && downId == focusDownId) return
    focusUpId = upId
    focusDownId = downId
    notifyItemRangeChanged(0, itemCount)
  }

  class Holder(val views: ItemCardTallBinding) : RecyclerView.ViewHolder(views.root) {
    var job: Job? = null
  }

  override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder {
    val views = ItemCardTallBinding.inflate(LayoutInflater.from(parent.context), parent, false)
    views.cardArt.clipToOutline = true

    val holder = Holder(views)
    views.card.setOnClickListener {
      val position = holder.bindingAdapterPosition
      if (position != RecyclerView.NO_POSITION) onOpen(items[position])
    }
    views.card.setOnFocusChangeListener { view, focused ->
      lift(view, focused)
      // O design mostra o card focado SEM o selo de resolucao: focado ele ja
      // cresce 3% e ganha contorno, e o selo passaria a disputar a mesma borda.
      val badge = holder.views.cardBadge
      val text = holder.bindingAdapterPosition
        .takeIf { it != RecyclerView.NO_POSITION }
        ?.let { items[it].badge }
      badge.visibility = if (focused || text == null) View.GONE else View.VISIBLE
    }
    return holder
  }

  override fun onBindViewHolder(holder: Holder, position: Int) {
    val card = items[position]
    val views = holder.views

    views.cardName.text = card.name
    views.cardMeta.text = card.meta
    views.cardInitials.text = initialsOf(card.name)
    views.cardChan.text = card.chan
    views.cardBadge.text = card.badge ?: ""
    views.cardBadge.visibility =
      if (card.badge == null || views.card.isFocused) View.GONE else View.VISIBLE

    views.card.nextFocusUpId = focusUpId
    views.card.nextFocusDownId = focusDownId

    holder.job?.cancel()
    holder.job = null

    val path = card.posterUrl
    val width = views.root.resources.getDimensionPixelSize(R.dimen.card_tall_width)

    val ready = if (path == null) null else PosterLoader.cached(path, width)
    showPoster(holder, ready)
    if (path == null || ready != null) return

    // O card ja esta pintado com as iniciais; a capa entra por cima quando (e
    // se) chegar. Nao ha estado de "carregando" na tela: um spinner por card
    // faria a faixa inteira piscar a cada rolagem.
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
    /** 1.03 e o numero do design; acima disso o card come o vizinho da faixa. */
    const val FOCUS_SCALE = 1.03f
    const val FOCUS_MS = 140L
    const val FOCUS_ELEVATION = 16f

    /**
     * O card em foco cresce e sobe. So o contorno de acento nao bastaria: a tres
     * metros de distancia, o que o olho pega e o card maior.
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
