package com.widetv.app.ui

import android.annotation.SuppressLint
import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.recyclerview.widget.RecyclerView
import com.widetv.app.R
import com.widetv.app.databinding.ItemTrackBinding
import com.widetv.app.databinding.ItemTrackHeaderBinding

/**
 * Desenho do painel de trilhas. Nao decide nada: recebe as linhas prontas do
 * reducer e a posicao do cursor.
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

  @set:SuppressLint("NotifyDataSetChanged")
  var cursor: Int = 0
    set(value) {
      field = value
      notifyDataSetChanged()
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
        views.trackLabel.text = row.option.label
        views.trackCheck.text = if (row.option.selected) "✓" else ""
        views.root.isSelected = position == cursor
      }
    }
  }

  override fun getItemCount(): Int = rows.size

  private companion object {
    const val TYPE_HEADER = 0
    const val TYPE_OPTION = 1
  }
}
