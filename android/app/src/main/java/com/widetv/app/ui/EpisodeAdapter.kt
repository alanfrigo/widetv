package com.widetv.app.ui

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.recyclerview.widget.RecyclerView
import com.widetv.app.R
import com.widetv.app.databinding.ItemEpisodeBinding
import com.widetv.app.net.ApiClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/**
 * Catalogo de uma serie: uma linha por episodio da temporada aberta.
 *
 * O foco aqui e o nativo do RecyclerView — sao linhas homogeneas numa coluna so,
 * exatamente o caso para o qual o sistema de foco do Android ja funciona. (O
 * painel de trilhas nao pode fazer o mesmo porque mistura cabecalhos.)
 *
 * O adapter recebe `EpisodeItem` ja escrito por `Seasons.kt`: numero, duracao,
 * selos e estado sao decisao, e decisao nao mora em ViewHolder.
 *
 * A miniatura e carregada por linha, com o `Job` guardado no ViewHolder — mesmo
 * desenho dos dois adapters de card. Aqui ele importa mais do que la: uma
 * temporada de 200 episodios recicla linha atras de linha ao rolar, e sem
 * cancelar cada uma delas continuaria baixando um quadro que ninguem mais vai
 * ver, engasgando a rolagem justo enquanto o dedo segura a seta.
 */
class EpisodeAdapter(
  private val scope: CoroutineScope,
  private val api: ApiClient,
  /** Recebe o indice na lista INTEIRA do canal, nao a posicao na aba. */
  private val onPlay: (Int) -> Unit,
) : RecyclerView.Adapter<EpisodeAdapter.Holder>() {

  @set:SuppressLint("NotifyDataSetChanged")
  var items: List<EpisodeItem> = emptyList()
    set(value) {
      field = value
      notifyDataSetChanged()
    }

  class Holder(val views: ItemEpisodeBinding) : RecyclerView.ViewHolder(views.root) {
    var job: Job? = null
  }

  override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder {
    val views = ItemEpisodeBinding.inflate(LayoutInflater.from(parent.context), parent, false)
    views.episodeArt.clipToOutline = true

    val holder = Holder(views)
    val play = {
      val position = holder.bindingAdapterPosition
      if (position != RecyclerView.NO_POSITION) onPlay(items[position].index)
    }
    views.episodeRow.setOnClickListener { play() }
    // O botao redondo tambem toca, mas nao rouba o foco da linha: no controle
    // remoto ha um alvo so por linha, e dois pararia a seta no meio dela.
    views.episodePlay.setOnClickListener { play() }
    return holder
  }

  override fun onBindViewHolder(holder: Holder, position: Int) {
    val item = items[position]
    val views = holder.views

    views.episodeN.text = item.number
    views.episodeTitle.text = item.title
    views.episodeMetaDuration.text = item.duration
    views.episodeBar.progress = item.progress
    views.episodeBar.visibility = vis(item.progress > 0)

    views.episodeBadge.text = item.badge ?: ""
    views.episodeBadge.visibility = vis(item.badge != null)
    views.episodeTracks.text = item.tracks ?: ""
    views.episodeTracks.visibility = vis(item.tracks != null)
    views.episodeState.text = item.state
    views.episodeState.visibility = vis(item.state.isNotEmpty())

    holder.job?.cancel()
    holder.job = null

    val path = item.thumbUrl
    val width = views.root.resources.getDimensionPixelSize(R.dimen.ep_thumb_w)
    // Mesma conta do `WideFrame`, que tira a altura da largura no `onMeasure`:
    // pedir a altura da view aqui daria 0 na primeira passada do layout.
    val height = width * 9 / 16

    val ready = if (path == null) null else PosterLoader.cached(path, width, height)
    showThumb(holder, ready)
    if (path == null || ready != null) return

    // A linha ja esta pintada com o listrado; o quadro entra por cima quando (e
    // se) chegar. Servidor sem o quadro responde 404, `PosterLoader` devolve
    // null e nao ha nada a dizer: 404 aqui e "ainda nao gerei", nao erro.
    holder.job = scope.launch {
      val bitmap = PosterLoader.load(api, path, width, height)
      if (holder.bindingAdapterPosition == position) showThumb(holder, bitmap)
    }
  }

  override fun onViewRecycled(holder: Holder) {
    holder.job?.cancel()
    holder.job = null
    showThumb(holder, null)
  }

  override fun getItemCount(): Int = items.size

  /**
   * O listrado e o `background` da propria `ImageView`: sem bitmap ele aparece
   * sozinho, e nao ha view de placeholder para esconder.
   */
  private fun showThumb(holder: Holder, bitmap: Bitmap?) {
    holder.views.episodeArt.setImageBitmap(bitmap)
  }

  private fun vis(visible: Boolean) = if (visible) View.VISIBLE else View.GONE
}
