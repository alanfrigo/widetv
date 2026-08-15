package com.widetv.app.net

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

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

/* --- configuracoes -------------------------------------------------------- */

/**
 * Preferencias do servidor, editaveis na tela de configuracoes.
 *
 * Moram no servidor, e nao no `Store`, porque a casa toda usa a mesma senha e as
 * mesmas telas: escolher "audio em portugues" na TV da sala tem que valer no
 * tablet. O `Store` continua guardando as duas de idioma, mas como CACHE.
 */
@Serializable
data class AppSettings(
  /** Dublagem preferida, canonica em ISO 639-2/B. null = vale a faixa default. */
  val audioLang: String? = null,
  /** Legenda preferida, canonica. **null = legendas desativadas**. */
  val subtitleLang: String? = null,
  val subtitlesAuto: Boolean = false,
  /** `HH:MM` LOCAL do rescan diario; null = desligado. */
  val rescanTime: String? = null,
  val autoRemux: Boolean = false,
  /**
   * Junta pastas de release da mesma serie num canal so. Default false de
   * proposito: um servidor que nao manda o campo nao agrupa nada, e desenhar
   * "Ligado" seria descrever um comportamento que aquele servidor nao tem.
   */
  val smartGrouping: Boolean = false,
  /** So leitura: o servidor tem `TMDB_API_KEY`. Muda a qualidade das capas. */
  val tmdbConfigured: Boolean = false,
)

/**
 * Corpo do PATCH de `/api/settings`, montado como JSON explicito.
 *
 * NAO e um data class de campos opcionais, e a razao e o contrato: ele tem duas
 * ausencias DIFERENTES. Chave fora do objeto significa "nao mexe neste campo";
 * `subtitleLang: null` significa "desativa as legendas". Um data class com
 * defaults null serializa as duas do mesmo jeito — ou omite ambas, ou manda
 * null em ambas —, e a escolha de desligar a legenda viraria "nao mexe".
 *
 * Uma funcao por campo porque a tela sempre manda UMA linha por vez: o PATCH
 * carrega so o que o dono acabou de mudar, entao nunca ha o que combinar.
 */
object SettingsPatch {
  fun audioLang(value: String?): JsonObject = text("audioLang", value)

  fun subtitleLang(value: String?): JsonObject = text("subtitleLang", value)

  fun rescanTime(value: String?): JsonObject = text("rescanTime", value)

  fun subtitlesAuto(value: Boolean): JsonObject = flag("subtitlesAuto", value)

  fun autoRemux(value: Boolean): JsonObject = flag("autoRemux", value)

  fun smartGrouping(value: Boolean): JsonObject = flag("smartGrouping", value)

  private fun text(key: String, value: String?): JsonObject = buildJsonObject {
    put(key, if (value == null) JsonNull else JsonPrimitive(value))
  }

  private fun flag(key: String, value: Boolean): JsonObject = buildJsonObject {
    put(key, JsonPrimitive(value))
  }
}

/* --- manutencao da biblioteca --------------------------------------------- */

/**
 * Valores de `LibraryTaskState`. String crua, e nao enum: um estado novo no
 * servidor derrubaria a desserializacao do status inteiro, e o app perderia
 * ate o progresso que sabia mostrar.
 */
const val TASK_IDLE = "idle"

const val TASK_RUNNING = "running"

/** Valores de `ScanMode`. */
const val SCAN_MODE_INCREMENTAL = "incremental"

const val SCAN_MODE_FULL = "full"

@Serializable
data class ScanProgressRef(
  val done: Int = 0,
  val total: Int = 0,
  /** Serie sendo medida agora. */
  val show: String = "",
)

/** Resultado da ultima varredura desta instancia do servidor. */
@Serializable
data class ScanSummary(
  val shows: Int = 0,
  val episodes: Int = 0,
  val probed: Int = 0,
  val cached: Int = 0,
  val removedShows: Int = 0,
  val removedEpisodes: Int = 0,
  val failed: Int = 0,
  val durationMs: Long = 0,
  val finishedAt: Long = 0,
  /** Mensagem quando a rodada morreu no meio; null quando terminou inteira. */
  val error: String? = null,
)

@Serializable
data class MetadataSummary(
  val considered: Int = 0,
  val found: Int = 0,
  val posters: Int = 0,
  val notFound: Int = 0,
  val failed: Int = 0,
  val finishedAt: Long = 0,
)

/**
 * As tres tarefas de fundo sao objetos anonimos no TypeScript; aqui precisam de
 * nome. Todo campo tem default para o status continuar legivel quando o
 * servidor conhece so parte deles.
 */
@Serializable
data class ScanTask(
  val state: String = TASK_IDLE,
  /** null quando parado ou antes do primeiro progresso. */
  val progress: ScanProgressRef? = null,
  val startedAt: Long? = null,
  /** null quando nenhuma rodada terminou desde que o servidor subiu. */
  val last: ScanSummary? = null,
)

@Serializable
data class MetadataTask(
  val state: String = TASK_IDLE,
  val last: MetadataSummary? = null,
)

@Serializable
data class RemuxTask(val state: String = TASK_IDLE)

/** Estado das tarefas de fundo. E o que a tela de configuracoes consulta. */
@Serializable
data class LibraryStatus(
  val scan: ScanTask = ScanTask(),
  val metadata: MetadataTask = MetadataTask(),
  val remux: RemuxTask = RemuxTask(),
)

@Serializable
data class ScanRequest(val mode: String = SCAN_MODE_INCREMENTAL)

@Serializable
data class MetadataRefreshRequest(val reset: Boolean = false)

/** Resposta de quem dispara tarefa de fundo: 202 quando aceitou, 409 se ja rodava. */
@Serializable
data class TaskAccepted(
  val started: Boolean = false,
  /** Motivo quando `started` e false, ex. "scan ja esta em andamento". */
  val reason: String? = null,
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

  const val SETTINGS = "api/settings"
  const val LIBRARY_STATUS = "api/library/status"
  const val LIBRARY_SCAN = "api/library/scan"
  const val LIBRARY_METADATA = "api/library/metadata"
}
