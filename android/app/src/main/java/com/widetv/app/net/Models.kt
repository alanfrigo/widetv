package com.widetv.app.net

import kotlinx.serialization.Serializable

/**
 * Espelho de `src/shared/api-types.ts`.
 *
 * O contrato pertence ao TypeScript; este arquivo segue. Campo que mudar la tem
 * que mudar aqui. Todo campo opcional tem default: um servidor mais antigo que
 * nao manda o campo nao pode derrubar a desserializacao inteira.
 */

@Serializable
data class ChannelSummary(
  /** Numero sintonizavel, estavel entre rescans. */
  val number: Int,
  val name: String,
  val episodeCount: Int,
  /**
   * Rota da capa (`api/channels/<number>/poster`), ou null quando o servidor
   * ainda nao tem capa. Default null de proposito: um servidor mais antigo nao
   * manda o campo, e a lista de canais tem que continuar carregando.
   */
  val posterUrl: String? = null,
  /** Ano de estreia; null quando desconhecido. */
  val year: Int? = null,
  /** Sinopse em texto puro, ja sem HTML; null quando desconhecida. */
  val overview: String? = null,
)

/**
 * Faixa de audio embutida. `index` e a posicao RELATIVA entre os audios
 * (0-based), na ordem do container - nao o indice do stream no arquivo.
 */
@Serializable
data class AudioTrackRef(
  val index: Int,
  /** tag language do container (ISO 639-2), ex. "por". */
  val lang: String? = null,
  /** tag title, ex. "Brazilian". */
  val title: String? = null,
  /** ex. "eac3". */
  val codec: String? = null,
  val isDefault: Boolean = false,
)

/** Legenda embutida. `index` relativo entre legendas (0-based). */
@Serializable
data class SubtitleTrackRef(
  val index: Int,
  val lang: String? = null,
  val title: String? = null,
  /** ex. "subrip". */
  val codec: String? = null,
  val isDefault: Boolean = false,
  val forced: Boolean = false,
)

@Serializable
data class EpisodeRef(
  val id: String,
  val title: String,
  /** null quando a serie nao usa pastas de temporada. */
  val season: Int? = null,
  /** null quando o numero do episodio nao pode ser extraido do nome. */
  val episode: Int? = null,
  val durationMs: Long,
  /** Largura/altura do video em px; null quando o probe nao descobriu. */
  val width: Int? = null,
  /** Largura/altura do video em px; null quando o probe nao descobriu. */
  val height: Int? = null,
  /**
   * Trilhas embutidas. Default vazio de proposito: um servidor mais antigo nao
   * manda os campos, e o app tem que continuar tocando o episodio do mesmo
   * jeito, so sem menu de audio/legenda.
   */
  val audioTracks: List<AudioTrackRef> = emptyList(),
  val subtitleTracks: List<SubtitleTrackRef> = emptyList(),
)

/**
 * Estado do canal no instante `serverTimeMs`. O cliente usa `serverTimeMs` para
 * calcular o desvio do proprio relogio e projetar `offsetMs` adiante.
 */
@Serializable
data class NowPlaying(
  val channel: ChannelSummary,
  val episode: EpisodeRef,
  /** Posicao dentro de `episode`, em ms, valida no instante `serverTimeMs`. */
  val offsetMs: Long,
  /** Relogio do servidor (epoch ms) no momento do calculo. */
  val serverTimeMs: Long,
  /** Epoch ms em que `episode` termina e `next` comeca. */
  val endsAtMs: Long,
  /** Proximo episodio da grade; volta ao inicio quando a serie termina. */
  val next: EpisodeRef,
)

/** Rotas do objeto `API` em `api-types.ts`. */
object Routes {
  const val LOGIN = "api/auth/login"
  const val LOGOUT = "api/auth/logout"
  const val SESSION = "api/auth/session"
  const val CHANNELS = "api/channels"

  fun now(channelNumber: Int): String = "api/channels/$channelNumber/now"

  fun episodes(channelNumber: Int): String = "api/channels/$channelNumber/episodes"

  /** Capa do canal em JPEG; e para onde `ChannelSummary.posterUrl` aponta. */
  fun poster(channelNumber: Int): String = "api/channels/$channelNumber/poster"

  /**
   * Prefixo do stream. O id do episodio e um caminho relativo com barras
   * ("Serie/Temporada 1/ep01.mp4") e entra como UM segmento percent-encoded,
   * exatamente como o `encodeURIComponent` do cliente web.
   */
  const val STREAM = "api/stream"

  /**
   * Sufixo da legenda em WebVTT, colado DEPOIS do segmento do id:
   * `api/stream/<id percent-encoded>/subtitle/<track>`. Fica separado do
   * `STREAM` porque so o id e um segmento unico com as barras escapadas.
   *
   * `track` e o `index` de `EpisodeRef.subtitleTracks`.
   */
  fun subtitle(track: Int): String = "subtitle/$track"
}
