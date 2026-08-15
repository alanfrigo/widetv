import { describe, expect, test } from 'vitest';

import type { AudioTrackRef } from '../../src/shared/api-types';
import { planAudioVariant, planRemux } from '../../src/server/library/remux-plan';

function track(index: number, codec: string | null, over: Partial<AudioTrackRef> = {}): AudioTrackRef {
  return { index, lang: 'por', title: null, codec, isDefault: index === 0, ...over };
}

function plan(relativePath: string, videoCodec: string | null, tracks: AudioTrackRef[]) {
  return planRemux({ relativePath, videoCodec, audioTracks: tracks });
}

describe('quando NAO remuxar', () => {
  test('mp4 com aac ja toca em qualquer navegador', () => {
    expect(plan('Serie/ep1.mp4', 'h264', [track(0, 'aac')])).toBeNull();
  });

  test('webm e nativo do navegador, mesmo com opus', () => {
    expect(plan('Serie/ep1.webm', 'vp9', [track(0, 'opus')])).toBeNull();
  });

  test('mkv sem stream de video nao tem o que copiar', () => {
    expect(plan('Serie/ep1.mkv', null, [track(0, 'aac')])).toBeNull();
  });

  test('m4v com faixa default aac passa mesmo com dolby secundaria', () => {
    const tracks = [track(0, 'aac'), track(1, 'ac3', { isDefault: false })];
    expect(plan('Serie/ep1.m4v', 'h264', tracks)).toBeNull();
  });
});

describe('mkv com audio universal: so troca de container', () => {
  const result = plan('Serie/ep1.mkv', 'h264', [track(0, 'aac')]);

  test('remuxa por causa do container', () => {
    expect(result?.reason).toBe('container');
  });

  test('video e copiado, nunca recodificado', () => {
    expect(result?.args).toContain('-c:v');
    expect(result?.args[result.args.indexOf('-c:v') + 1]).toBe('copy');
    expect(result?.args).not.toContain('libx264');
  });

  test('faixa unica aac e copiada e continua default', () => {
    expect(result?.args).toEqual(
      expect.arrayContaining(['-map', '0:a:0', '-c:a:0', 'copy', '-disposition:a:0', 'default']),
    );
  });

  test('moov vai para frente do arquivo, senao o seek inicial paga um arquivo inteiro', () => {
    expect(result?.args).toEqual(expect.arrayContaining(['-movflags', '+faststart']));
  });

  test('usa 0:V:0 para nunca copiar a capa embutida como se fosse o filme', () => {
    expect(result?.args).toEqual(expect.arrayContaining(['-map', '0:V:0']));
  });
});

describe('dolby (ac3/eac3): copia bit a bit + gemea AAC na frente', () => {
  const result = plan('Serie/ep1.mkv', 'h264', [
    track(0, 'eac3', { title: 'Surround 5.1' }),
    track(1, 'aac', { lang: 'eng', isDefault: false }),
  ]);

  test('gemea AAC e a saida 0 e a default: e ela que toca no Chrome', () => {
    expect(result?.args).toEqual(
      expect.arrayContaining(['-c:a:0', 'aac', '-disposition:a:0', 'default']),
    );
  });

  test('a dolby original vem logo depois, copiada, sem default', () => {
    expect(result?.args).toEqual(
      expect.arrayContaining(['-c:a:1', 'copy', '-disposition:a:1', '0']),
    );
  });

  test('as duas saidas vem da MESMA faixa fonte', () => {
    const args = result?.args ?? [];
    const maps = args.filter((_, i) => args[i - 1] === '-map' && args[i]?.startsWith('0:a:'));
    expect(maps.slice(0, 2)).toEqual(['0:a:0', '0:a:0']);
  });

  test('gemea ganha titulo para o painel nao mostrar duas linhas identicas', () => {
    expect(result?.args).toEqual(
      expect.arrayContaining(['-metadata:s:a:0', 'title=Surround 5.1 (AAC)']),
    );
  });

  test('faixa aac secundaria e copiada como terceira saida', () => {
    expect(result?.args).toEqual(expect.arrayContaining(['-c:a:2', 'copy']));
  });
});

describe('codec que o MP4 nao carrega (dts, truehd): vira AAC no lugar', () => {
  const result = plan('Serie/ep1.mkv', 'h264', [track(0, 'dts')]);

  test('sem gemea: a propria conversao ja e a faixa de compatibilidade', () => {
    const args = result?.args ?? [];
    const maps = args.filter((_, i) => args[i - 1] === '-map' && args[i]?.startsWith('0:a:'));
    expect(maps).toEqual(['0:a:0']);
  });

  test('a conversao fica default', () => {
    expect(result?.args).toEqual(
      expect.arrayContaining(['-c:a:0', 'aac', '-disposition:a:0', 'default']),
    );
  });
});

describe('casos de borda', () => {
  test('hevc ganha tag hvc1, sem ela o Safari nao reconhece o video', () => {
    const result = plan('Serie/ep1.mkv', 'hevc', [track(0, 'aac')]);
    expect(result?.args).toEqual(expect.arrayContaining(['-tag:v', 'hvc1']));
  });

  test('mp4 com default dolby remuxa por audio', () => {
    const result = plan('Serie/ep1.mp4', 'h264', [track(0, 'ac3')]);
    expect(result?.reason).toBe('audio');
  });

  test('mkv sem faixa de audio nenhuma remuxa so o video', () => {
    const result = plan('Serie/ep1.mkv', 'h264', []);
    expect(result?.reason).toBe('container');
    expect(result?.args).not.toContain('-c:a:0');
  });

  test('codec desconhecido nao e copiado as cegas para dentro do MP4', () => {
    const result = plan('Serie/ep1.mkv', 'h264', [track(0, null)]);
    expect(result?.args).toEqual(expect.arrayContaining(['-c:a:0', 'aac']));
  });

  test('default no meio da lista e respeitada', () => {
    const tracks = [
      track(0, 'aac', { isDefault: false }),
      track(1, 'eac3', { isDefault: true }),
    ];
    const result = plan('Serie/ep1.mkv', 'h264', tracks);
    // Gemea AAC da faixa 1 na frente, depois as originais na ordem.
    const args = result?.args ?? [];
    const maps = args.filter((_, i) => args[i - 1] === '-map' && args[i]?.startsWith('0:a:'));
    expect(maps).toEqual(['0:a:1', '0:a:0', '0:a:1']);
  });
});

describe('planAudioVariant: MP4 com uma dublagem escolhida', () => {
  const DUAL = [
    track(0, 'eac3', { title: 'Brazilian' }),
    track(1, 'eac3', { lang: 'eng', isDefault: false }),
  ];

  test('faixa dolby: gemea AAC default na frente + copia bit a bit atras', () => {
    const result = planAudioVariant({ videoCodec: 'h264', audioTracks: DUAL, audioIndex: 1 });
    const args = result?.args ?? [];
    const maps = args.filter((_, i) => args[i - 1] === '-map' && args[i]?.startsWith('0:a:'));
    // As duas saidas vem da faixa 1 (a escolhida), nunca da 0.
    expect(maps).toEqual(['0:a:1', '0:a:1']);
    expect(args).toEqual(
      expect.arrayContaining(['-c:a:0', 'aac', '-disposition:a:0', 'default', '-c:a:1', 'copy']),
    );
  });

  test('faixa ja universal (aac) vira copia unica, sem gemea', () => {
    const tracks = [track(0, 'eac3'), track(1, 'aac', { lang: 'eng', isDefault: false })];
    const result = planAudioVariant({ videoCodec: 'h264', audioTracks: tracks, audioIndex: 1 });
    const args = result?.args ?? [];
    const maps = args.filter((_, i) => args[i - 1] === '-map' && args[i]?.startsWith('0:a:'));
    expect(maps).toEqual(['0:a:1']);
    expect(args).toEqual(expect.arrayContaining(['-c:a:0', 'copy', '-disposition:a:0', 'default']));
  });

  test('video sempre copiado, hevc com tag hvc1', () => {
    const result = planAudioVariant({ videoCodec: 'hevc', audioTracks: DUAL, audioIndex: 0 });
    expect(result?.args).toEqual(expect.arrayContaining(['-c:v', 'copy', '-tag:v', 'hvc1']));
  });

  test('indice inexistente devolve null, nunca um plano vazio', () => {
    expect(planAudioVariant({ videoCodec: 'h264', audioTracks: DUAL, audioIndex: 7 })).toBeNull();
  });

  test('arquivo sem video devolve null', () => {
    expect(planAudioVariant({ videoCodec: null, audioTracks: DUAL, audioIndex: 0 })).toBeNull();
  });
});
