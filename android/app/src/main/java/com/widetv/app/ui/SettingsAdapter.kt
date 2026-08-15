package com.widetv.app.ui

import android.annotation.SuppressLint
import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.recyclerview.widget.RecyclerView
import com.widetv.app.R
import com.widetv.app.databinding.ItemSettingBinding
import com.widetv.app.net.AppSettings

/**
 * Desenho da tela de configuracoes. Nao decide nada: recebe as linhas do
 * reducer, o estado do cursor e o `AppSettings` que o servidor mandou.
 *
 * Nenhuma linha e focavel, pelo mesmo motivo do painel de trilhas: o cursor e
 * do reducer, e o RecyclerView comeria as setas antes de elas chegarem ao
 * `onKeyDown` da Activity.
 */
class SettingsAdapter : RecyclerView.Adapter<SettingsAdapter.Holder>() {

  private var rows: List<SettingsRow> = emptyList()
  private var state: SettingsUiState = SettingsUiState()
  private var settings: AppSettings? = null

  class Holder(val views: ItemSettingBinding) : RecyclerView.ViewHolder(views.root)

  /**
   * Uma porta so em vez de tres setters: rotulo, valor e cursor mudam juntos a
   * cada tecla, e redesenhar a lista tres vezes por evento seria desperdicio
   * visivel numa TV.
   */
  @SuppressLint("NotifyDataSetChanged")
  fun bind(rows: List<SettingsRow>, state: SettingsUiState, settings: AppSettings?) {
    this.rows = rows
    this.state = state
    this.settings = settings
    notifyDataSetChanged()
  }

  override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder =
    Holder(ItemSettingBinding.inflate(LayoutInflater.from(parent.context), parent, false))

  override fun onBindViewHolder(holder: Holder, position: Int) {
    val row = rows[position]
    val views = holder.views
    val settings = settings

    views.settingLabel.text = settingsRowLabel(row.field)
    views.settingValue.text = when {
      state.busy == row.field -> views.root.context.getString(R.string.settings_busy)
      // Antes de o GET responder a coluna fica vazia: escrever "Desligado" so
      // porque o default do data class e false seria inventar o que o servidor
      // ainda nao disse.
      settings == null -> ""
      else -> settingsRowValue(row.field, settings)
    }

    views.root.isSelected = position == state.cursor
    // A linha de informacao nao e escolhivel; o cinza avisa isso antes de
    // alguem tentar apertar OK nela.
    val dim = row.kind == SettingsKind.INFO
    views.settingLabel.setTextColor(
      views.root.context.getColor(if (dim) R.color.text_dim else R.color.text),
    )
    views.settingValue.setTextColor(
      views.root.context.getColor(if (dim) R.color.text_faint else R.color.accent),
    )
  }

  override fun getItemCount(): Int = rows.size
}
