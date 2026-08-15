package com.widetv.app.ui

import android.annotation.SuppressLint
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.recyclerview.widget.RecyclerView
import com.widetv.app.R
import com.widetv.app.databinding.ItemTrackBinding
import com.widetv.app.databinding.ItemTrackHeaderBinding

/**
 * Desenho do painel de trilhas. Nao decide nada: recebe as linhas prontas do
 * reducer e a posicao do cursor.
 *
 * Continua sendo UM RecyclerView com cabecalhos de secao, como o design mostra —
 * as duas listas empilhadas, e o segmented control so leva o cursor de uma para
 * a outra.
 *
 * Nenhuma linha e focavel. O cursor e pintado como `isSelected`, para que as
 * setas cheguem inteiras ao `onKeyDown` da Activity em vez de serem consumidas
 * pela navegacao interna do RecyclerView.
 */
class TrackAdapter : RecyclerView.Adapter<RecyclerView.ViewHolder>() {

  @set:SuppressLint("NotifyDataSetChanged")
  var rows: List<TrackRow> = emptyList()
    set(value) {
      field = value
      notifyDataSetChanged()
    }

  var cursor: Int = 0
    set(value) {
      if (field == value) return
      val previous = field
      field = value
      // Duas linhas mudam de aparencia, e so elas.
      if (previous in rows.indices) notifyItemChanged(previous)
      if (value in rows.indices) notifyItemChanged(value)
    }

  private class HeaderHolder(val views: ItemTrackHeaderBinding) :
    RecyclerView.ViewHolder(views.root)

  private class OptionHolder(val views: ItemTrackBinding) : RecyclerView.ViewHolder(views.root)

  override fun getItemViewType(position: Int): Int =
    if (rows[position] is TrackRow.Header) TYPE_HEADER else TYPE_OPTION

  override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
    val inflater = LayoutInflater.from(parent.context)
    return if (viewType == TYPE_HEADER) {
      HeaderHolder(ItemTrackHeaderBinding.inflate(inflater, parent, false))
    } else {
      OptionHolder(ItemTrackBinding.inflate(inflater, parent, false))
    }
  }

  override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
    when (val row = rows[position]) {
      is TrackRow.Header -> {
        val views = (holder as HeaderHolder).views
        views.trackSection.setText(
          if (row.kind == TrackKind.AUDIO) R.string.tracks_audio else R.string.tracks_subtitles,
        )
      }

      is TrackRow.Option -> {
        val views = (holder as OptionHolder).views
        val option = row.option

        views.trackLabel.text = option.label
        views.trackDetail.text = option.detail ?: ""
        views.trackDetail.visibility =
          if (option.detail.isNullOrEmpty()) View.GONE else View.VISIBLE

        // A faixa que esta soando diz "Tocando"; as outras ficam com a etiqueta
        // do container ("padrao"), quando ha uma.
        val tag = if (option.selected) TAG_PLAYING else option.tag
        views.trackTag.text = tag ?: ""
        views.trackTag.visibility = if (tag.isNullOrEmpty()) View.GONE else View.VISIBLE
        views.trackTag.setTextColor(
          views.root.context.getColor(if (option.selected) R.color.accent else R.color.dim),
        )

        // `isSelected` e a ESCOLHA, e nao o cursor: o `track_radio` copia o
        // estado do pai por `duplicateParentState`, e e ele quem tem que acender
        // na faixa que esta soando. O cursor anda sem trocar faixa nenhuma, e
        // por isso viaja no outro estado.
        views.trackRow.isSelected = option.selected
        views.trackRow.isActivated = position == cursor
      }
    }
  }

  override fun getItemCount(): Int = rows.size

  private companion object {
    const val TYPE_HEADER = 0
    const val TYPE_OPTION = 1
    const val TAG_PLAYING = "Tocando"
  }
}
