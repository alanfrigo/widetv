import { extname } from 'node:path';

import type { AudioTrackRef } from '@shared/api-types';

/**
 * Decide se um episodio precisa de remux para tocar no navegador, e monta os
 * argumentos do ffmpeg quando precisa.
 *
 * Remux NAO e transcode de video: o video sai copiado byte a byte (`-c:v copy`)
 * para um container MP4, que e o unico que o `<video>` entende com garantia.
 * A proibicao do projeto continua valendo: nenhum frame e recodificado, entao
 * nao ha perda de qualidade nem CPU de codec de imagem no NAS.
 *
 * Audio segue a regra do "zero perdas": faixa Dolby (ac3/eac3) e copiada
 * bit a bit para dentro do MP4. Como Chrome/Firefox nao licenciam Dolby, uma
 * faixa AAC de compatibilidade e ADICIONADA na frente - a Dolby continua no
 * arquivo, intacta, para os players que a decodificam (Safari, TVs, app
 * nativo). Só codecs que o MP4 nem carrega (dts, truehd, pcm) viram AAC no
 * lugar - e mesmo assim o arquivo original nunca e tocado: o remux vive em
 * DATA_DIR, a biblioteca continua read-only.
 */

/** Codecs de audio que o container MP4 carrega e que vale copiar bit a bit. */
const MP4_COPY_SAFE = new Set(['aac', 'ac3', 'eac3', 'mp3', 'flac', 'alac', 'opus']);

/**
 * Codecs que TODO navegador decodifica. Fora daqui, a faixa default precisa de
 * uma gemea AAC, senao o episodio abre mudo no Chrome.
 */
const UNIVERSAL = new Set(['aac', 'mp3']);

/**
 * Bitrate da faixa AAC gerada. Flat porque o probe nao guarda contagem de
 * canais: 320k e transparente em estereo e aceitavel em 5.1 - e e so a faixa
 * de compatibilidade, a original continua no arquivo.
 */
const AAC_BITRATE = '320k';

/**
 * Toda saida AAC passa por este aformat. Sem ele, eac3/dts 5.1 decodificam
 * para o layout "5.1(side)", que nao tem channelConfiguration padrao no
 * MPEG-4: o encoder aac do ffmpeg grava channelConfiguration=0 + PCE, e o
 * CoreAudio (Safari, AVFoundation, Firefox no macOS) rejeita a faixa inteira
 * - video toca, audio mudo. A lista restringe a layouts com
 * channelConfiguration padrao; 5.1(side) vira 5.1 por remapeamento, sem
 * downmix.
 */
const AAC_CHANNEL_LAYOUTS = 'aformat=channel_layouts=7.1|5.1|stereo|mono';

/**
 * Versao do plano, embutida no nome dos MP4 gerados. Mudou a receita do
 * ffmpeg? Incremente: o nome esperado muda, a rodada seguinte reconverte e o
 * arquivo da versao antiga e apagado. Sem isso, um remux gravado com um plano
 * defeituoso (ex.: v1 gerava AAC com channelConfiguration=0, mudo no Safari)
 * ficaria valido para sempre, porque o cache so olha (mtime, size) do fonte.
 */
export const REMUX_PLAN_VERSION = 2;

/**
 * Codecs de VIDEO que um navegador atual decodifica sem ajuda.
 *
 * A mesma lista de `cli/survey.ts`, agora tambem em runtime. Ela existia so na
 * ferramenta de analise offline, e essa ausencia e um bug real: `planRemux`
 * nunca olhou o codec de video, entao um `.avi` com MPEG-4 Part 2 (DivX/XviD)
 * era servido cru, sem plano, sem 202 e sem diagnostico - o `<video>` morre e a
 * tela diz "Sem sinal", que e indistinguivel de NAS fora do ar.
 *
 * AV1 esta aqui de proposito: Chrome traz o dav1d por software e o ExoPlayer
 * decodifica nativo. HEVC fica de FORA: so toca onde o sistema expoe decoder de
 * hardware, entao prometer que toca seria pior que avisar que talvez nao toque.
 */
const BROWSER_PLAYABLE_VIDEO = new Set(['h264', 'avc1', 'av1', 'av01', 'vp8', 'vp9']);

/** Containers que o `<video>` abre. Fora daqui, o remux precisa trocar a casca. */
const BROWSER_CONTAINERS = new Set(['.mp4', '.m4v', '.webm']);

export type RemuxReason = 'container' | 'audio';

/**
 * O que separa este arquivo de tocar no navegador.
 *
 * - `direct`: sai do disco como esta.
 * - `remux`: container e/ou audio resolvem com copia de bytes - e o que o
 *   `planRemux` faz, e vale a pena esperar.
 * - `video-transcode`: o codec de VIDEO nao toca. Nenhum remux resolve, porque
 *   remux nao recodifica imagem. O arquivo precisa ser reconvertido fora do
 *   servidor (`npm run transcode-legacy`).
 * - `unknown`: sem probe de video. Nao promete nem condena - serve o original e
 *   deixa o navegador tentar.
 */
export type PlaybackVerdict = 'direct' | 'remux' | 'video-transcode' | 'unknown';

export interface PlaybackInput {
  relativePath: string;
  videoCodec: string | null;
  audioTracks: readonly AudioTrackRef[];
}

/**
 * Veredito honesto sobre tocar no NAVEGADOR.
 *
 * Deliberadamente separado de `planRemux`: aquele responde "o que o ffmpeg deve
 * fazer", este responde "o que a pessoa vai ver". Os dois discordam num caso, e
 * e justamente o que estava escondido: para um `.avi` MPEG-4, `planRemux`
 * devolve `null` (nada a fazer) e este devolve `video-transcode` (nao vai
 * tocar). Fundir os dois obrigaria o planejador a inventar um plano que ele nao
 * tem, ou este a mentir que esta tudo bem.
 */
export function playbackVerdict(input: PlaybackInput): PlaybackVerdict {
  if (input.videoCodec === null) return 'unknown';

  const codec = input.videoCodec.toLowerCase();
  // O codec de video vem PRIMEIRO: quando ele nao toca, container e audio sao
  // irrelevantes - trocar a casca de um arquivo que o navegador nao decodifica
  // so produz um arquivo diferente que ele tambem nao decodifica.
  if (!BROWSER_PLAYABLE_VIDEO.has(codec)) return 'video-transcode';

  const extension = extname(input.relativePath).toLowerCase();
  if (!BROWSER_CONTAINERS.has(extension)) return 'remux';

  // WebM sai antes da checagem de audio, como em `planRemux`: `UNIVERSAL` diz
  // "seguro DENTRO de um MP4", nao "o navegador decodifica". Opus e vorbis sao
  // decodificados por todos e sao os codecs legais do proprio WebM - reprova-los
  // aqui mandaria remuxar um arquivo que ja toca.
  if (extension === '.webm') return 'direct';

  if (defaultAudioNeedsCompat(input.audioTracks)) return 'remux';
  return 'direct';
}

interface AudioOutput {
  /** `-map 0:a:N` do arquivo fonte. */
  sourceIndex: number;
  mode: 'copy' | 'aac';
  isDefault: boolean;
  /** So a faixa de compatibilidade ganha titulo proprio. */
  title: string | null;
}

export interface RemuxPlan {
  reason: RemuxReason;
  /** Argumentos entre `-i entrada` e a saida, prontos para o spawn. */
  args: string[];
}

export interface RemuxPlanInput {
  /** Caminho relativo do episodio; a extensao decide o container. */
  relativePath: string;
  videoCodec: string | null;
  /** Faixas do arquivo FONTE, na ordem do container. */
  audioTracks: readonly AudioTrackRef[];
}

/** Faixa que o player liga sozinho: a marcada default, senao a primeira. */
function defaultTrack(tracks: readonly AudioTrackRef[]): AudioTrackRef | null {
  return tracks.find((track) => track.isDefault) ?? tracks[0] ?? null;
}

/**
 * O arquivo ORIGINAL tocaria mudo num navegador sem licenca Dolby? true quando
 * a faixa que o player liga sozinho nao e universal (aac/mp3). E o criterio da
 * rota de stream para responder "preparando" em vez de servir episodio sem som.
 */
export function defaultAudioNeedsCompat(tracks: readonly AudioTrackRef[]): boolean {
  const chosen = defaultTrack(tracks);
  return chosen !== null && (chosen.codec === null || !UNIVERSAL.has(chosen.codec));
}

function planAudioOutputs(tracks: readonly AudioTrackRef[]): AudioOutput[] {
  const chosen = defaultTrack(tracks);

  // Gemea AAC so quando a default e copiavel porem nao-universal (Dolby, flac):
  // se a default ja vai virar AAC no lugar (dts, truehd), ela mesma e a
  // compatibilidade e uma segunda copia seria redundante.
  const needsTwin =
    chosen !== null &&
    chosen.codec !== null &&
    MP4_COPY_SAFE.has(chosen.codec) &&
    !UNIVERSAL.has(chosen.codec);

  const outputs: AudioOutput[] = [];

  if (needsTwin && chosen !== null) {
    outputs.push({
      sourceIndex: chosen.index,
      mode: 'aac',
      isDefault: true,
      // Sem este titulo o painel de trilhas mostraria duas linhas identicas
      // ("Português" duas vezes) sem dizer qual e a Dolby.
      title: chosen.title !== null ? `${chosen.title} (AAC)` : 'AAC',
    });
  }

  for (const track of tracks) {
    // Codec desconhecido nao entra copiado: um mux invalido derrubaria o
    // arquivo inteiro, e AAC pelo menos toca.
    const copyable = track.codec !== null && MP4_COPY_SAFE.has(track.codec);
    outputs.push({
      sourceIndex: track.index,
      mode: copyable ? 'copy' : 'aac',
      isDefault: !needsTwin && track === chosen,
      title: null,
    });
  }

  return outputs;
}

/**
 * @returns null quando o arquivo ja toca direto do disco - ai o remux so
 *          desperdicaria o espaco de uma copia em DATA_DIR.
 */
export function planRemux(input: RemuxPlanInput): RemuxPlan | null {
  const extension = extname(input.relativePath).toLowerCase();

  // WebM e cidadao nativo do navegador; e um MKV sem video (raro, provavel
  // arquivo doente) nao tem o que copiar - melhor servir o original.
  if (extension === '.webm') return null;
  if (input.videoCodec === null) return null;

  const containerNeeds = extension === '.mkv';

  const audioNeeds = defaultAudioNeedsCompat(input.audioTracks);

  if (!containerNeeds && !audioNeeds) return null;

  const outputs = planAudioOutputs(input.audioTracks);

  // `0:V:0` (V maiusculo): o video de verdade, nunca a capa embutida que
  // aparece como stream de video com disposition attached_pic.
  const args: string[] = ['-map', '0:V:0', '-c:v', 'copy'];

  // Safari exige a tag hvc1; ffmpeg copia HEVC de MKV como hev1 por padrao.
  if (input.videoCodec === 'hevc') args.push('-tag:v', 'hvc1');

  outputs.forEach((output, position) => {
    args.push('-map', `0:a:${String(output.sourceIndex)}`);
    if (output.mode === 'copy') {
      args.push(`-c:a:${String(position)}`, 'copy');
    } else {
      args.push(
        `-c:a:${String(position)}`, 'aac',
        `-b:a:${String(position)}`, AAC_BITRATE,
        `-filter:a:${String(position)}`, AAC_CHANNEL_LAYOUTS,
      );
    }
  });

  // Disposition explicita em toda faixa: sem isso o mux herda as flags do MKV
  // e o navegador pode ligar a Dolby - que no Chrome significa episodio mudo.
  outputs.forEach((output, position) => {
    args.push(`-disposition:a:${String(position)}`, output.isDefault ? 'default' : '0');
  });

  const twin = outputs[0];
  if (twin !== undefined && twin.title !== null) {
    args.push('-metadata:s:a:0', `title=${twin.title}`);
  }

  // Legendas ficam de fora de proposito: a rota de legenda extrai do arquivo
  // ORIGINAL, e MP4 nem carrega ASS/PGS. Capitulos vem junto; anexos (fontes)
  // ficam, porque nenhum -map os alcanca.
  args.push('-map_chapters', '0', '-movflags', '+faststart');

  return { reason: containerNeeds ? 'container' : 'audio', args };
}

export interface VariantPlanInput {
  videoCodec: string | null;
  /** Faixas do arquivo FONTE, na ordem do container. */
  audioTracks: readonly AudioTrackRef[];
  /** `index` (relativo) da faixa fonte que o usuario quer ouvir. */
  audioIndex: number;
}

/**
 * Variante de dublagem: MP4 com o mesmo video copiado e SO a faixa de audio
 * escolhida (mais a gemea AAC quando ela nao for universal). E o que torna a
 * troca de dublagem possivel em qualquer navegador - o `<video>` do Chrome nao
 * deixa escolher faixa dentro de um arquivo, entao o servidor entrega um
 * arquivo em que a escolha ja esta feita.
 *
 * Uma faixa por variante de proposito: o custo do arquivo e o video, e repetir
 * as outras dublagens dentro dele so inflaria o disco sem destravar nada.
 *
 * @returns null para indice inexistente ou arquivo sem video - nada a gerar.
 */
export function planAudioVariant(input: VariantPlanInput): RemuxPlan | null {
  if (input.videoCodec === null) return null;
  const track = input.audioTracks.find((candidate) => candidate.index === input.audioIndex);
  if (track === undefined) return null;

  const args: string[] = ['-map', '0:V:0', '-c:v', 'copy'];
  if (input.videoCodec === 'hevc') args.push('-tag:v', 'hvc1');

  // Mesma regra de audio do remux principal, aplicada a uma lista de um item
  // marcado default: gemea AAC na frente quando preciso, copia bit a bit da
  // faixa quando o MP4 a carrega.
  const outputs = planAudioOutputs([{ ...track, isDefault: true }]);
  outputs.forEach((output, position) => {
    args.push('-map', `0:a:${String(output.sourceIndex)}`);
    if (output.mode === 'copy') {
      args.push(`-c:a:${String(position)}`, 'copy');
    } else {
      args.push(
        `-c:a:${String(position)}`, 'aac',
        `-b:a:${String(position)}`, AAC_BITRATE,
        `-filter:a:${String(position)}`, AAC_CHANNEL_LAYOUTS,
      );
    }
  });
  outputs.forEach((output, position) => {
    args.push(`-disposition:a:${String(position)}`, output.isDefault ? 'default' : '0');
  });
  const twin = outputs[0];
  if (twin !== undefined && twin.title !== null) {
    args.push('-metadata:s:a:0', `title=${twin.title}`);
  }

  args.push('-map_chapters', '0', '-movflags', '+faststart');
  return { reason: 'audio', args };
}
