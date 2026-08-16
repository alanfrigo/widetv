import { extname } from 'node:path';

import type { AudioTrackRef } from '@shared/api-types';

/**
 * Plano de RECONVERSAO de arquivos que nenhum remux salva.
 *
 * Este e o unico lugar do projeto onde o video e recodificado, e a excecao tem
 * um motivo estreito: um acervo com MPEG-4 Part 2 (DivX/XviD dos rips antigos)
 * nao toca em navegador nenhum, e trocar o container nao muda isso - remux
 * copia bytes, nao decodifica imagem. Ou o arquivo e reconvertido, ou aquelas
 * temporadas simplesmente nao existem na web.
 *
 * Por isso NADA aqui roda sozinho. Nao ha gatilho no scan, no boot nem no
 * controlador: quem chama e uma pessoa, pela linha de comando, com uma flag
 * explicita. A invariante "o servidor nunca escreve na biblioteca" continua de
 * pe - o unico processo que escreve la e um humano que decidiu escrever.
 *
 * Puro de proposito: decide e monta argumentos, nao executa. Mesma divisao de
 * `remux-plan.ts` x `remux-job.ts`.
 */

/**
 * Codecs de video que valem reconverter.
 *
 * Lista de INCLUSAO, e nao "tudo que nao e h264": um AV1 ou um VP9 que o
 * navegador toca nao pode entrar nesta fila por engano, e um HEVC - que toca
 * onde ha decoder de hardware, inclusive na TV Android - seria degradado sem
 * necessidade. Aqui so entram formatos que ninguem mais decodifica.
 */
const LEGACY_VIDEO = new Set(['mpeg4', 'msmpeg4v1', 'msmpeg4v2', 'msmpeg4v3', 'mpeg2video', 'mpeg1video', 'wmv1', 'wmv2', 'wmv3', 'vc1', 'h263', 'flv1', 'rv10', 'rv20', 'rv30', 'rv40', 'svq1', 'svq3']);

/** Codecs de audio que o MP4 carrega e o navegador decodifica: copia direta. */
const AUDIO_COPY_SAFE = new Set(['aac', 'mp3']);

/**
 * Versao da receita. Entra no relatorio, nao no nome do arquivo: aqui o
 * resultado SUBSTITUI o original a pedido da pessoa, e reconverter em massa
 * porque um numero mudou seria exatamente o que este projeto evita.
 */
export const TRANSCODE_PLAN_VERSION = 1;

export interface TranscodeCandidateInput {
  relativePath: string;
  videoCodec: string | null;
  audioTracks: readonly AudioTrackRef[];
}

export interface TranscodePlan {
  /** Argumentos entre `-i entrada` e a saida, prontos para o spawn. */
  args: string[];
  /** Faixas de audio copiadas bit a bit (nenhuma perda). */
  audioCopied: number;
  /** Faixas recodificadas para AAC porque o MP4 nao as carrega. */
  audioTranscoded: number;
}

/** O arquivo precisa de reconversao de VIDEO para tocar num navegador? */
export function isLegacyVideo(videoCodec: string | null): boolean {
  return videoCodec !== null && LEGACY_VIDEO.has(videoCodec.toLowerCase());
}

/**
 * Nome do arquivo convertido, ao LADO do original.
 *
 * Escreve ao lado, e nao por cima: a conversao demora minutos e pode ser
 * interrompida (Ctrl-C, container reiniciado, disco cheio). Gravar sobre o
 * fonte transformaria qualquer uma dessas em perda definitiva do episodio.
 */
export function transcodeOutputPath(sourcePath: string): string {
  return `${sourcePath.slice(0, sourcePath.length - extname(sourcePath).length)}.h264.mp4`;
}

/**
 * Receita da reconversao.
 *
 * - `-crf 20 -tune animation`: 20 e nao 23 porque a perda aqui e IRREVERSIVEL
 *   quando a pessoa usa `--replace`. Os ~40 % de arquivo a mais compram a
 *   diferenca entre "igual ao original" e "banding no ceu que nunca mais sai".
 *   `animation` porque a fonte tipica deste caminho e desenho: menos bits em
 *   grao inexistente, mais em bordas chapadas.
 * - `-preset veryfast`: o gargalo aqui e o acervo inteiro, nao o arquivo. Um
 *   preset lento renderia ~15 % de tamanho e multiplicaria por 5 um lote que ja
 *   leva horas.
 * - audio mp3/aac sai COPIADO: os dois cabem no MP4 e todo navegador decodifica.
 *   Recodificar seria perda gratuita na unica coisa que nao precisava mudar.
 * - `-map 0:V:0` e `-map 0:a` (todas as faixas): o acervo antigo e dual, e uma
 *   conversao que perdesse a dublagem seria pior que o problema original.
 *
 * @returns null quando o arquivo nao e candidato - nao ha o que planejar.
 */
export function planTranscode(input: TranscodeCandidateInput): TranscodePlan | null {
  if (!isLegacyVideo(input.videoCodec)) return null;

  const args: string[] = [
    // `0:V:0` (V maiusculo): o video de verdade, nunca a capa embutida.
    '-map', '0:V:0',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    '-tune', 'animation',
    // Rips antigos trazem dimensao impar; o yuv420p do x264 exige par, e sem
    // isto o ffmpeg falha no meio do lote em vez de no comeco.
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-pix_fmt', 'yuv420p',
  ];

  let audioCopied = 0;
  let audioTranscoded = 0;

  input.audioTracks.forEach((track, position) => {
    args.push('-map', `0:a:${String(track.index)}`);
    const copyable = track.codec !== null && AUDIO_COPY_SAFE.has(track.codec.toLowerCase());
    if (copyable) {
      args.push(`-c:a:${String(position)}`, 'copy');
      audioCopied += 1;
    } else {
      args.push(`-c:a:${String(position)}`, 'aac', `-b:a:${String(position)}`, '192k');
      audioTranscoded += 1;
    }
  });

  // Sem faixa nenhuma no indice: manda o ffmpeg pegar o que houver, em vez de
  // gerar um arquivo mudo a partir de um probe incompleto.
  if (input.audioTracks.length === 0) {
    args.push('-map', '0:a?', '-c:a', 'aac', '-b:a', '192k');
  }

  // `+faststart` pelo mesmo motivo do remux: sem o moov na frente, o navegador
  // baixa o arquivo inteiro antes do primeiro quadro.
  args.push('-movflags', '+faststart');

  return { args, audioCopied, audioTranscoded };
}
