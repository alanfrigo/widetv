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

export type RemuxReason = 'container' | 'audio';

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

  const chosen = defaultTrack(input.audioTracks);
  const audioNeeds =
    chosen !== null && (chosen.codec === null || !UNIVERSAL.has(chosen.codec));

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
      args.push(`-c:a:${String(position)}`, 'aac', `-b:a:${String(position)}`, AAC_BITRATE);
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
      args.push(`-c:a:${String(position)}`, 'aac', `-b:a:${String(position)}`, AAC_BITRATE);
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
