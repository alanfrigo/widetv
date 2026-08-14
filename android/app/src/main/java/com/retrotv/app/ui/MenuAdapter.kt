package com.retrotv.app.ui

import android.annotation.SuppressLint
import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.recyclerview.widget.RecyclerView
import com.retrotv.app.databinding.CrtRowBinding

/**
 * Lista do menu.
 *
 * Reaproveita a linha do painel de servico: ja e focavel, ja acende no foco e
 * ja tem a tipografia de fosforo. Duas colunas dao conta dos dois niveis —
 * canal e contagem, episodio e selo de resolucao —, entao nao ha layout novo.
 */
class MenuAdapter(
  private val onActivate: (Int) -> Unit,
) : RecyclerView.Adapter<MenuAdapter.RowHolder>() {

  data class Row(val label: String, val value: String)

  /**
   * Lista inteira de uma vez. Sao dezenas de linhas trocadas em bloco na
   * mudanca de nivel, nunca uma edicao pontual: diff aqui seria maquinario sem
   * nada para diferenciar.
   */
  @set:SuppressLint("NotifyDataSetChanged")
  var rows: List<Row> = emptyList()
    set(value) {
      field = value
      notifyDataSetChanged()
    }

  class RowHolder(val views: CrtRowBinding) : RecyclerView.ViewHolder(views.root)

  override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RowHolder {
    val views = CrtRowBinding.inflate(LayoutInflater.from(parent.context), parent, false)
    val holder = RowHolder(views)
    views.root.setOnClickListener {
      val position = holder.bindingAdapterPosition
      if (position != RecyclerView.NO_POSITION) onActivate(position)
    }
    return holder
  }

  override fun onBindViewHolder(holder: RowHolder, position: Int) {
    val row = rows[position]
    holder.views.rowLabel.text = row.label
    holder.views.rowValue.text = row.value
  }

  override fun getItemCount(): Int = rows.size
}
