import { describe, expect, test } from 'vitest';

import type { ShowAliasRow, ShowOverrideRow, ShowRow } from '../../src/server/library/index-store';
import {
  applyShowOverrides,
  channelNumberFixes,
  resolveAliasTarget,
} from '../../src/server/library/overrides';
import type { ScannedEpisode, ScannedShow } from '../../src/server/library/scanner';

/**
 * O transform e o que faz a curadoria sobreviver ao rescan: sem ele, a fusao
 * manual volta a ser dois canais na rodada seguinte, para sempre.
 */

function ep(folder: string, season: number, episode: number): ScannedEpisode {
  const file = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}.mkv`;
  return {
    absolutePath: `/lib/${folder}/${file}`,
    relativePath: `${folder}/${file}`,
    title: file.replace('.mkv', ''),
    season,
    episode,
    orderIndex: 0,
    };
}

function show(slug: string, name: string, episodes: ScannedEpisode[]): ScannedShow {
  return { slug, name, absolutePath: `/lib/${name}`, episodes };
}

function alias(slug: string, targetSlug: string): ShowAliasRow {
  return { slug, targetSlug, createdAt: 0 };
}

function override(row: Partial<ShowOverrideRow> & { slug: string }): ShowOverrideRow {
  return { name: null, hidden: false, channelNumber: null, updatedAt: 0, ...row };
}

describe('resolveAliasTarget', () => {
  test('segue a cadeia ate o fim', () => {
    const aliases = new Map([
      ['c', 'b'],
      ['b', 'a'],
    ]);
    expect(resolveAliasTarget('c', aliases)).toBe('a');
  });

  test('ciclo para em vez de girar para sempre', () => {
    const aliases = new Map([
      ['a', 'b'],
      ['b', 'a'],
    ]);
    expect(['a', 'b']).toContain(resolveAliasTarget('a', aliases));
  });
});

describe('applyShowOverrides', () => {
  test('funde a fonte no alvo e reordena os episodios', () => {
    // A pasta da temporada 2 foi lida ANTES da temporada 1 pelo filesystem.
    const scanned = [
      show('serie-t2', 'Serie T2', [ep('Serie T2', 2, 1), ep('Serie T2', 2, 2)]),
      show('serie', 'Serie', [ep('Serie', 1, 1)]),
    ];

    const resultado = applyShowOverrides(scanned, [alias('serie-t2', 'serie')], []);

    expect(resultado).toHaveLength(1);
    expect(resultado[0]?.slug).toBe('serie');
    expect(resultado[0]?.episodes.map((e) => [e.season, e.episode, e.orderIndex])).toEqual([
      [1, 1, 0],
      [2, 1, 1],
      [2, 2, 2],
    ]);
  });

  test('alvo ausente na varredura deixa a fonte como serie propria', () => {
    const scanned = [show('serie-t2', 'Serie T2', [ep('Serie T2', 2, 1)])];

    const resultado = applyShowOverrides(scanned, [alias('serie-t2', 'serie')], []);

    expect(resultado.map((s) => s.slug)).toEqual(['serie-t2']);
  });

  test('nome do override substitui o nome derivado da pasta', () => {
    const scanned = [show('serie', 'Serie.S01.1080p', [ep('Serie', 1, 1)])];

    const resultado = applyShowOverrides(scanned, [], [override({ slug: 'serie', name: 'A Série' })]);

    expect(resultado[0]?.name).toBe('A Série');
    // O slug NAO muda: ele e a chave de disco, e trocar recriaria o canal.
    expect(resultado[0]?.slug).toBe('serie');
  });
});

describe('channelNumberFixes', () => {
  test('so devolve as series cujo numero divergiu do fixado', () => {
    const shows: ShowRow[] = [
      { id: 1, slug: 'a', name: 'A', channelNumber: 5, absolutePath: '/lib/A' },
      { id: 2, slug: 'b', name: 'B', channelNumber: 9, absolutePath: '/lib/B' },
    ];
    const overrides = [
      override({ slug: 'a', channelNumber: 5 }),
      override({ slug: 'b', channelNumber: 2 }),
    ];

    expect(channelNumberFixes(shows, overrides)).toEqual([{ showId: 2, channelNumber: 2 }]);
  });
});
