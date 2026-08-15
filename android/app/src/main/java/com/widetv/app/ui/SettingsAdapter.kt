package com.widetv.app.ui

import android.annotation.SuppressLint
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.recyclerview.widget.RecyclerView
import com.widetv.app.R
import com.widetv.app.databinding.ItemSettingBinding
import com.widetv.app.net.AppSettings

/**
 * Desenho de UMA das duas listas de configuracao. Nao decide nada: recebe as
 * linhas do grupo, o estado do cursor UNICO e o `AppSettings` do servidor.
 *
 * O cursor continua sendo um so, percorrendo os dois grupos na ordem de
 * `settingsRows()`; `start` e onde este grupo comeca nessa contagem. E por isso
 * que a seta para baixo sai da ultima linha de Reproducao e cai na primeira de
 * Biblioteca sem que nenhuma das duas listas saiba da outra.
 *
 * Nenhuma linha e focavel, pelo mesmo motivo do painel de trilhas: o cursor e do
 * reducer, e o RecyclerView comeria as setas antes de elas chegarem ao
 * `onKeyDown` da Activity.
 */
class SettingsAdapter(private val group: SettingsGroup) :
  RecyclerView.Adapter<SettingsAdapter.Holder>() {

  private val rows: List<SettingsRow> = settingsRows(group)
  private val start: Int = settingsGroupStart(group)
  private var state: SettingsUiState = SettingsUiState()
  private var settings: AppSettings? = null

  class Holder(val views: ItemSettingBinding) : RecyclerView.ViewHolder(views.root)

  /**
   * Uma porta so em vez de dois setters: valor e cursor mudam juntos a cada
   * tecla, e redesenhar a lista duas vezes por evento seria desperdicio visivel
   * numa TV.
   */
  @SuppressLint("NotifyDataSetChanged")
  fun bind(state: SettingsUiState, settings: AppSettings?) {
    this.state = state
    this.settings = settings
    notifyDataSetChanged()
  }

  /** Posicao do cursor DENTRO desta lista, ou -1 quando ele esta na outra. */
  fun cursorInGroup(state: SettingsUiState): Int {
    val local = state.cursor - start
    return if (local in rows.indices) local else -1
  }

  override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder =
    Holder(ItemSettingBinding.inflate(LayoutInflater.from(parent.context), parent, false))

  override fun onBindViewHolder(holder: Holder, position: Int) {
    val row = rows[position]
    val views = holder.views
    val settings = settings
    val onCursor = start + position == state.cursor

    views.settingLabel.text = settingsRowLabel(row.field)
    views.settingHint.text = settingsRowHint(row.field)
    views.settingValue.text = when {
      state.busy == row.field -> views.root.context.getString(R.string.settings_busy)
      // Antes de o GET responder a coluna fica vazia: escrever "Desligado" so
      // porque o default do data class e false seria inventar o que o servidor
      // ainda nao disse.
      settings == null -> ""
      else -> settingsRowValue(row.field, settings, state.thumbsReset)
    }

    views.settingRow.isSelected = onCursor

    // As setas so aparecem na linha do cursor, e a da esquerda so onde ha valor
    // para voltar. Acao NAO implica "sem setas": a geracao de quadros e acao e
    // escolhe o modo com ← →, e quem sabe disso e o reducer, pela marca
    // `stepper` da linha — nao o tipo dela.
    views.settingArrowLeft.visibility = vis(onCursor && row.stepper)
    views.settingArrowRight.visibility = vis(onCursor && row.kind != SettingsKind.INFO)

    // A linha de informacao nao e escolhivel; o cinza avisa isso antes de
    // alguem tentar apertar OK nela.
    val dim = row.kind == SettingsKind.INFO
    views.settingLabel.setTextColor(
      views.root.context.getColor(if (dim) R.color.muted else R.color.text),
    )
    views.settingValue.setTextColor(
      views.root.context.getColor(
        when {
          dim -> R.color.dim
          onCursor -> R.color.accent
          else -> R.color.text_2
        },
      ),
    )
  }

  override fun getItemCount(): Int = rows.size

  private fun vis(visible: Boolean) = if (visible) View.VISIBLE else View.INVISIBLE
}
