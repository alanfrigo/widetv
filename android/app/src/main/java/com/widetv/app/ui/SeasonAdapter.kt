package com.widetv.app.ui

import android.annotation.SuppressLint
import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.recyclerview.widget.RecyclerView
import com.widetv.app.databinding.ItemSeasonBinding

/**
 * Barra de abas de temporada da tela de serie.
 *
 * As abas sao focaveis: uma faixa horizontal de botoes homogeneos e o caso que o
 * foco nativo resolve sozinho, e a seta para baixo cai na lista de episodios.
 * A marca de "ativa" e `isSelected`, separada do foco de proposito — dar uma
 * volta pelas abas com a seta nao pode trocar a temporada que esta na tela.
 */
class SeasonAdapter(
  private val onPick: (Int) -> Unit,
) : RecyclerView.Adapter<SeasonAdapter.Holder>() {

  @set:SuppressLint("NotifyDataSetChanged")
  var items: List<SeasonTab> = emptyList()
    set(value) {
      field = value
      notifyDataSetChanged()
    }

  /** Posicao da aba ativa em `items`. */
  var selected: Int = 0
    set(value) {
      if (field == value) return
      val previous = field
      field = value
      // Duas linhas mudam, e so elas: redesenhar a barra inteira para mover uma
      // marca faria as abas piscarem a cada seta.
      if (previous in items.indices) notifyItemChanged(previous)
      if (value in items.indices) notifyItemChanged(value)
    }

  class Holder(val views: ItemSeasonBinding) : RecyclerView.ViewHolder(views.root)

  override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder {
    val views = ItemSeasonBinding.inflate(LayoutInflater.from(parent.context), parent, false)
    val holder = Holder(views)
    views.seasonTab.setOnClickListener {
      val position = holder.bindingAdapterPosition
      if (position != RecyclerView.NO_POSITION) onPick(position)
    }
    return holder
  }

  override fun onBindViewHolder(holder: Holder, position: Int) {
    holder.views.seasonTab.text = items[position].label
    holder.views.seasonTab.isSelected = position == selected
  }

  override fun getItemCount(): Int = items.size
}
