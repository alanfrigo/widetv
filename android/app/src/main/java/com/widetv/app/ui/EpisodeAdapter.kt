package com.widetv.app.ui

import android.annotation.SuppressLint
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.recyclerview.widget.RecyclerView
import com.widetv.app.databinding.ItemEpisodeBinding
import com.widetv.app.net.EpisodeRef

/**
 * Catalogo de uma serie: uma linha por episodio.
 *
 * O foco aqui e o nativo do RecyclerView — sao linhas homogeneas numa coluna so,
 * exatamente o caso para o qual o sistema de foco do Android ja funciona. (O
 * painel de trilhas nao pode fazer o mesmo porque mistura cabecalhos.)
 */
class EpisodeAdapter(
  private val onPlay: (Int) -> Unit,
) : RecyclerView.Adapter<EpisodeAdapter.Holder>() {

  @set:SuppressLint("NotifyDataSetChanged")
  var items: List<EpisodeRef> = emptyList()
    set(value) {
      field = value
      notifyDataSetChanged()
    }

  class Holder(val views: ItemEpisodeBinding) : RecyclerView.ViewHolder(views.root)

  override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder {
    val views = ItemEpisodeBinding.inflate(LayoutInflater.from(parent.context), parent, false)
    val holder = Holder(views)
    views.root.setOnClickListener {
      val position = holder.bindingAdapterPosition
      if (position != RecyclerView.NO_POSITION) onPlay(position)
    }
    return holder
  }

  override fun onBindViewHolder(holder: Holder, position: Int) {
    val episode = items[position]
    val views = holder.views

    // Sem numeracao a coluna fica vazia em vez de repetir o titulo ao lado dele.
    views.episodeCode.text = formatEpisodeCode(episode) ?: ""
    views.episodeTitle.text = episode.title
    views.episodeDuration.text = formatDuration(episode.durationMs)

    val badge = formatResolutionBadge(episode.height)
    views.episodeBadge.text = badge ?: ""
    views.episodeBadge.visibility = if (badge == null) View.GONE else View.VISIBLE
  }

  override fun getItemCount(): Int = items.size
}
