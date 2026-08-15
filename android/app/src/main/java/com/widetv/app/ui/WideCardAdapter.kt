package com.widetv.app.ui

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.recyclerview.widget.RecyclerView
import com.widetv.app.R
import com.widetv.app.databinding.ItemCardWideBinding
import com.widetv.app.net.ApiClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/**
 * As duas faixas 16:9 do catalogo: "No ar agora" e "Continuar assistindo".
 *
 * Um adapter para as duas porque o card e o MESMO — muda o que esta preenchido
 * dentro dele, e isso ja vem decidido no `WideCard`. Dois adapters exigiriam
 * dois layouts identicos e duas copias do carregamento de arte.
 *
 * A arte e carregada por card, com o `Job` guardado no ViewHolder: rolar rapido
 * recicla dezenas de cards, e sem cancelar cada um deles continuaria baixando
 * uma imagem que ninguem mais vai ver.
 */
class WideCardAdapter(
  private val scope: CoroutineScope,
  private val api: ApiClient,
  private val onOpen: (WideCard) -> Unit,
) : RecyclerView.Adapter<WideCardAdapter.Holder>() {

  /**
   * Lista inteira de uma vez: a faixa chega pronta do servidor e so muda em
   * bloco (login, rescan, tique do relogio). Diff aqui seria maquinario sem nada
   * para diferenciar.
   */
  @set:SuppressLint("NotifyDataSetChanged")
  var items: List<WideCard> = emptyList()
    set(value) {
      field = value
      notifyDataSetChanged()
    }

  /**
   * Vizinhos verticais do D-pad, resolvidos em runtime.
   *
   * Nao dao para ficar no XML: qual faixa esta acima depende de quais faixas
   * existem nesta sessao, e "Continuar assistindo" some quando nao ha historico.
   */
  private var focusUpId: Int = View.NO_ID
  private var focusDownId: Int = View.NO_ID

  fun wireFocus(upId: Int, downId: Int) {
    if (upId == focusUpId && downId == focusDownId) return
    focusUpId = upId
    focusDownId = downId
    notifyItemRangeChanged(0, itemCount)
  }

  class Holder(val views: ItemCardWideBinding) : RecyclerView.ViewHolder(views.root) {
    var job: Job? = null
  }

  override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder {
    val views = ItemCardWideBinding.inflate(LayoutInflater.from(parent.context), parent, false)
    // Arredondar a arte: o `background` do quadro ja tem raio, e o clip faz a
    // imagem obedecer a ele sem precisar de bitmap mascarado.
    views.cardArt.clipToOutline = true

    val holder = Holder(views)
    views.card.setOnClickListener {
      val position = holder.bindingAdapterPosition
      if (position != RecyclerView.NO_POSITION) onOpen(items[position])
    }
    return holder
  }

  override fun onBindViewHolder(holder: Holder, position: Int) {
    val card = items[position]
    val views = holder.views

    views.cardName.text = card.name
    views.cardSub.text = card.sub

    views.cardTime.text = card.time ?: ""
    views.cardTime.visibility = vis(card.time != null)
    views.cardChan.text = card.chan ?: ""
    views.cardChan.visibility = vis(card.chan != null)
    views.cardLive.visibility = vis(card.live)
    views.cardPlay.visibility = vis(card.play)
    views.cardLeft.text = card.left ?: ""
    views.cardLeft.visibility = vis(card.left != null)
    // Barra sem progresso nenhum e um risco cinza atravessado na arte: some.
    views.cardBar.progress = card.progress
    views.cardBar.visibility = vis(card.progress > 0)

    views.card.nextFocusUpId = focusUpId
    views.card.nextFocusDownId = focusDownId

    holder.job?.cancel()
    holder.job = null

    val path = card.artUrl
    val resources = views.root.resources
    val width = resources.getDimensionPixelSize(R.dimen.card_wide_width)
    val height = width * 9 / 16

    val ready = if (path == null) null else PosterLoader.cached(path, width, height)
    showArt(holder, ready)
    if (path == null || ready != null) return

    // O card ja esta pintado com o padrao listrado; a arte entra por cima quando
    // (e se) chegar. Nao ha estado de "carregando" na tela: um spinner por card
    // faria a faixa inteira piscar a cada rolagem.
    holder.job = scope.launch {
      val bitmap = PosterLoader.load(api, path, width, height)
      if (holder.bindingAdapterPosition == position) showArt(holder, bitmap)
    }
  }

  override fun onViewRecycled(holder: Holder) {
    holder.job?.cancel()
    holder.job = null
    showArt(holder, null)
  }

  override fun getItemCount(): Int = items.size

  private fun showArt(holder: Holder, bitmap: Bitmap?) {
    holder.views.cardImg.setImageBitmap(bitmap)
    holder.views.cardImg.visibility = vis(bitmap != null)
    holder.views.cardGhost.visibility = vis(bitmap == null)
  }

  private fun vis(visible: Boolean) = if (visible) View.VISIBLE else View.GONE
}
