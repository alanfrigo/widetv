# Administração do acervo pela web — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Painel web em `/admin` para fundir séries duplicadas, escolher capa e sinopse entre candidatos dos provedores, renomear, ocultar e fixar número de canal — com todas as decisões sobrevivendo ao rescan.

**Architecture:** Camada de override chaveada pelo slug de pasta (`show_override`, `show_alias`), sem FK para `shows`, porque `pruneShows` apaga a linha da série quando o volume some. Um transform puro roda entre `scanLibrary()` e a gravação do índice, aplicando alias e nome. As rotas novas ficam em `/api/admin/*`, atrás do guard de sessão que já cobre `/api/`. A página é uma entry separada do Vite, não uma tela da SPA de TV.

**Tech Stack:** TypeScript ESM estrito, Fastify 5, better-sqlite3, Vite 6, vitest 3. Sem dependência nova.

**Spec:** `docs/superpowers/specs/2026-08-17-web-admin-acervo-design.md`

## Global Constraints

- TypeScript ESM estrito. `noUncheckedIndexedAccess` e `exactOptionalPropertyTypes` ligados: índice de array é `T | undefined`, e propriedade opcional não aceita `undefined` explícito.
- Testes em `tests/<area>/<modulo>.test.ts`, vitest. TDD: teste falhando primeiro, VERIFICADO falhando, depois o código mínimo.
- Sem dependência nova.
- Import do contrato HTTP: `import type { ... } from '@shared/api-types'`.
- Comentário de código em português sem acento, como o resto do repositório. Comentário explica POR QUE, não o que.
- `npm run typecheck` e `npm test` verdes antes de cada commit.
- Migração de banco é append-only: nunca editar uma string existente de `MIGRATIONS`, sempre acrescentar e subir `SCHEMA_VERSION`.

---

### Task 1: Store — migração 13, overrides, alias, canal fixo

**Files:**
- Modify: `src/server/library/index-store.ts`
- Test: `tests/library/index-store.test.ts` (acrescentar describes no fim)

**Interfaces:**
- Consumes: nada.
- Produces:
  ```ts
  export interface ShowOverrideRow {
    slug: string;
    name: string | null;
    hidden: boolean;
    channelNumber: number | null;
    updatedAt: number;
  }
  export interface ShowAliasRow { slug: string; targetSlug: string; createdAt: number }

  // em Store:
  listShowOverrides(): ShowOverrideRow[];
  getShowOverride(slug: string): ShowOverrideRow | null;
  setShowOverride(input: {
    slug: string; name: string | null; hidden: boolean; channelNumber: number | null;
  }): void;
  listShowAliases(): ShowAliasRow[];
  addShowAlias(slug: string, targetSlug: string): void;
  removeShowAlias(slug: string): void;
  setChannelNumber(showId: number, channelNumber: number): void;
  listVisibleShows(): ShowRow[];

  // ShowMetadataRow ganha:
  manual: boolean;
  ```

- [ ] **Step 1: Escrever os testes falhando**

Acrescentar no fim de `tests/library/index-store.test.ts`:

```ts
describe('show_override', () => {
  it('sobrevive ao prune que apaga a serie', () => {
    const store = openStore(':memory:');
    store.upsertShow({ slug: 'simpsons', name: 'Simpsons', absolutePath: '/lib/Simpsons' });
    store.setShowOverride({
      slug: 'simpsons',
      name: 'Os Simpsons',
      hidden: false,
      channelNumber: null,
    });

    // O NAS caiu: o scan nao viu a pasta e podou a serie inteira.
    store.pruneShows([]);

    expect(store.getShowOverride('simpsons')?.name).toBe('Os Simpsons');
    store.close();
  });

  it('linha neutra e apagada em vez de gravada', () => {
    const store = openStore(':memory:');
    store.setShowOverride({ slug: 'x', name: 'X', hidden: true, channelNumber: 7 });
    store.setShowOverride({ slug: 'x', name: null, hidden: false, channelNumber: null });

    expect(store.getShowOverride('x')).toBeNull();
    expect(store.listShowOverrides()).toEqual([]);
    store.close();
  });
});

describe('show_alias', () => {
  it('resolve a cadeia na escrita: alias de alias aponta para o slug final', () => {
    const store = openStore(':memory:');
    store.addShowAlias('b', 'a');
    store.addShowAlias('c', 'b');

    expect(store.listShowAliases()).toEqual([
      { slug: 'b', targetSlug: 'a', createdAt: expect.any(Number) },
      { slug: 'c', targetSlug: 'a', createdAt: expect.any(Number) },
    ]);
    store.close();
  });

  it('recusa ciclo', () => {
    const store = openStore(':memory:');
    store.addShowAlias('b', 'a');

    expect(() => store.addShowAlias('a', 'b')).toThrow(/circular/);
    expect(() => store.addShowAlias('a', 'a')).toThrow(/circular/);
    store.close();
  });

  it('removeShowAlias desfaz', () => {
    const store = openStore(':memory:');
    store.addShowAlias('b', 'a');
    store.removeShowAlias('b');

    expect(store.listShowAliases()).toEqual([]);
    store.close();
  });
});

describe('setChannelNumber', () => {
  it('troca os numeros quando o destino esta ocupado', () => {
    const store = openStore(':memory:');
    const um = store.upsertShow({ slug: 'a', name: 'A', absolutePath: '/lib/A' });
    const dois = store.upsertShow({ slug: 'b', name: 'B', absolutePath: '/lib/B' });

    store.setChannelNumber(dois.id, um.channelNumber);

    expect(store.getShowByChannel(um.channelNumber)?.id).toBe(dois.id);
    expect(store.getShowByChannel(dois.channelNumber)?.id).toBe(um.id);
    store.close();
  });

  it('numero livre nao mexe em ninguem', () => {
    const store = openStore(':memory:');
    const um = store.upsertShow({ slug: 'a', name: 'A', absolutePath: '/lib/A' });

    store.setChannelNumber(um.id, 900);

    expect(store.getShowByChannel(900)?.id).toBe(um.id);
    expect(store.getShowByChannel(um.channelNumber)).toBeNull();
    store.close();
  });
});

describe('listVisibleShows', () => {
  it('esconde o que tem override hidden, mas listShows continua vendo tudo', () => {
    const store = openStore(':memory:');
    store.upsertShow({ slug: 'a', name: 'A', absolutePath: '/lib/A' });
    store.upsertShow({ slug: 'b', name: 'B', absolutePath: '/lib/B' });
    store.setShowOverride({ slug: 'b', name: null, hidden: true, channelNumber: null });

    expect(store.listVisibleShows().map((s) => s.slug)).toEqual(['a']);
    expect(store.listShows().map((s) => s.slug)).toEqual(['a', 'b']);
    store.close();
  });
});

describe('manual em show_metadata', () => {
  it('faz roundtrip', () => {
    const store = openStore(':memory:');
    const show = store.upsertShow({ slug: 'a', name: 'A', absolutePath: '/lib/A' });
    store.upsertShowMetadata({
      showId: show.id,
      posterFile: 'x.jpg',
      backdropFile: null,
      backdropCheckedAt: null,
      backdropSource: null,
      year: 1989,
      overview: 'sinopse',
      source: 'tmdb',
      fetchedAt: 10,
      notFound: false,
      manual: true,
    });

    expect(store.getShowMetadata(show.id)?.manual).toBe(true);
    store.close();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/library/index-store.test.ts`
Expected: FAIL — `store.setShowOverride is not a function` e erro de tipo em `manual`.

- [ ] **Step 3: Migração 13**

Em `src/server/library/index-store.ts`, trocar `const SCHEMA_VERSION = 12;` por `13` e acrescentar no FIM do array `MIGRATIONS`:

```ts
  // versao 13: curadoria humana do catalogo.
  //
  // Sem FK para `shows` DE PROPOSITO. A linha de `shows` morre no prune quando
  // uma raiz fica sem permissao ou um volume desmonta, e um ON DELETE CASCADE
  // levaria a curadoria junto - justamente no acidente que a curadoria precisa
  // atravessar. A chave e o slug de pasta, o unico id estavel entre rodadas.
  //
  // `show_alias` e o que faz a fusao manual sobreviver: o scan consulta a
  // tabela antes de gravar, e a pasta fundida nunca volta a virar canal.
  `
  CREATE TABLE IF NOT EXISTS show_override (
    slug TEXT PRIMARY KEY,
    name TEXT,
    hidden INTEGER NOT NULL DEFAULT 0,
    channel_number INTEGER,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS show_alias (
    slug TEXT PRIMARY KEY,
    target_slug TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_show_alias_target ON show_alias (target_slug);

  ALTER TABLE show_metadata ADD COLUMN manual INTEGER NOT NULL DEFAULT 0;
  `,
```

- [ ] **Step 4: Tipos novos e `manual`**

Acrescentar perto de `ShowMetadataRow`:

```ts
/**
 * Decisao humana sobre uma serie do catalogo, chaveada pelo SLUG da pasta.
 *
 * Slug e nao `show_id`: o id morre no prune e renasce outro quando a pasta
 * volta, e uma curadoria que nao atravessa um volume desmontado nao serve.
 */
export interface ShowOverrideRow {
  slug: string;
  /** null = usa o nome derivado da pasta. */
  name: string | null;
  hidden: boolean;
  /** null = numero automatico, atribuido pelo contador do indice. */
  channelNumber: number | null;
  updatedAt: number;
}

/** Pasta fundida a mao noutra serie. O scan le isto ANTES de gravar. */
export interface ShowAliasRow {
  slug: string;
  targetSlug: string;
  createdAt: number;
}

/** Formato das linhas de `show_override` como o SQLite devolve. */
interface ShowOverrideRecord {
  slug: string;
  name: string | null;
  hidden: number;
  channel_number: number | null;
  updated_at: number;
}

interface ShowAliasRecord {
  slug: string;
  target_slug: string;
  created_at: number;
}
```

Em `ShowMetadataRow`, acrescentar o campo:

```ts
  /**
   * Capa e sinopse escolhidas a mao no painel. A rodada automatica nao entra
   * nesta linha, e o "refazer tudo" tambem nao: as duas selariam a curadoria.
   */
  manual: boolean;
```

Em `ShowMetadataRecord`, acrescentar `manual: number;`.

- [ ] **Step 5: Métodos no contrato `Store`**

Acrescentar na interface `Store`, perto de `mergeShows`:

```ts
  /** Series visiveis no catalogo: `listShows` menos as ocultas no painel. */
  listVisibleShows(): ShowRow[];

  listShowOverrides(): ShowOverrideRow[];
  getShowOverride(slug: string): ShowOverrideRow | null;
  /**
   * Grava a curadoria da pasta. Linha totalmente neutra (sem nome, visivel,
   * canal automatico) e APAGADA em vez de gravada: assim "desfiz tudo" volta
   * ao estado de quem nunca mexeu, e a tabela nao acumula linha morta.
   */
  setShowOverride(input: {
    slug: string;
    name: string | null;
    hidden: boolean;
    channelNumber: number | null;
  }): void;

  listShowAliases(): ShowAliasRow[];
  /**
   * Registra que `slug` foi fundido em `targetSlug`. O alvo e resolvido ate o
   * slug FINAL na escrita - alias de alias viraria uma cadeia que todo leitor
   * teria de reandar, e um ciclo (`a`->`b`->`a`) travaria o scan. Lanca no
   * ciclo em vez de gravar.
   */
  addShowAlias(slug: string, targetSlug: string): void;
  removeShowAlias(slug: string): void;

  /**
   * Fixa o numero de canal da serie, trocando com quem ja o ocupa.
   *
   * `channel_number` e UNIQUE, entao a troca passa por um valor temporario
   * negativo: um UPDATE direto violaria a constraint no meio da transacao.
   */
  setChannelNumber(showId: number, channelNumber: number): void;
```

- [ ] **Step 6: Implementação**

Em `openStore`, junto das outras `db.prepare`:

```ts
  const selectShowById = db.prepare(
    'SELECT id, slug, name, channel_number, absolute_path FROM shows WHERE id = ?',
  );
  const selectVisibleShows = db.prepare(
    `SELECT shows.id, shows.slug, shows.name, shows.channel_number, shows.absolute_path
     FROM shows
     LEFT JOIN show_override ON show_override.slug = shows.slug
     WHERE COALESCE(show_override.hidden, 0) = 0
     ORDER BY shows.channel_number`,
  );
  const updateChannelNumber = db.prepare(
    'UPDATE shows SET channel_number = @channelNumber WHERE id = @id',
  );

  const selectOverrides = db.prepare('SELECT * FROM show_override ORDER BY slug');
  const selectOverride = db.prepare('SELECT * FROM show_override WHERE slug = ?');
  const upsertOverride = db.prepare(
    `INSERT INTO show_override (slug, name, hidden, channel_number, updated_at)
     VALUES (@slug, @name, @hidden, @channelNumber, @updatedAt)
     ON CONFLICT(slug) DO UPDATE SET
       name = excluded.name,
       hidden = excluded.hidden,
       channel_number = excluded.channel_number,
       updated_at = excluded.updated_at`,
  );
  const deleteOverride = db.prepare('DELETE FROM show_override WHERE slug = ?');

  const selectAliases = db.prepare('SELECT * FROM show_alias ORDER BY slug');
  const insertAlias = db.prepare(
    `INSERT INTO show_alias (slug, target_slug, created_at)
     VALUES (@slug, @targetSlug, @createdAt)
     ON CONFLICT(slug) DO UPDATE SET target_slug = excluded.target_slug`,
  );
  const deleteAlias = db.prepare('DELETE FROM show_alias WHERE slug = ?');

  function toOverrideRow(record: ShowOverrideRecord): ShowOverrideRow {
    return {
      slug: record.slug,
      name: record.name,
      hidden: record.hidden !== 0,
      channelNumber: record.channel_number,
      updatedAt: record.updated_at,
    };
  }

  /** Segue a cadeia gravada ate o slug final; para em ciclo em vez de girar. */
  function resolveAliasChain(slug: string): string {
    const map = new Map(
      (selectAliases.all() as ShowAliasRecord[]).map((row) => [row.slug, row.target_slug] as const),
    );
    const visto = new Set<string>([slug]);
    let atual = slug;
    for (;;) {
      const proximo = map.get(atual);
      if (proximo === undefined) return atual;
      if (visto.has(proximo)) return proximo;
      visto.add(proximo);
      atual = proximo;
    }
  }

  const setChannelNumberTx = db.transaction((showId: number, channelNumber: number): void => {
    const atual = selectShowById.get(showId) as ShowRecord | undefined;
    if (atual === undefined) throw new Error(`serie ${String(showId)} nao existe`);
    if (atual.channel_number === channelNumber) return;

    const ocupante = selectShowByChannel.get(channelNumber) as ShowRecord | undefined;
    // Numero negativo como estacionamento: fora do espaco de numeros reais
    // (o contador so emite positivos), entao nao colide com ninguem.
    updateChannelNumber.run({ id: showId, channelNumber: -showId });
    if (ocupante !== undefined) {
      updateChannelNumber.run({ id: ocupante.id, channelNumber: atual.channel_number });
    }
    updateChannelNumber.run({ id: showId, channelNumber });
  });
```

No objeto devolvido por `openStore`:

```ts
    listVisibleShows(): ShowRow[] {
      return (selectVisibleShows.all() as ShowRecord[]).map(toShowRow);
    },

    listShowOverrides(): ShowOverrideRow[] {
      return (selectOverrides.all() as ShowOverrideRecord[]).map(toOverrideRow);
    },

    getShowOverride(slug): ShowOverrideRow | null {
      const record = selectOverride.get(slug) as ShowOverrideRecord | undefined;
      return record === undefined ? null : toOverrideRow(record);
    },

    setShowOverride(input): void {
      if (input.name === null && !input.hidden && input.channelNumber === null) {
        deleteOverride.run(input.slug);
        return;
      }
      upsertOverride.run({
        slug: input.slug,
        name: input.name,
        hidden: input.hidden ? 1 : 0,
        channelNumber: input.channelNumber,
        updatedAt: Date.now(),
      });
    },

    listShowAliases(): ShowAliasRow[] {
      return (selectAliases.all() as ShowAliasRecord[]).map((record) => ({
        slug: record.slug,
        targetSlug: record.target_slug,
        createdAt: record.created_at,
      }));
    },

    addShowAlias(slug, targetSlug): void {
      const alvo = resolveAliasChain(targetSlug);
      if (alvo === slug) throw new Error(`alias circular: ${slug} -> ${targetSlug}`);
      insertAlias.run({ slug, targetSlug: alvo, createdAt: Date.now() });
    },

    removeShowAlias(slug): void {
      deleteAlias.run(slug);
    },

    setChannelNumber(showId, channelNumber): void {
      setChannelNumberTx(showId, channelNumber);
      bumpIndexVersion();
    },
```

Em `getShowMetadata`, acrescentar ao objeto devolvido: `manual: record.manual !== 0,`.

Em `insertShowMetadata`, acrescentar `manual` à lista de colunas, ao `VALUES` (`@manual`) e ao `DO UPDATE SET` (`manual = excluded.manual`). Em `upsertShowMetadata`, passar `manual: row.manual ? 1 : 0`.

- [ ] **Step 7: Consertar os chamadores de `upsertShowMetadata`**

`manual` é obrigatório, então o compilador aponta cada um. Passar `manual: false` em todos os `upsertShowMetadata` de `src/server/metadata/service.ts` (três) e de `src/server/library/scan-controller.ts` (um), e nos testes que montam `ShowMetadataRow` à mão.

Run: `npm run typecheck`
Expected: sem erro.

- [ ] **Step 8: Rodar os testes**

Run: `npx vitest run tests/library/ tests/metadata/ && npm run typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/server/library/index-store.ts src/server/metadata/service.ts src/server/library/scan-controller.ts tests/
git commit -m "feat(index): tabelas de override e alias de serie, e capa manual"
```

---

### Task 2: Transform puro de overrides

**Files:**
- Create: `src/server/library/overrides.ts`
- Modify: `src/server/library/scanner.ts` (exportar `compareEpisodes`)
- Test: `tests/library/overrides.test.ts`

**Interfaces:**
- Consumes: `ShowOverrideRow`, `ShowAliasRow` da Task 1; `ScannedShow`/`ScannedEpisode` de `scanner.ts`.
- Produces:
  ```ts
  export function resolveAliasTarget(slug: string, aliases: ReadonlyMap<string, string>): string;
  export function applyShowOverrides(
    shows: readonly ScannedShow[],
    aliases: readonly ShowAliasRow[],
    overrides: readonly ShowOverrideRow[],
  ): ScannedShow[];
  export function channelNumberFixes(
    shows: readonly ShowRow[],
    overrides: readonly ShowOverrideRow[],
  ): { showId: number; channelNumber: number }[];
  ```

- [ ] **Step 1: Escrever os testes falhando**

Criar `tests/library/overrides.test.ts`:

```ts
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
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/library/overrides.test.ts`
Expected: FAIL — `Cannot find module '../../src/server/library/overrides'`.

- [ ] **Step 3: Exportar `compareEpisodes`**

Em `src/server/library/scanner.ts`, trocar `function compareEpisodes(` por `export function compareEpisodes(` e acrescentar acima:

```ts
/**
 * Ordem da grade: temporada, episodio, e o caminho como desempate.
 *
 * Exportada porque a fusao MANUAL (library/overrides.ts) tem de reordenar
 * exatamente como a automatica: concatenar duas pastas sem reordenar estrearia
 * a S02 antes da S01, dependendo so da ordem de leitura do filesystem.
 */
```

- [ ] **Step 4: Escrever `overrides.ts`**

```ts
import type { ShowAliasRow, ShowOverrideRow, ShowRow } from './index-store';
import { compareEpisodes, type ScannedShow } from './scanner.js';

/**
 * Curadoria humana aplicada a saida do scanner, antes de ela virar indice.
 *
 * O scanner deriva tudo do disco e o `upsertShow` reescreve `name` a cada
 * rodada: sem este passo, renomear e fundir a mao duram ate o rescan da
 * madrugada. Modulo PURO de proposito - nao abre banco nem disco -, entao a
 * regra que decide o catalogo e testavel sem SQLite e sem acervo.
 */

/**
 * Segue a cadeia de alias ate o slug final.
 *
 * A guarda de ciclo nao e paranoia: `addShowAlias` recusa ciclo na escrita,
 * mas um banco gravado por versao anterior (ou editado a mao) nao tem essa
 * garantia, e um laco aqui travaria o scan inteiro.
 */
export function resolveAliasTarget(slug: string, aliases: ReadonlyMap<string, string>): string {
  const visto = new Set<string>([slug]);
  let atual = slug;
  for (;;) {
    const proximo = aliases.get(atual);
    if (proximo === undefined) return atual;
    if (visto.has(proximo)) return atual;
    visto.add(proximo);
    atual = proximo;
  }
}

/**
 * Funde as pastas com alias e aplica o nome escolhido a mao.
 *
 * Alias cujo alvo NAO apareceu nesta varredura e ignorado: a pasta fonte fica
 * como serie propria. Nao ha duplicata nesse caso - o alvo tambem nao esta la -
 * e apagar a fonte deixaria o acervo sem o canal enquanto o volume do alvo
 * estivesse fora.
 */
export function applyShowOverrides(
  shows: readonly ScannedShow[],
  aliases: readonly ShowAliasRow[],
  overrides: readonly ShowOverrideRow[],
): ScannedShow[] {
  const mapa = new Map(aliases.map((row) => [row.slug, row.targetSlug] as const));
  const nomes = new Map(
    overrides.filter((row) => row.name !== null).map((row) => [row.slug, row.name] as const),
  );
  const presentes = new Set(shows.map((show) => show.slug));

  const porSlug = new Map<string, ScannedShow>();
  const ordem: string[] = [];

  for (const show of shows) {
    const alvo = resolveAliasTarget(show.slug, mapa);
    // Alvo fora da varredura: a fonte vale por si mesma nesta rodada.
    const destino = alvo !== show.slug && presentes.has(alvo) ? alvo : show.slug;

    const existente = porSlug.get(destino);
    if (existente === undefined) {
      porSlug.set(destino, { ...show, slug: destino });
      ordem.push(destino);
      continue;
    }

    // A serie que EMPRESTA o slug tambem empresta o caminho: `absolutePath` da
    // fonte apontaria para a pasta que deixou de ser canal.
    const base = existente.slug === show.slug ? show : existente;
    porSlug.set(destino, {
      slug: destino,
      name: base.name,
      absolutePath: base.absolutePath,
      episodes: [...existente.episodes, ...show.episodes],
    });
  }

  return ordem.map((slug) => {
    const show = porSlug.get(slug);
    /* c8 ignore next */
    if (show === undefined) throw new Error(`slug ${slug} sumiu do agrupamento`);
    const episodes = [...show.episodes].sort(compareEpisodes);
    return {
      ...show,
      name: nomes.get(slug) ?? show.name,
      episodes: episodes.map((episode, index) => ({ ...episode, orderIndex: index })),
    };
  });
}

/**
 * Numeros de canal a reaplicar depois do scan.
 *
 * So existe para a serie APAGADA e recriada (pasta que sumiu e voltou): o
 * contador do indice nunca recicla numero, entao ela renasceria num canal
 * qualquer, longe do lugar que a pessoa escolheu.
 */
export function channelNumberFixes(
  shows: readonly ShowRow[],
  overrides: readonly ShowOverrideRow[],
): { showId: number; channelNumber: number }[] {
  const fixos = new Map(
    overrides
      .filter((row) => row.channelNumber !== null)
      .map((row) => [row.slug, row.channelNumber] as const),
  );

  const fixes: { showId: number; channelNumber: number }[] = [];
  for (const show of shows) {
    const alvo = fixos.get(show.slug);
    if (alvo === undefined || alvo === null) continue;
    if (alvo === show.channelNumber) continue;
    fixes.push({ showId: show.id, channelNumber: alvo });
  }
  return fixes;
}
```

- [ ] **Step 5: Rodar os testes**

Run: `npx vitest run tests/library/overrides.test.ts tests/library/scanner.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/library/overrides.ts src/server/library/scanner.ts tests/library/overrides.test.ts
git commit -m "feat(library): transform de overrides e alias sobre a saida do scanner"
```

---

### Task 3: Ligar o transform ao scan

**Files:**
- Modify: `src/server/library/scan-job.ts`
- Test: `tests/library/scan-job.test.ts` (acrescentar describe)

**Interfaces:**
- Consumes: `applyShowOverrides`, `channelNumberFixes` (Task 2); `listShowAliases`, `listShowOverrides`, `setChannelNumber` (Task 1).
- Produces: nenhuma assinatura nova — `runScan` mantém a dela.

- [ ] **Step 1: Escrever o teste falhando**

Acrescentar no fim de `tests/library/scan-job.test.ts`. O arquivo já tem `root` e `store` de módulo (montados no `beforeEach`), o helper `makeEpisode(pasta, arquivo)` e o `fakeProbe()`, que devolve `{ probe, calls }`:

```ts
describe('curadoria manual sobrevive ao scan', () => {
  test('pasta com alias vira episodio do alvo, e nao canal proprio', async () => {
    await makeEpisode('Serie', 'S01E01.mp4');
    await makeEpisode('Serie Extra', 'S02E01.mp4');

    await runScan({ root, store, probe: fakeProbe().probe });
    expect(store.listShows().map((s) => s.slug)).toContain('serie-extra');

    store.addShowAlias('serie-extra', 'serie');
    await runScan({ root, store, probe: fakeProbe().probe });

    expect(store.listShows().map((s) => s.slug)).toEqual(['serie']);
    const alvo = store.listShows()[0];
    expect(alvo).toBeDefined();
    expect(store.listEpisodes(alvo!.id)).toHaveLength(2);
  });

  test('nome do override vence o nome da pasta', async () => {
    await makeEpisode('Serie', 'S01E01.mp4');
    store.setShowOverride({ slug: 'serie', name: 'Outro Nome', hidden: false, channelNumber: null });

    await runScan({ root, store, probe: fakeProbe().probe });

    expect(store.listShows()[0]?.name).toBe('Outro Nome');
  });

  test('canal fixado volta depois de a pasta sumir e voltar', async () => {
    await makeEpisode('Serie', 'S01E01.mp4');
    await runScan({ root, store, probe: fakeProbe().probe });

    const serie = store.listShows()[0];
    expect(serie).toBeDefined();
    store.setChannelNumber(serie!.id, 42);
    store.setShowOverride({ slug: 'serie', name: null, hidden: false, channelNumber: 42 });

    // Volume desmontado: o prune apaga a serie. Depois ela volta - e o
    // contador de canais nunca recicla numero, entao ela renasceria noutro.
    store.pruneShows([]);
    await runScan({ root, store, probe: fakeProbe().probe });

    expect(store.listShows()[0]?.channelNumber).toBe(42);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/library/scan-job.test.ts`
Expected: FAIL — a série `serie-extra` continua no índice depois do alias.

- [ ] **Step 3: Ligar no `runScan`**

Em `src/server/library/scan-job.ts`, acrescentar o import:

```ts
import { applyShowOverrides, channelNumberFixes } from './overrides.js';
```

Trocar a linha da varredura por:

```ts
  // A curadoria entra ANTES da gravacao: alias funde as pastas, o nome manual
  // substitui o derivado. Depois deste ponto o resto do job nao sabe que
  // existe painel nenhum - ele so grava a lista de series que recebeu.
  const scanned = await scanLibrary(root, { smartGrouping: options.smartGrouping ?? true });
  const shows = applyShowOverrides(scanned, store.listShowAliases(), store.listShowOverrides());
```

E, logo depois do `pruneShows` (antes do `return`):

```ts
  // Serie apagada e recriada (pasta que sumiu e voltou) renasce num canal
  // qualquer: o contador nunca recicla numero. Isto devolve o numero escolhido.
  for (const fix of channelNumberFixes(store.listShows(), store.listShowOverrides())) {
    store.setChannelNumber(fix.showId, fix.channelNumber);
  }
```

- [ ] **Step 4: Rodar os testes**

Run: `npx vitest run tests/library/ && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/library/scan-job.ts tests/library/scan-job.test.ts
git commit -m "feat(scan): aplica alias, nome manual e canal fixo em cada rodada"
```

---

### Task 4: Sugestão de duplicados

**Files:**
- Create: `src/server/library/merge-suggest.ts`
- Test: `tests/library/merge-suggest.test.ts`

**Interfaces:**
- Consumes: `ShowRow` (index-store), `groupingKey`/`parseFolderTitle` (title-parser).
- Produces:
  ```ts
  export interface SuggestedMerge { reason: 'nome-identico' | 'slug-parecido'; showIds: number[] }
  export function suggestMerges(
    shows: readonly ShowRow[],
    episodeCounts: ReadonlyMap<number, number>,
  ): SuggestedMerge[];
  ```

- [ ] **Step 1: Escrever o teste falhando**

Criar `tests/library/merge-suggest.test.ts`:

```ts
import { describe, expect, test } from 'vitest';

import type { ShowRow } from '../../src/server/library/index-store';
import { suggestMerges } from '../../src/server/library/merge-suggest';

function show(id: number, slug: string, name: string): ShowRow {
  return { id, slug, name, channelNumber: id, absolutePath: `/lib/${name}` };
}

describe('suggestMerges', () => {
  test('mesmo nome vira sugestao, com o maior acervo como alvo', () => {
    const shows = [
      show(1, 'os-simpsons', 'Os Simpsons'),
      show(2, 'os-simpsons-a1b2c3', 'Os Simpsons'),
    ];
    const counts = new Map([
      [1, 300],
      [2, 20],
    ]);

    expect(suggestMerges(shows, counts)).toEqual([
      { reason: 'nome-identico', showIds: [1, 2] },
    ]);
  });

  test('anos explicitos diferentes nao sao sugeridos', () => {
    const shows = [show(1, 'doctor-who-1963', 'Doctor Who (1963)'), show(2, 'doctor-who-2005', 'Doctor Who (2005)')];

    expect(suggestMerges(shows, new Map())).toEqual([]);
  });

  test('slug com sufixo de digest agrupa mesmo com nome diferente', () => {
    const shows = [show(1, 'tom-e-jerry', 'Tom e Jerry'), show(2, 'tom-e-jerry-9f8e7d', 'Tom & Jerry')];

    expect(suggestMerges(shows, new Map())).toEqual([
      { reason: 'slug-parecido', showIds: [1, 2] },
    ]);
  });

  test('serie sozinha nao vira sugestao', () => {
    expect(suggestMerges([show(1, 'a', 'A')], new Map())).toEqual([]);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/library/merge-suggest.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Escrever `merge-suggest.ts`**

```ts
import type { ShowRow } from './index-store';
import { groupingKey, parseFolderTitle } from './title-parser.js';

/**
 * Candidatos a fusao MANUAL.
 *
 * Diferente de `dedupe.ts`, que funde sozinho e por isso so aceita prova
 * verificavel sem olhar o disco, aqui nada acontece sem um clique: o custo de
 * um palpite errado e a pessoa ignorar a linha. Ainda assim a regra do ano
 * vale - "Doctor Who (1963)" e "(2005)" sao duas series de proposito, e
 * oferece-las juntas todo dia treinaria a pessoa a ignorar a lista.
 */

export interface SuggestedMerge {
  reason: 'nome-identico' | 'slug-parecido';
  /** Alvo sugerido primeiro: o de mais episodios. */
  showIds: number[];
}

/** O sufixo que `disambiguateSlugs` cria: '-<6 hex>' e, em empate, '-<n>'. */
const DIGEST_SUFFIX = /^(?<base>.+)-[0-9a-f]{6}(?:-\d+)?$/;

function slugBase(slug: string): string {
  return DIGEST_SUFFIX.exec(slug)?.groups?.['base'] ?? slug;
}

function agrupar(
  shows: readonly ShowRow[],
  chave: (show: ShowRow) => string,
): Map<string, ShowRow[]> {
  const grupos = new Map<string, ShowRow[]>();
  for (const show of shows) {
    const key = chave(show);
    const atual = grupos.get(key);
    if (atual === undefined) grupos.set(key, [show]);
    else atual.push(show);
  }
  return grupos;
}

export function suggestMerges(
  shows: readonly ShowRow[],
  episodeCounts: ReadonlyMap<number, number>,
): SuggestedMerge[] {
  const sugestoes: SuggestedMerge[] = [];
  // Serie ja sugerida por nome nao volta pela chave do slug: uma linha por par
  // e o que mantem a lista lida, e o motivo mais forte manda.
  const usados = new Set<number>();

  const emitir = (grupos: Map<string, ShowRow[]>, reason: SuggestedMerge['reason']): void => {
    for (const grupo of grupos.values()) {
      const livres = grupo.filter((show) => !usados.has(show.id));
      if (livres.length < 2) continue;
      const ordenado = [...livres].sort(
        (a, b) => (episodeCounts.get(b.id) ?? 0) - (episodeCounts.get(a.id) ?? 0) || a.id - b.id,
      );
      for (const show of ordenado) usados.add(show.id);
      sugestoes.push({ reason, showIds: ordenado.map((show) => show.id) });
    }
  };

  // `groupingKey` ja carrega o ano quando ele existe ("serie@1963"), entao a
  // separacao de remakes sai de graca.
  emitir(agrupar(shows, (show) => groupingKey(parseFolderTitle(show.name))), 'nome-identico');
  emitir(agrupar(shows, (show) => slugBase(show.slug)), 'slug-parecido');

  return sugestoes;
}
```

- [ ] **Step 4: Rodar os testes**

Run: `npx vitest run tests/library/merge-suggest.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/library/merge-suggest.ts tests/library/merge-suggest.test.ts
git commit -m "feat(library): sugestao de series duplicadas para fusao manual"
```

---

### Task 5: Busca de candidatos nos provedores

**Files:**
- Modify: `src/server/metadata/providers.ts`
- Test: `tests/metadata/providers.test.ts` (acrescentar describes)

**Interfaces:**
- Consumes: `ChainOptions`, `ProviderName`, `readJson`, `request`, `toOverview`, `toYear`, `nonEmptyString` (já existem no módulo).
- Produces:
  ```ts
  export interface ShowCandidate {
    source: ProviderName; externalId: string; title: string;
    year: number | null; overview: string | null;
    posterUrl: string | null; backdropUrl: string | null;
  }
  export function searchShowCandidates(term: string, options?: ChainOptions): Promise<ShowCandidate[]>;
  export function imageUrlAllowed(raw: string): boolean;
  ```

- [ ] **Step 1: Escrever os testes falhando**

Acrescentar em `tests/metadata/providers.test.ts` (o arquivo já dubla `fetch`; usar o mesmo padrão de dublê que ele usa):

```ts
describe('searchShowCandidates', () => {
  test('junta os tres provedores e mantem a ordem da cadeia', async () => {
    const fetchDuble = vi.fn(async (url: string) => {
      if (url.includes('themoviedb')) {
        return jsonResponse({
          results: [
            { id: 1, name: 'Serie TMDB', first_air_date: '1989-12-17', overview: 'a', poster_path: '/p.jpg', backdrop_path: '/b.jpg' },
          ],
        });
      }
      if (url.includes('tvmaze')) {
        return jsonResponse([
          { show: { id: 2, name: 'Serie TVMaze', premiered: '1990-01-01', summary: '<p>b</p>', image: { original: 'https://static.tvmaze.com/x.jpg' } } },
        ]);
      }
      return jsonResponse({ results: [] });
    });

    const candidatos = await searchShowCandidates('serie', {
      fetch: fetchDuble,
      tmdbApiKey: 'chave',
    });

    expect(candidatos.map((c) => c.source)).toEqual(['tmdb', 'tvmaze']);
    expect(candidatos[0]?.posterUrl).toBe('https://image.tmdb.org/t/p/w500/p.jpg');
    expect(candidatos[0]?.backdropUrl).toBe('https://image.tmdb.org/t/p/w1280/b.jpg');
    expect(candidatos[1]?.overview).toBe('b');
    expect(candidatos[1]?.year).toBe(1990);
  });

  test('provedor que cai nao zera a lista dos outros', async () => {
    const fetchDuble = vi.fn(async (url: string) => {
      if (url.includes('tvmaze')) throw new Error('rede fora');
      if (url.includes('themoviedb')) {
        return jsonResponse({ results: [{ id: 1, name: 'Serie', first_air_date: '2000-01-01' }] });
      }
      return jsonResponse({ results: [] });
    });

    const candidatos = await searchShowCandidates('serie', {
      fetch: fetchDuble,
      tmdbApiKey: 'chave',
    });

    expect(candidatos).toHaveLength(1);
    expect(candidatos[0]?.source).toBe('tmdb');
  });

  test('termo vazio nao chama provedor nenhum', async () => {
    const fetchDuble = vi.fn();
    expect(await searchShowCandidates('   ', { fetch: fetchDuble })).toEqual([]);
    expect(fetchDuble).not.toHaveBeenCalled();
  });
});

describe('imageUrlAllowed', () => {
  test('aceita so os hosts dos provedores, em https', () => {
    expect(imageUrlAllowed('https://image.tmdb.org/t/p/w500/x.jpg')).toBe(true);
    expect(imageUrlAllowed('https://static.tvmaze.com/uploads/x.jpg')).toBe(true);
    expect(imageUrlAllowed('https://is1-ssl.mzstatic.com/image/x.jpg')).toBe(true);
  });

  test('recusa host interno, http e lixo', () => {
    expect(imageUrlAllowed('http://image.tmdb.org/x.jpg')).toBe(false);
    expect(imageUrlAllowed('https://169.254.169.254/latest/meta-data/')).toBe(false);
    expect(imageUrlAllowed('https://evil.com/image.tmdb.org/x.jpg')).toBe(false);
    expect(imageUrlAllowed('file:///etc/passwd')).toBe(false);
    expect(imageUrlAllowed('nao e url')).toBe(false);
  });
});
```

Se o arquivo não tiver um helper `jsonResponse`, acrescentar:

```ts
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/metadata/providers.test.ts`
Expected: FAIL — `searchShowCandidates is not exported`.

- [ ] **Step 3: Implementar em `providers.ts`**

Acrescentar no fim do arquivo:

```ts
/**
 * Um resultado de busca, ainda NAO aplicado a nenhuma serie.
 *
 * Diferente de `ShowMetadata`, que e o veredito da cadeia automatica, isto e
 * uma opcao numa lista: quem escolhe e a pessoa no painel.
 */
export interface ShowCandidate {
  source: ProviderName;
  /** Id no provedor. So identifica a linha na tela; nada aqui o persiste. */
  externalId: string;
  title: string;
  year: number | null;
  overview: string | null;
  posterUrl: string | null;
  backdropUrl: string | null;
}

/** Teto por provedor: a tela mostra uma grade, nao um catalogo. */
const MAX_CANDIDATES = 10;

export async function searchTmdbCandidates(
  name: string,
  apiKey: string,
  options?: ProviderOptions,
): Promise<ShowCandidate[]> {
  const url =
    'https://api.themoviedb.org/3/search/tv' +
    `?query=${encodeURIComponent(name)}&api_key=${encodeURIComponent(apiKey)}&language=pt-BR`;
  const body = await readJson(await request(url, options), 'tmdb');
  if (body === null || typeof body !== 'object') return [];

  const results = (body as { results?: unknown[] }).results ?? [];
  return results.slice(0, MAX_CANDIDATES).flatMap((raw) => {
    if (typeof raw !== 'object' || raw === null) return [];
    const item = raw as {
      id?: unknown;
      name?: unknown;
      poster_path?: unknown;
      backdrop_path?: unknown;
      overview?: unknown;
      first_air_date?: unknown;
    };
    const title = nonEmptyString(item.name);
    if (title === null) return [];
    const posterPath = nonEmptyString(item.poster_path);
    const backdropPath = nonEmptyString(item.backdrop_path);
    return [
      {
        source: 'tmdb' as const,
        externalId: String(item.id ?? ''),
        title,
        year: toYear(item.first_air_date),
        overview: toOverview(item.overview),
        posterUrl: posterPath === null ? null : `https://image.tmdb.org/t/p/w500${posterPath}`,
        backdropUrl:
          backdropPath === null ? null : `https://image.tmdb.org/t/p/w1280${backdropPath}`,
      },
    ];
  });
}

/**
 * `/search/shows` e nao `singlesearch`: o segundo ja escolhe por conta propria,
 * e a escolha e justamente o que o painel devolve para a pessoa.
 */
export async function searchTvmazeCandidates(
  name: string,
  options?: ProviderOptions,
): Promise<ShowCandidate[]> {
  const url = `https://api.tvmaze.com/search/shows?q=${encodeURIComponent(name)}`;
  const body = await readJson(await request(url, options), 'tvmaze');
  if (!Array.isArray(body)) return [];

  return body.slice(0, MAX_CANDIDATES).flatMap((raw) => {
    if (typeof raw !== 'object' || raw === null) return [];
    const show = (raw as { show?: unknown }).show;
    if (typeof show !== 'object' || show === null) return [];
    const item = show as {
      id?: unknown;
      name?: unknown;
      premiered?: unknown;
      summary?: unknown;
      image?: { original?: unknown; medium?: unknown } | null;
    };
    const title = nonEmptyString(item.name);
    if (title === null) return [];
    return [
      {
        source: 'tvmaze' as const,
        externalId: String(item.id ?? ''),
        title,
        year: toYear(item.premiered),
        overview: toOverview(item.summary),
        posterUrl: nonEmptyString(item.image?.original) ?? nonEmptyString(item.image?.medium),
        backdropUrl: null,
      },
    ];
  });
}

export async function searchItunesCandidates(
  name: string,
  options?: ProviderOptions,
): Promise<ShowCandidate[]> {
  const candidatos: ShowCandidate[] = [];
  for (const media of ['tvShow', 'movie'] as const) {
    const url =
      `https://itunes.apple.com/search?term=${encodeURIComponent(name)}` +
      `&media=${media}&limit=${String(MAX_CANDIDATES)}`;
    const body = await readJson(await request(url, options), 'itunes');
    if (body === null || typeof body !== 'object') continue;

    for (const raw of (body as { results?: unknown[] }).results ?? []) {
      if (typeof raw !== 'object' || raw === null) continue;
      const item = raw as {
        trackId?: unknown;
        collectionId?: unknown;
        trackName?: unknown;
        collectionName?: unknown;
        artworkUrl100?: unknown;
        releaseDate?: unknown;
        longDescription?: unknown;
        description?: unknown;
      };
      const title = nonEmptyString(item.trackName) ?? nonEmptyString(item.collectionName);
      if (title === null) continue;
      const artwork = nonEmptyString(item.artworkUrl100);
      candidatos.push({
        source: 'itunes',
        externalId: String(item.trackId ?? item.collectionId ?? ''),
        title,
        year: toYear(item.releaseDate),
        overview: toOverview(item.longDescription) ?? toOverview(item.description),
        // O `100x100` da URL e template: trocar devolve a arte grande.
        posterUrl: artwork === null ? null : artwork.replace('100x100', '600x600'),
        backdropUrl: null,
      });
    }
  }
  return candidatos.slice(0, MAX_CANDIDATES);
}

/**
 * Todos os provedores, em PARALELO.
 *
 * A serializacao de duas buscas em voo do enriquecimento existe por etiqueta
 * com API publica ao varrer 460 series de uma vez. Aqui sao tres requisicoes
 * disparadas por um clique, com a pessoa olhando a tela esperando - a mesma
 * cautela viraria so lentidao.
 *
 * Provedor que falha some da lista em vez de derrubar a busca: meia lista e
 * infinitamente melhor que um erro quando o objetivo e escolher uma capa.
 */
export async function searchShowCandidates(
  term: string,
  options?: ChainOptions,
): Promise<ShowCandidate[]> {
  const busca = term.trim();
  if (busca === '') return [];

  const key = options?.tmdbApiKey;
  const tarefas: Promise<ShowCandidate[]>[] = [];
  if (typeof key === 'string' && key.trim() !== '') {
    tarefas.push(searchTmdbCandidates(busca, key.trim(), options));
  }
  tarefas.push(searchTvmazeCandidates(busca, options));
  tarefas.push(searchItunesCandidates(busca, options));

  const resultados = await Promise.allSettled(tarefas);
  return resultados.flatMap((resultado) =>
    resultado.status === 'fulfilled' ? resultado.value : [],
  );
}

/** Hosts de imagem dos provedores. Fora desta lista, nada e baixado. */
const IMAGE_HOSTS = new Set(['image.tmdb.org', 'static.tvmaze.com']);

/**
 * A URL da capa vem do CLIENTE no `PUT` do painel, e quem a busca e o
 * SERVIDOR: sem esta trava, um corpo forjado faz o servidor requisitar
 * qualquer endereco alcancavel da rede dele (o metadata da nuvem, um servico
 * interno sem autenticacao). A sessao unica nao substitui a checagem - cookie
 * vaza mais facil que rede interna.
 */
export function imageUrlAllowed(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (IMAGE_HOSTS.has(url.hostname)) return true;
  // A arte da Apple sai de varios `is<N>-ssl.mzstatic.com`.
  return url.hostname === 'mzstatic.com' || url.hostname.endsWith('.mzstatic.com');
}
```

- [ ] **Step 4: Rodar os testes**

Run: `npx vitest run tests/metadata/providers.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/metadata/providers.ts tests/metadata/providers.test.ts
git commit -m "feat(metadata): busca de candidatos nos tres provedores e allowlist de imagem"
```

---

### Task 6: Aplicar metadata manual e blindá-la

**Files:**
- Modify: `src/server/metadata/service.ts`
- Modify: `src/server/library/scan-controller.ts:480-520` (laço do `reset`)
- Test: `tests/metadata/service.test.ts` (acrescentar describes)

**Interfaces:**
- Consumes: `ShowCandidate`, `imageUrlAllowed`, `downloadImage` (Task 5); `manual` em `ShowMetadataRow` (Task 1).
- Produces:
  ```ts
  export interface ManualMetadataOptions extends ProviderOptions {
    now?: () => number;
    download?: (url: string) => Promise<Uint8Array>;
  }
  export function applyManualMetadata(
    store: MetadataStore, dataDir: string, show: ShowRow,
    candidate: ShowCandidate, options?: ManualMetadataOptions,
  ): Promise<void>;
  export function clearManualMetadata(
    store: MetadataStore, show: ShowRow, now?: () => number,
  ): void;
  ```

- [ ] **Step 1: Escrever os testes falhando**

Acrescentar em `tests/metadata/service.test.ts`:

```ts
describe('metadata manual', () => {
  test('grava capa, sinopse e o selo manual', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'widetv-manual-'));
    const store = makeStore([show(1, 'Serie')]);

    await applyManualMetadata(
      store,
      dataDir,
      show(1, 'Serie'),
      {
        source: 'tmdb',
        externalId: '99',
        title: 'Serie Escolhida',
        year: 1989,
        overview: 'sinopse escolhida',
        posterUrl: 'https://image.tmdb.org/t/p/w500/p.jpg',
        backdropUrl: 'https://image.tmdb.org/t/p/w1280/b.jpg',
      },
      { now: () => AGORA, download: async () => new Uint8Array([1, 2, 3]) },
    );

    const row = store.rows.get(1);
    expect(row?.manual).toBe(true);
    expect(row?.overview).toBe('sinopse escolhida');
    expect(row?.year).toBe(1989);
    expect(row?.fetchedAt).toBe(AGORA);
    expect(await readFile(join(dataDir, 'posters', '1.jpg'))).toHaveLength(3);
    expect(await readFile(join(dataDir, 'backdrops', '1.jpg'))).toHaveLength(3);

    await rm(dataDir, { recursive: true, force: true });
  });

  test('recusa URL fora dos hosts dos provedores sem baixar nada', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'widetv-manual-'));
    const store = makeStore([show(1, 'Serie')]);
    const download = vi.fn();

    await expect(
      applyManualMetadata(
        store,
        dataDir,
        show(1, 'Serie'),
        {
          source: 'tmdb',
          externalId: '1',
          title: 'x',
          year: null,
          overview: null,
          posterUrl: 'https://169.254.169.254/latest/meta-data/',
          backdropUrl: null,
        },
        { now: () => AGORA, download },
      ),
    ).rejects.toThrow(/host de imagem/);

    expect(download).not.toHaveBeenCalled();
    expect(store.rows.get(1)).toBeUndefined();
    await rm(dataDir, { recursive: true, force: true });
  });

  test('serie manual fica fora da fila do enriquecimento, em qualquer escopo', () => {
    const store = makeStore([show(1, 'Serie')]);
    store.rows.set(1, {
      showId: 1,
      posterFile: '1.jpg',
      backdropFile: null,
      backdropCheckedAt: null,
      backdropSource: null,
      year: 1989,
      overview: 'x',
      source: 'tmdb',
      fetchedAt: AGORA,
      notFound: false,
      manual: true,
    });

    expect(listShowsMissingMetadata(store, AGORA, NOT_FOUND_TTL_MS, 'missing')).toEqual([]);
    expect(listShowsMissingMetadata(store, AGORA, NOT_FOUND_TTL_MS, 'refresh')).toEqual([]);
  });

  test('clearManualMetadata devolve a serie para a fila automatica', () => {
    const store = makeStore([show(1, 'Serie')]);
    store.rows.set(1, {
      showId: 1,
      posterFile: '1.jpg',
      backdropFile: null,
      backdropCheckedAt: null,
      backdropSource: null,
      year: 1989,
      overview: 'x',
      source: 'tmdb',
      fetchedAt: AGORA,
      notFound: false,
      manual: true,
    });

    clearManualMetadata(store, show(1, 'Serie'), () => AGORA);

    expect(store.rows.get(1)?.manual).toBe(false);
    expect(listShowsMissingMetadata(store, AGORA + 1, NOT_FOUND_TTL_MS, 'missing')).toHaveLength(1);
  });
});
```

Acrescentar aos imports do arquivo: `applyManualMetadata`, `clearManualMetadata` de `service`, e `ShowCandidate` de `providers`. O helper `makeStore` já existe no arquivo; acrescentar `manual: false` a qualquer `ShowMetadataRow` literal que ele monte.

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/metadata/service.test.ts`
Expected: FAIL — `applyManualMetadata is not exported`.

- [ ] **Step 3: Guardar a linha manual na seleção da fila**

Em `src/server/metadata/service.ts`, dentro de `listShowsMissingMetadata`, logo depois de `if (row === null) return true;`:

```ts
    // Escolha da pessoa nao volta para a fila em escopo nenhum: a rodada
    // automatica sobrescreveria a capa que ela foi ao painel corrigir.
    if (row.manual) return false;
```

- [ ] **Step 4: Escrever `applyManualMetadata` e `clearManualMetadata`**

Acrescentar no fim de `src/server/metadata/service.ts` (e ao import de `./providers`: `imageUrlAllowed`, `type ShowCandidate`):

```ts
export interface ManualMetadataOptions extends ProviderOptions {
  /** Injetavel para teste. Default: `Date.now`. */
  now?: () => number;
  /** Injetavel para teste; por padrao baixa a imagem de verdade. */
  download?: (url: string) => Promise<Uint8Array>;
}

/**
 * Aplica o candidato que a pessoa escolheu no painel.
 *
 * Ao contrario de `enrichOne`, aqui a gravacao e SOBRESCRITA declarada: quem
 * clicou esta dizendo que o que estava ali era o errado. O que a rodada
 * automatica nunca faz - trocar capa boa por outra - e exatamente o pedido.
 *
 * A checagem de host acontece ANTES de qualquer requisicao: a URL veio do
 * cliente, e o `fetch` sai do servidor.
 */
export async function applyManualMetadata(
  store: MetadataStore,
  dataDir: string,
  show: ShowRow,
  candidate: ShowCandidate,
  options: ManualMetadataOptions = {},
): Promise<void> {
  const now = options.now ?? Date.now;
  const download = options.download ?? ((url: string) => downloadImage(url, options));

  for (const url of [candidate.posterUrl, candidate.backdropUrl]) {
    if (url !== null && !imageUrlAllowed(url)) {
      throw new Error(`host de imagem nao permitido: ${url}`);
    }
  }

  const existing = store.getShowMetadata(show.id);

  let posterFile = existing?.posterFile ?? null;
  if (candidate.posterUrl !== null) {
    const dir = postersDir(dataDir);
    await mkdir(dir, { recursive: true });
    posterFile = await writeArt(dir, posterFileName(show.id), await download(candidate.posterUrl));
  }

  let backdropFile = existing?.backdropFile ?? null;
  let backdropSource = existing?.backdropSource ?? null;
  if (candidate.backdropUrl !== null) {
    const dir = backdropsDir(dataDir);
    await mkdir(dir, { recursive: true });
    backdropFile = await writeArt(
      dir,
      backdropFileName(show.id),
      await download(candidate.backdropUrl),
    );
    backdropSource = candidate.source;
  }

  store.upsertShowMetadata({
    showId: show.id,
    posterFile,
    backdropFile,
    // Carimbo do relogio da ESCOLHA: `posterUrlOf` publica `?v=<fetchedAt>`, e
    // e isso que tira a capa velha do cache de um dia do navegador e da TV.
    backdropCheckedAt: now(),
    backdropSource,
    year: candidate.year,
    overview: candidate.overview,
    source: candidate.source,
    fetchedAt: now(),
    notFound: false,
    manual: true,
  });
}

/**
 * Desfaz a escolha manual: a serie volta para a fila automatica.
 *
 * `notFound: true` com `fetchedAt` de agora e o mesmo par que o reset do
 * painel usa - o TTL vence na hora e a rodada seguinte reconsulta tudo.
 */
export function clearManualMetadata(
  store: MetadataStore,
  show: ShowRow,
  now: () => number = Date.now,
): void {
  store.upsertShowMetadata({
    showId: show.id,
    posterFile: null,
    backdropFile: null,
    backdropCheckedAt: null,
    backdropSource: null,
    year: null,
    overview: null,
    source: null,
    fetchedAt: now(),
    notFound: true,
    manual: false,
  });
}
```

- [ ] **Step 5: Poupar a linha manual no reset do painel**

Em `src/server/library/scan-controller.ts`, no laço do `if (reset)`, trocar o `for` por:

```ts
        for (const show of deps.store.listShows()) {
          // A escolha manual e imune ao "refazer tudo": ela existe justamente
          // porque a busca automatica errou nesta serie, e apaga-la aqui faria
          // do botao de manutencao um apagador de curadoria.
          if (deps.store.getShowMetadata(show.id)?.manual === true) continue;
          deps.store.upsertShowMetadata({
```

(o corpo do upsert continua igual, agora com `manual: false`).

- [ ] **Step 6: Rodar os testes**

Run: `npx vitest run tests/metadata/ tests/library/scan-controller.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/server/metadata/service.ts src/server/library/scan-controller.ts tests/metadata/service.test.ts
git commit -m "feat(metadata): capa e sinopse escolhidas a mao, imunes a rodada automatica"
```

---

### Task 7: Rotas `/api/admin` e filtro de ocultos

**Files:**
- Create: `src/server/admin/routes.ts`
- Modify: `src/shared/api-types.ts` (tipos + entradas em `API`)
- Modify: `src/server/channels/service.ts` (`ChannelSource.listVisibleShows`, uso em `listChannels` e `listNowPlaying`)
- Modify: `src/server/index.ts` (registrar as rotas)
- Test: `tests/admin/routes.test.ts`, `tests/channels/service.test.ts` (um caso novo)

**Interfaces:**
- Consumes: tudo das tasks 1, 4, 5 e 6.
- Produces: `AdminShow`, `MergeSuggestion`, `MetadataCandidate`, `AdminPatch`, `API.adminShows` e amigos; `registerAdminRoutes(app, deps)`.

- [ ] **Step 1: Tipos no contrato**

Em `src/shared/api-types.ts`, antes do bloco `export const API`:

```ts
/* --- administracao do acervo ---------------------------------------------- */

/** Uma serie como o painel de administracao a ve: indice + curadoria. */
export interface AdminShow {
  id: number;
  slug: string;
  name: string;
  /** Nome REAL da pasta em disco, para a pessoa se achar no acervo. */
  folderName: string;
  channelNumber: number;
  episodeCount: number;
  seasons: number[];
  hidden: boolean;
  /** true quando o nome exibido veio do painel, e nao da pasta. */
  renamed: boolean;
  year: number | null;
  overview: string | null;
  source: string | null;
  /** Capa e sinopse escolhidas a mao: a rodada automatica nao toca. */
  manual: boolean;
  posterUrl: string | null;
  backdropUrl: string | null;
  /** Pastas fundidas nesta serie. `[]` quando nao houve fusao. */
  mergedSlugs: string[];
}

export interface MergeSuggestion {
  reason: 'nome-identico' | 'slug-parecido';
  /** Alvo sugerido primeiro (o de mais episodios). */
  showIds: number[];
}

export interface MetadataCandidate {
  source: 'tmdb' | 'tvmaze' | 'itunes';
  externalId: string;
  title: string;
  year: number | null;
  overview: string | null;
  posterUrl: string | null;
  backdropUrl: string | null;
}

/** Campo ausente = nao mexer. `name: null` volta ao nome da pasta. */
export interface AdminShowPatch {
  name?: string | null;
  hidden?: boolean;
  channelNumber?: number;
}

export interface MergeRequest {
  sourceIds: number[];
}

export interface UnmergeRequest {
  slug: string;
}

export interface ApplyMetadataRequest {
  candidate: MetadataCandidate;
}
```

E dentro de `export const API = { ... }`:

```ts
  /** Acervo inteiro como o painel o ve (`AdminShow[]`). Nunca cacheado. */
  adminShows: '/api/admin/shows',
  /** Candidatos a fusao (`MergeSuggestion[]`). */
  adminMergeSuggestions: '/api/admin/merge-suggestions',
  /** PATCH com `AdminShowPatch`: nome, oculto e numero de canal. */
  adminShow: (showId: number) => `/api/admin/shows/${String(showId)}`,
  /** POST `MergeRequest`: funde as fontes nesta serie. 202. */
  adminMerge: (showId: number) => `/api/admin/shows/${String(showId)}/merge`,
  /** POST `UnmergeRequest`: solta a pasta e dispara um scan incremental. 202. */
  adminUnmerge: (showId: number) => `/api/admin/shows/${String(showId)}/unmerge`,
  /** GET `?q=`: candidatos de capa/sinopse (`MetadataCandidate[]`). */
  adminMetadataSearch: (showId: number) => `/api/admin/shows/${String(showId)}/metadata/search`,
  /** PUT `ApplyMetadataRequest` aplica; DELETE volta ao automatico. */
  adminMetadata: (showId: number) => `/api/admin/shows/${String(showId)}/metadata`,
```

- [ ] **Step 2: Escrever o teste falhando**

Criar `tests/admin/routes.test.ts`:

```ts
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { registerAdminRoutes, type AdminDeps } from '../../src/server/admin/routes';
import { openStore, type Store } from '../../src/server/library/index-store';
import type { AdminShow, MetadataCandidate } from '../../src/shared/api-types';

/**
 * As rotas nao decidem curadoria: elas validam o corpo e chamam o indice. O
 * que elas guardam sozinhas e a porta - o `PUT` de metadata baixa uma URL que
 * veio do cliente, e host fora da lista tem de morrer aqui.
 */

let app: FastifyInstance;
let store: Store;

const CANDIDATO: MetadataCandidate = {
  source: 'tmdb',
  externalId: '1',
  title: 'Serie',
  year: 1989,
  overview: 'sinopse',
  posterUrl: 'https://image.tmdb.org/t/p/w500/p.jpg',
  backdropUrl: null,
};

beforeEach(async () => {
  store = openStore(':memory:');
  app = Fastify();
  const deps: AdminDeps = {
    store,
    dataDir: '/tmp/widetv-teste',
    tmdbApiKey: null,
    startScan: () => ({ started: true }),
    searchCandidates: async () => [CANDIDATO],
    applyMetadata: async () => undefined,
  };
  registerAdminRoutes(app, deps);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  store.close();
});

function serie(slug: string, name: string): number {
  const row = store.upsertShow({ slug, name, absolutePath: `/lib/${name}` });
  store.upsertEpisodes(row.id, [
    {
      id: `${slug}/e1.mkv`,
      absolutePath: `/lib/${name}/e1.mkv`,
      title: 'e1',
      season: 1,
      episode: 1,
      orderIndex: 0,
      durationMs: 1000,
      videoCodec: 'h264',
      audioCodec: 'aac',
      width: 1280,
      height: 720,
      faststart: true,
      audioTracks: [],
      subtitleTracks: [],
      mtimeMs: 1,
      size: 1,
    },
  ]);
  return row.id;
}

describe('GET /api/admin/shows', () => {
  test('devolve a serie com pasta, contagem e selos', async () => {
    const id = serie('serie', 'Serie');
    store.setShowOverride({ slug: 'serie', name: 'Outro', hidden: true, channelNumber: null });

    const response = await app.inject({ method: 'GET', url: '/api/admin/shows' });

    expect(response.statusCode).toBe(200);
    const shows = response.json<AdminShow[]>();
    expect(shows).toHaveLength(1);
    expect(shows[0]).toMatchObject({
      id,
      slug: 'serie',
      folderName: 'Serie',
      episodeCount: 1,
      hidden: true,
      renamed: true,
      manual: false,
    });
  });
});

describe('PATCH /api/admin/shows/:id', () => {
  test('renomeia agora e grava o override', async () => {
    const id = serie('serie', 'Serie');

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/admin/shows/${String(id)}`,
      payload: { name: 'Os Simpsons' },
    });

    expect(response.statusCode).toBe(200);
    expect(store.listShows()[0]?.name).toBe('Os Simpsons');
    expect(store.getShowOverride('serie')?.name).toBe('Os Simpsons');
  });

  test('numero de canal ocupado troca com o ocupante', async () => {
    const um = serie('a', 'A');
    const dois = serie('b', 'B');
    const canalDeUm = store.listShows().find((s) => s.id === um)!.channelNumber;

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/admin/shows/${String(dois)}`,
      payload: { channelNumber: canalDeUm },
    });

    expect(response.statusCode).toBe(200);
    expect(store.getShowByChannel(canalDeUm)?.id).toBe(dois);
  });

  test('tipo errado e 400', async () => {
    const id = serie('serie', 'Serie');

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/admin/shows/${String(id)}`,
      payload: { hidden: 'sim' },
    });

    expect(response.statusCode).toBe(400);
  });

  test('serie inexistente e 404', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/admin/shows/999',
      payload: { hidden: true },
    });

    expect(response.statusCode).toBe(404);
  });
});

describe('POST /api/admin/shows/:id/merge', () => {
  test('funde a fonte no alvo e grava o alias', async () => {
    const alvo = serie('serie', 'Serie');
    const fonte = serie('serie-extra', 'Serie Extra');

    const response = await app.inject({
      method: 'POST',
      url: `/api/admin/shows/${String(alvo)}/merge`,
      payload: { sourceIds: [fonte] },
    });

    expect(response.statusCode).toBe(202);
    expect(store.listShows().map((s) => s.slug)).toEqual(['serie']);
    expect(store.listShowAliases()).toEqual([
      { slug: 'serie-extra', targetSlug: 'serie', createdAt: expect.any(Number) },
    ]);
  });

  test('fundir a serie nela mesma e 400', async () => {
    const alvo = serie('serie', 'Serie');

    const response = await app.inject({
      method: 'POST',
      url: `/api/admin/shows/${String(alvo)}/merge`,
      payload: { sourceIds: [alvo] },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('PUT /api/admin/shows/:id/metadata', () => {
  test('host fora da lista e 400', async () => {
    const id = serie('serie', 'Serie');

    const response = await app.inject({
      method: 'PUT',
      url: `/api/admin/shows/${String(id)}/metadata`,
      payload: {
        candidate: { ...CANDIDATO, posterUrl: 'https://169.254.169.254/latest/meta-data/' },
      },
    });

    expect(response.statusCode).toBe(400);
  });

  test('candidato valido responde a serie atualizada', async () => {
    const id = serie('serie', 'Serie');

    const response = await app.inject({
      method: 'PUT',
      url: `/api/admin/shows/${String(id)}/metadata`,
      payload: { candidate: CANDIDATO },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<AdminShow>().id).toBe(id);
  });
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `npx vitest run tests/admin/routes.test.ts`
Expected: FAIL — `Cannot find module '../../src/server/admin/routes'`.

- [ ] **Step 4: Escrever `src/server/admin/routes.ts`**

```ts
import type { FastifyInstance, FastifyReply } from 'fastify';

import {
  API,
  type AdminShow,
  type AdminShowPatch,
  type MergeSuggestion,
  type MetadataCandidate,
  type TaskAccepted,
} from '@shared/api-types';

import { backdropUrlOf, posterUrlOf } from '../channels/service.js';
import type { ShowRow, Store } from '../library/index-store';
import { suggestMerges } from '../library/merge-suggest.js';
import { imageUrlAllowed, type ShowCandidate } from '../metadata/providers.js';

/**
 * Curadoria do catalogo pelo painel web.
 *
 * Duas regras organizam o modulo. A primeira: toda decisao e gravada DUAS
 * vezes - no indice, para valer agora, e na tabela de override, para valer
 * depois do proximo scan. Gravar so uma faria a curadoria durar ate a
 * madrugada.
 *
 * A segunda: as URLs de imagem chegam do cliente e o download sai do servidor.
 * A allowlist de host e conferida aqui, antes de a requisicao existir.
 *
 * Ficam atras do guard de sessao que ja cobre `/api/`.
 */

export interface AdminDeps {
  store: Store;
  dataDir: string;
  tmdbApiKey: string | null;
  /** Dispara scan incremental. E o que efetiva o desfazer de uma fusao. */
  startScan: () => TaskAccepted;
  /** Injetavel para teste; por padrao percorre os provedores de verdade. */
  searchCandidates: (term: string) => Promise<ShowCandidate[]>;
  /** Injetavel para teste; por padrao baixa a arte e grava a linha manual. */
  applyMetadata: (show: ShowRow, candidate: ShowCandidate) => Promise<void>;
  /** Injetavel para teste; por padrao devolve a serie ao automatico. */
  clearMetadata?: (show: ShowRow) => void;
}

function folderNameOf(absolutePath: string): string {
  const parts = absolutePath.split('/').filter((part) => part !== '');
  return parts[parts.length - 1] ?? absolutePath;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Monta a visao do painel: indice, curadoria e metadata numa linha so. */
function toAdminShow(deps: AdminDeps, show: ShowRow): AdminShow {
  const store = deps.store;
  const metadata = store.getShowMetadata(show.id);
  const override = store.getShowOverride(show.slug);
  const mergedSlugs = store
    .listShowAliases()
    .filter((alias) => alias.targetSlug === show.slug)
    .map((alias) => alias.slug);

  return {
    id: show.id,
    slug: show.slug,
    name: show.name,
    folderName: folderNameOf(show.absolutePath),
    channelNumber: show.channelNumber,
    episodeCount: store.countEpisodesByShow().get(show.id) ?? 0,
    seasons: store.listSeasons(show.id),
    hidden: override?.hidden ?? false,
    renamed: override?.name !== null && override?.name !== undefined,
    year: metadata?.year ?? null,
    overview: metadata?.overview ?? null,
    source: metadata?.source ?? null,
    manual: metadata?.manual ?? false,
    posterUrl: posterUrlOf(show.channelNumber, metadata),
    backdropUrl: backdropUrlOf(show.channelNumber, metadata),
    mergedSlugs,
  };
}

function findShow(deps: AdminDeps, raw: string): ShowRow | null {
  if (!/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return deps.store.listShows().find((show) => show.id === id) ?? null;
}

/** Corpo -> patch, campo a campo. Devolve a mensagem quando o TIPO nao bate. */
function toPatch(body: Record<string, unknown>): AdminShowPatch | string {
  const patch: AdminShowPatch = {};

  if (body.name !== undefined) {
    if (body.name !== null && typeof body.name !== 'string') {
      return 'name precisa ser string ou null';
    }
    // Nome so de espaco e o mesmo que "sem nome manual": volta para a pasta.
    const nome = typeof body.name === 'string' ? body.name.trim() : null;
    patch.name = nome === null || nome === '' ? null : nome;
  }

  if (body.hidden !== undefined) {
    if (typeof body.hidden !== 'boolean') return 'hidden precisa ser boolean';
    patch.hidden = body.hidden;
  }

  if (body.channelNumber !== undefined) {
    if (typeof body.channelNumber !== 'number' || !Number.isInteger(body.channelNumber)) {
      return 'channelNumber precisa ser inteiro';
    }
    if (body.channelNumber < 1) return 'channelNumber precisa ser maior que zero';
    patch.channelNumber = body.channelNumber;
  }

  return patch;
}

function isCandidate(value: unknown): value is MetadataCandidate {
  if (!isPlainObject(value)) return false;
  const fontes = ['tmdb', 'tvmaze', 'itunes'];
  if (typeof value.source !== 'string' || !fontes.includes(value.source)) return false;
  if (typeof value.title !== 'string' || value.title.trim() === '') return false;
  for (const campo of ['posterUrl', 'backdropUrl'] as const) {
    const url = value[campo];
    if (url !== null && typeof url !== 'string') return false;
  }
  for (const campo of ['overview'] as const) {
    const texto = value[campo];
    if (texto !== null && typeof texto !== 'string') return false;
  }
  const ano = value.year;
  return ano === null || typeof ano === 'number';
}

function notFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ error: 'serie inexistente' });
}

export function registerAdminRoutes(app: FastifyInstance, deps: AdminDeps): void {
  const { store } = deps;

  app.get(API.adminShows, async (_request, reply) => {
    // A tela e de edicao: mostrar estado velho aqui e mostrar a pessoa
    // desfazendo o que ela acabou de fazer.
    reply.header('cache-control', 'no-store');
    return store.listShows().map((show) => toAdminShow(deps, show));
  });

  app.get(API.adminMergeSuggestions, async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    const sugestoes: MergeSuggestion[] = suggestMerges(
      store.listShows(),
      store.countEpisodesByShow(),
    );
    return sugestoes;
  });

  // Caminhos literais com `:id`: as entradas de `API` sao funcoes de URL para
  // o CLIENTE, e derivar o padrao delas por replace de string trocaria uma
  // linha legivel por um truque que quebra calado quando a rota mudar.
  app.patch<{ Params: { id: string } }>('/api/admin/shows/:id', async (request, reply) => {
    const show = findShow(deps, request.params.id);
    if (show === null) return notFound(reply);

    const body: unknown = request.body;
    if (!isPlainObject(body)) {
      return reply.code(400).send({ error: 'corpo precisa ser um objeto' });
    }
    const patch = toPatch(body);
    if (typeof patch === 'string') return reply.code(400).send({ error: patch });

    const override = store.getShowOverride(show.slug);
    const nome = patch.name === undefined ? (override?.name ?? null) : patch.name;
    const oculto = patch.hidden ?? override?.hidden ?? false;
    const canal =
      patch.channelNumber === undefined ? (override?.channelNumber ?? null) : patch.channelNumber;

    // Numero primeiro: se a troca falhar (constraint), nada mais foi gravado.
    if (patch.channelNumber !== undefined && patch.channelNumber !== show.channelNumber) {
      store.setChannelNumber(show.id, patch.channelNumber);
    }
    // O nome vale AGORA no indice; o override e o que o faz sobreviver ao scan.
    if (patch.name !== undefined) {
      store.upsertShow({
        slug: show.slug,
        name: nome ?? folderNameOf(show.absolutePath),
        absolutePath: show.absolutePath,
      });
    }
    store.setShowOverride({ slug: show.slug, name: nome, hidden: oculto, channelNumber: canal });

    const atualizado = findShow(deps, String(show.id));
    /* c8 ignore next */
    if (atualizado === null) return notFound(reply);
    reply.header('cache-control', 'no-store');
    return toAdminShow(deps, atualizado);
  });

  app.post<{ Params: { id: string } }>(
    '/api/admin/shows/:id/merge',
    async (request, reply) => {
      const alvo = findShow(deps, request.params.id);
      if (alvo === null) return notFound(reply);

      const body: unknown = request.body;
      if (!isPlainObject(body) || !Array.isArray(body.sourceIds)) {
        return reply.code(400).send({ error: 'sourceIds precisa ser uma lista de ids' });
      }

      const fontes: ShowRow[] = [];
      for (const raw of body.sourceIds) {
        if (typeof raw !== 'number') {
          return reply.code(400).send({ error: 'sourceIds precisa ser uma lista de ids' });
        }
        const fonte = findShow(deps, String(raw));
        if (fonte === null) return notFound(reply);
        if (fonte.id === alvo.id) {
          return reply.code(400).send({ error: 'nao da para fundir a serie nela mesma' });
        }
        fontes.push(fonte);
      }

      for (const fonte of fontes) {
        // Alias antes da fusao: `mergeShows` apaga a linha da fonte, e depois
        // dela o slug so existiria na memoria deste request.
        store.addShowAlias(fonte.slug, alvo.slug);
        store.mergeShows(fonte.id, alvo.id);
      }

      return reply.code(202).send({ started: true } satisfies TaskAccepted);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/admin/shows/:id/unmerge',
    async (request, reply) => {
      const alvo = findShow(deps, request.params.id);
      if (alvo === null) return notFound(reply);

      const body: unknown = request.body;
      if (!isPlainObject(body) || typeof body.slug !== 'string') {
        return reply.code(400).send({ error: 'slug precisa ser string' });
      }

      store.removeShowAlias(body.slug);
      // O desfazer real acontece no scan: `upsertEpisodes` move o episodio de
      // volta para a serie recriada pelo `ON CONFLICT(id) DO UPDATE`.
      return reply.code(202).send(deps.startScan());
    },
  );

  app.get<{ Params: { id: string }; Querystring: { q?: string } }>(
    '/api/admin/shows/:id/metadata/search',
    async (request, reply) => {
      const show = findShow(deps, request.params.id);
      if (show === null) return notFound(reply);

      const termo = request.query.q ?? show.name;
      reply.header('cache-control', 'no-store');
      return deps.searchCandidates(termo);
    },
  );

  app.put<{ Params: { id: string } }>(
    '/api/admin/shows/:id/metadata',
    async (request, reply) => {
      const show = findShow(deps, request.params.id);
      if (show === null) return notFound(reply);

      const body: unknown = request.body;
      if (!isPlainObject(body) || !isCandidate(body.candidate)) {
        return reply.code(400).send({ error: 'candidate invalido' });
      }
      const candidate = body.candidate;

      for (const url of [candidate.posterUrl, candidate.backdropUrl]) {
        if (url !== null && !imageUrlAllowed(url)) {
          return reply.code(400).send({ error: 'host de imagem nao permitido' });
        }
      }

      await deps.applyMetadata(show, candidate);
      reply.header('cache-control', 'no-store');
      return toAdminShow(deps, show);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/admin/shows/:id/metadata',
    async (request, reply) => {
      const show = findShow(deps, request.params.id);
      if (show === null) return notFound(reply);

      deps.clearMetadata?.(show);
      return reply.code(202).send({ started: true } satisfies TaskAccepted);
    },
  );
}
```

Os únicos usos de `API` aqui são as duas rotas sem parâmetro (`API.adminShows`, `API.adminMergeSuggestions`); o resto vem literal com `:id`. Se `API` mudar, os testes de rota quebram — é o que garante que os dois lados continuem batendo.

- [ ] **Step 5: Filtrar ocultos no catálogo**

Em `src/server/channels/service.ts`, acrescentar a `ChannelSource`:

```ts
  /** Catalogo publico: `listShows` menos as series ocultas no painel. */
  listVisibleShows(): ShowRow[];
```

Em `listChannels`, trocar `.listShows()` por `.listVisibleShows()`. Em `listNowPlaying`, trocar `[...source.listShows()]` por `[...source.listVisibleShows()]`.

Acrescentar em `tests/channels/service.test.ts` (a fonte de mentira do arquivo ganha `listVisibleShows`):

```ts
test('serie oculta some do catalogo', () => {
  const source = fakeSource({ hiddenSlugs: ['b'] });
  expect(listChannels(source).map((c) => c.name)).not.toContain('B');
});
```

Ajustar o helper de fonte falsa do arquivo para implementar `listVisibleShows` filtrando os slugs ocultos.

- [ ] **Step 6: Registrar no servidor**

Em `src/server/index.ts`, importar e registrar depois de `registerLibraryRoutes`:

```ts
  registerAdminRoutes(app, {
    store,
    dataDir: config.dataDir,
    tmdbApiKey: config.tmdbApiKey,
    startScan: () => controller.startScan('incremental'),
    searchCandidates: (term) =>
      searchShowCandidates(term, { tmdbApiKey: config.tmdbApiKey }),
    applyMetadata: (show, candidate) =>
      applyManualMetadata(store, config.dataDir, show, candidate),
    clearMetadata: (show) => {
      clearManualMetadata(store, show);
    },
  });
```

- [ ] **Step 7: Rodar tudo**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/server/admin src/shared/api-types.ts src/server/channels/service.ts src/server/index.ts tests/
git commit -m "feat(admin): rotas de curadoria do acervo e filtro de series ocultas"
```

---

### Task 8: Página `/admin` — build e listagem

**Files:**
- Create: `src/web/admin/index.html`, `src/web/admin/api.ts`, `src/web/admin/state.ts`, `src/web/admin/admin.ts`, `src/web/admin/admin.css`
- Modify: `vite.config.ts`, `src/server/index.ts` (ramo do `setNotFoundHandler`)
- Test: `tests/web/admin-state.test.ts`

**Interfaces:**
- Consumes: `AdminShow`, `MergeSuggestion`, `API` (Task 7).
- Produces:
  ```ts
  // state.ts
  export interface AdminUiState { shows: AdminShow[]; filter: string; mergeTargetId: number | null; mergeSourceIds: number[] }
  export function initialAdminState(): AdminUiState;
  export function visibleShows(state: AdminUiState): AdminShow[];
  export function toggleMergeSource(state: AdminUiState, showId: number): AdminUiState;
  export function canMerge(state: AdminUiState): boolean;
  ```

- [ ] **Step 1: Escrever o teste falhando**

Criar `tests/web/admin-state.test.ts`:

```ts
import { describe, expect, test } from 'vitest';

import type { AdminShow } from '../../src/shared/api-types';
import {
  canMerge,
  initialAdminState,
  toggleMergeSource,
  visibleShows,
} from '../../src/web/admin/state';

function show(id: number, name: string, folderName = name): AdminShow {
  return {
    id,
    slug: name.toLowerCase(),
    name,
    folderName,
    channelNumber: id,
    episodeCount: 1,
    seasons: [1],
    hidden: false,
    renamed: false,
    year: null,
    overview: null,
    source: null,
    manual: false,
    posterUrl: null,
    backdropUrl: null,
    mergedSlugs: [],
  };
}

describe('visibleShows', () => {
  test('filtra por nome e por pasta, sem acento e sem caixa', () => {
    const state = {
      ...initialAdminState(),
      shows: [show(1, 'Os Simpsons'), show(2, 'Padrinhos Mágicos', 'Padrinhos.Magicos.S01')],
    };

    expect(visibleShows({ ...state, filter: 'simpson' }).map((s) => s.id)).toEqual([1]);
    expect(visibleShows({ ...state, filter: 'magicos' }).map((s) => s.id)).toEqual([2]);
    expect(visibleShows({ ...state, filter: '  ' }).map((s) => s.id)).toEqual([1, 2]);
  });
});

describe('selecao de fusao', () => {
  test('marca e desmarca fonte, e o alvo nunca entra como fonte', () => {
    let state = { ...initialAdminState(), shows: [show(1, 'A'), show(2, 'B')], mergeTargetId: 1 };

    state = toggleMergeSource(state, 2);
    expect(state.mergeSourceIds).toEqual([2]);
    expect(canMerge(state)).toBe(true);

    state = toggleMergeSource(state, 1);
    expect(state.mergeSourceIds).toEqual([2]);

    state = toggleMergeSource(state, 2);
    expect(state.mergeSourceIds).toEqual([]);
    expect(canMerge(state)).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/web/admin-state.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Escrever `src/web/admin/state.ts`**

```ts
import type { AdminShow } from '@shared/api-types';

/**
 * Estado da tela de administracao: decisao pura, sem DOM.
 *
 * Mesmo desenho de `settings.ts`: aqui mora o que a tela mostra e o que ela
 * deixa fazer; quem desenha e quem fala com a rede e o `admin.ts`.
 */

export interface AdminUiState {
  shows: AdminShow[];
  filter: string;
  /** Serie que RECEBE a fusao; null antes de a pessoa escolher. */
  mergeTargetId: number | null;
  mergeSourceIds: number[];
}

export function initialAdminState(): AdminUiState {
  return { shows: [], filter: '', mergeTargetId: null, mergeSourceIds: [] };
}

/** Acento e caixa fora: quem digita "magicos" procura "Mágicos". */
function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

export function visibleShows(state: AdminUiState): AdminShow[] {
  const termo = normalize(state.filter.trim());
  if (termo === '') return state.shows;
  return state.shows.filter(
    (show) => normalize(show.name).includes(termo) || normalize(show.folderName).includes(termo),
  );
}

/**
 * Marca ou desmarca uma serie como FONTE da fusao.
 *
 * O alvo nunca entra: fundir a serie nela mesma e o unico jeito de o painel
 * apagar episodios sem querer, e a rota recusa - melhor a tela nem oferecer.
 */
export function toggleMergeSource(state: AdminUiState, showId: number): AdminUiState {
  if (showId === state.mergeTargetId) return state;
  const marcado = state.mergeSourceIds.includes(showId);
  return {
    ...state,
    mergeSourceIds: marcado
      ? state.mergeSourceIds.filter((id) => id !== showId)
      : [...state.mergeSourceIds, showId],
  };
}

export function canMerge(state: AdminUiState): boolean {
  return state.mergeTargetId !== null && state.mergeSourceIds.length > 0;
}
```

- [ ] **Step 4: Cliente HTTP e HTML**

`src/web/admin/api.ts`:

```ts
import {
  API,
  type AdminShow,
  type AdminShowPatch,
  type MergeSuggestion,
  type MetadataCandidate,
} from '@shared/api-types';

/**
 * Cliente do painel. 401 nao tenta login aqui: a tela de senha mora na SPA de
 * TV, e duplica-la seria uma segunda porta para manter.
 */

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', ...init });
  if (response.status === 401) {
    window.location.href = '/';
    throw new Error('sessao expirada');
  }
  if (!response.ok) {
    const corpo = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(corpo?.error ?? `${url} respondeu ${String(response.status)}`);
  }
  return (await response.json()) as T;
}

const JSON_HEADERS = { 'content-type': 'application/json' };

export function fetchAdminShows(): Promise<AdminShow[]> {
  return json<AdminShow[]>(API.adminShows);
}

export function fetchMergeSuggestions(): Promise<MergeSuggestion[]> {
  return json<MergeSuggestion[]>(API.adminMergeSuggestions);
}

export function patchShow(showId: number, patch: AdminShowPatch): Promise<AdminShow> {
  return json<AdminShow>(API.adminShow(showId), {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  });
}

export function mergeShows(targetId: number, sourceIds: number[]): Promise<unknown> {
  return json(API.adminMerge(targetId), {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ sourceIds }),
  });
}

export function unmergeSlug(showId: number, slug: string): Promise<unknown> {
  return json(API.adminUnmerge(showId), {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ slug }),
  });
}

export function searchMetadata(showId: number, term: string): Promise<MetadataCandidate[]> {
  return json<MetadataCandidate[]>(
    `${API.adminMetadataSearch(showId)}?q=${encodeURIComponent(term)}`,
  );
}

export function applyMetadata(showId: number, candidate: MetadataCandidate): Promise<AdminShow> {
  return json<AdminShow>(API.adminMetadata(showId), {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ candidate }),
  });
}

export function clearMetadata(showId: number): Promise<unknown> {
  return json(API.adminMetadata(showId), { method: 'DELETE' });
}
```

`src/web/admin/index.html`:

```html
<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>widetv — acervo</title>
    <link rel="stylesheet" href="./admin.css" />
  </head>
  <body>
    <header class="adm-top">
      <h1>Acervo</h1>
      <input id="adm-filtro" type="search" placeholder="filtrar por nome ou pasta" />
      <span id="adm-contagem"></span>
      <a href="/">voltar à TV</a>
    </header>
    <section id="adm-sugestoes" class="adm-sugestoes"></section>
    <main id="adm-lista" class="adm-lista"></main>
    <aside id="adm-painel" class="adm-painel" hidden></aside>
    <p id="adm-erro" class="adm-erro" hidden></p>
    <script type="module" src="./admin.ts"></script>
  </body>
</html>
```

`src/web/admin/admin.css` — folha própria, sem framework e sem fonte nova. O painel é de trabalho, não é a TV: densidade e legibilidade de perto valem mais que o desenho do catálogo.

```css
:root {
  color-scheme: dark;
  --adm-fundo: #14161a;
  --adm-linha: #1e2128;
  --adm-borda: #2b2f38;
  --adm-texto: #e8eaed;
  --adm-fraco: #9aa0aa;
}

body {
  margin: 0;
  background: var(--adm-fundo);
  color: var(--adm-texto);
  font: 14px/1.4 system-ui, sans-serif;
}

.adm-top {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 12px 16px;
  background: var(--adm-fundo);
  border-bottom: 1px solid var(--adm-borda);
}

.adm-top h1 { font-size: 16px; margin: 0; }
.adm-top input[type='search'] { flex: 1; max-width: 360px; }

.adm-sugestoes,
.adm-lista {
  max-width: 1100px;
  margin: 0 auto;
  padding: 12px 16px;
}

.adm-sugestao {
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  margin-bottom: 6px;
  background: var(--adm-linha);
  border-left: 3px solid #d0a63c;
  border-radius: 4px;
}

.adm-linha {
  display: grid;
  grid-template-columns: 24px 24px 40px 64px 1fr 1fr 72px auto auto auto;
  gap: 10px;
  align-items: center;
  padding: 6px 10px;
  border-bottom: 1px solid var(--adm-borda);
}

.adm-capa { width: 40px; height: 60px; object-fit: cover; background: var(--adm-linha); }
.adm-pasta { color: var(--adm-fraco); font-size: 12px; overflow-wrap: anywhere; }
.adm-eps { color: var(--adm-fraco); font-size: 12px; }
.adm-canal-input { width: 60px; }
.adm-nome-input { width: 100%; }

.adm-selo {
  padding: 1px 6px;
  margin-right: 4px;
  font-size: 11px;
  background: var(--adm-borda);
  border-radius: 999px;
}

.adm-painel {
  position: fixed;
  top: 0;
  right: 0;
  width: min(520px, 100%);
  height: 100%;
  overflow-y: auto;
  padding: 16px;
  background: var(--adm-linha);
  border-left: 1px solid var(--adm-borda);
}

.adm-grade {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 10px;
  margin-top: 12px;
}

.adm-cartao {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px;
  text-align: left;
  color: inherit;
  background: var(--adm-fundo);
  border: 1px solid var(--adm-borda);
  border-radius: 4px;
  cursor: pointer;
}

.adm-cartao img { width: 100%; aspect-ratio: 2 / 3; object-fit: cover; }
.adm-cartao small { color: var(--adm-fraco); font-size: 11px; max-height: 4.2em; overflow: hidden; }

.adm-erro {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  margin: 0;
  padding: 10px 16px;
  background: #5a1d1d;
}
```

- [ ] **Step 5: Listagem em `admin.ts`**

```ts
import type { AdminShow } from '@shared/api-types';

import { fetchAdminShows } from './api';
import { initialAdminState, visibleShows, type AdminUiState } from './state';
import './admin.css';

/**
 * Desenho e rede do painel. A decisao (filtro, selecao) mora em `state.ts`;
 * aqui so ha DOM e fetch.
 */

let state: AdminUiState = initialAdminState();

const lista = document.querySelector<HTMLElement>('#adm-lista');
const filtro = document.querySelector<HTMLInputElement>('#adm-filtro');
const contagem = document.querySelector<HTMLElement>('#adm-contagem');
const erro = document.querySelector<HTMLElement>('#adm-erro');

function mostrarErro(mensagem: string): void {
  if (erro === null) return;
  erro.textContent = mensagem;
  erro.hidden = false;
}

function linha(show: AdminShow): HTMLElement {
  const el = document.createElement('article');
  el.className = 'adm-linha';
  el.dataset['showId'] = String(show.id);

  const capa = document.createElement('img');
  capa.className = 'adm-capa';
  capa.alt = '';
  if (show.posterUrl !== null) capa.src = show.posterUrl;

  const nome = document.createElement('span');
  nome.className = 'adm-nome';
  nome.textContent = show.name;

  const pasta = document.createElement('span');
  pasta.className = 'adm-pasta';
  pasta.textContent = show.folderName;

  const canal = document.createElement('span');
  canal.className = 'adm-canal';
  canal.textContent = String(show.channelNumber);

  const episodios = document.createElement('span');
  episodios.className = 'adm-eps';
  episodios.textContent = `${String(show.episodeCount)} ep.`;

  const selos = document.createElement('span');
  selos.className = 'adm-selos';
  for (const [ativo, texto] of [
    [show.manual, 'manual'],
    [show.hidden, 'oculto'],
    [show.renamed, 'renomeado'],
  ] as const) {
    if (!ativo) continue;
    const selo = document.createElement('span');
    selo.className = 'adm-selo';
    selo.textContent = texto;
    selos.append(selo);
  }

  el.append(capa, canal, nome, pasta, episodios, selos);
  return el;
}

function render(): void {
  if (lista === null) return;
  const visiveis = visibleShows(state);
  lista.replaceChildren(...visiveis.map(linha));
  if (contagem !== null) {
    contagem.textContent = `${String(visiveis.length)} de ${String(state.shows.length)}`;
  }
}

filtro?.addEventListener('input', () => {
  state = { ...state, filter: filtro.value };
  render();
});

async function carregar(): Promise<void> {
  try {
    state = { ...state, shows: await fetchAdminShows() };
    render();
  } catch (error) {
    mostrarErro(error instanceof Error ? error.message : String(error));
  }
}

void carregar();
```

- [ ] **Step 6: Build e rota**

Em `vite.config.ts`, dentro de `build`:

```ts
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./src/web/index.html', import.meta.url)),
        admin: fileURLToPath(new URL('./src/web/admin/index.html', import.meta.url)),
      },
    },
```

Em `src/server/index.ts`, no `setNotFoundHandler`:

```ts
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'rota desconhecida' });
      }
      // O painel e outra entry, com bundle proprio: cair no index.html da TV
      // entregaria a SPA errada para quem digitou /admin.
      if (request.url.startsWith('/admin')) {
        return reply.sendFile('admin/index.html');
      }
      return reply.sendFile('index.html');
    });
```

- [ ] **Step 7: Verificar**

Run: `npx vitest run tests/web/admin-state.test.ts && npm run typecheck && npm run build:web`
Expected: PASS, e `dist/web/admin/index.html` existe.

- [ ] **Step 8: Commit**

```bash
git add src/web/admin vite.config.ts src/server/index.ts tests/web/admin-state.test.ts
git commit -m "feat(web): pagina /admin com a listagem do acervo"
```

---

### Task 9: Página `/admin` — ações

**Files:**
- Modify: `src/web/admin/admin.ts`, `src/web/admin/admin.css`
- Test: `tests/web/admin-state.test.ts` (um caso a mais)

**Interfaces:**
- Consumes: tudo da Task 8.
- Produces: nenhuma assinatura nova exportada.

- [ ] **Step 1: Teste do rótulo do painel de metadata**

Acrescentar em `tests/web/admin-state.test.ts`:

```ts
describe('candidateLabel', () => {
  test('junta titulo, ano e provedor, e aguenta ano ausente', () => {
    expect(
      candidateLabel({
        source: 'tmdb',
        externalId: '1',
        title: 'Os Simpsons',
        year: 1989,
        overview: null,
        posterUrl: null,
        backdropUrl: null,
      }),
    ).toBe('Os Simpsons (1989) — tmdb');

    expect(
      candidateLabel({
        source: 'tvmaze',
        externalId: '2',
        title: 'Serie',
        year: null,
        overview: null,
        posterUrl: null,
        backdropUrl: null,
      }),
    ).toBe('Serie — tvmaze');
  });
});
```

Acrescentar `candidateLabel` ao import de `state`.

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/web/admin-state.test.ts`
Expected: FAIL — `candidateLabel is not exported`.

- [ ] **Step 3: `candidateLabel` em `state.ts`**

```ts
import type { MetadataCandidate } from '@shared/api-types';

/** Rotulo do candidato na grade. Ano ausente nao deixa parenteses vazio. */
export function candidateLabel(candidate: MetadataCandidate): string {
  const ano = candidate.year === null ? '' : ` (${String(candidate.year)})`;
  return `${candidate.title}${ano} — ${candidate.source}`;
}
```

(acrescentar `MetadataCandidate` ao import de `@shared/api-types` no topo do arquivo)

- [ ] **Step 4: Ações na linha**

Em `admin.ts`, dentro de `linha(show)`, acrescentar antes do `el.append`:

```ts
  const nomeEditavel = document.createElement('input');
  nomeEditavel.className = 'adm-nome-input';
  nomeEditavel.value = show.name;
  nomeEditavel.addEventListener('change', () => {
    void aplicar(show.id, { name: nomeEditavel.value });
  });

  const canalEditavel = document.createElement('input');
  canalEditavel.type = 'number';
  canalEditavel.min = '1';
  canalEditavel.className = 'adm-canal-input';
  canalEditavel.value = String(show.channelNumber);
  canalEditavel.addEventListener('change', () => {
    const numero = Number(canalEditavel.value);
    if (!Number.isInteger(numero) || numero < 1) {
      canalEditavel.value = String(show.channelNumber);
      return;
    }
    void aplicar(show.id, { channelNumber: numero });
  });

  const ocultar = document.createElement('button');
  ocultar.type = 'button';
  ocultar.textContent = show.hidden ? 'Mostrar' : 'Ocultar';
  ocultar.addEventListener('click', () => {
    void aplicar(show.id, { hidden: !show.hidden });
  });

  const arte = document.createElement('button');
  arte.type = 'button';
  arte.textContent = 'Capa/Sinopse';
  arte.addEventListener('click', () => {
    void abrirPainel(show);
  });

  const fonte = document.createElement('input');
  fonte.type = 'checkbox';
  fonte.className = 'adm-fonte';
  fonte.checked = state.mergeSourceIds.includes(show.id);
  fonte.addEventListener('change', () => {
    state = toggleMergeSource(state, show.id);
    render();
  });

  const alvo = document.createElement('input');
  alvo.type = 'radio';
  alvo.name = 'adm-alvo';
  alvo.className = 'adm-alvo';
  alvo.checked = state.mergeTargetId === show.id;
  alvo.addEventListener('change', () => {
    state = {
      ...state,
      mergeTargetId: show.id,
      // Quem virou alvo sai da lista de fontes: fundir a serie nela mesma e o
      // unico jeito de este painel apagar episodio sem querer.
      mergeSourceIds: state.mergeSourceIds.filter((id) => id !== show.id),
    };
    render();
  });
```

Trocar `nome` por `nomeEditavel` e `canal` por `canalEditavel` no `el.append`, e acrescentar `alvo, fonte, ocultar, arte`.

Atualizar os três imports do topo de `admin.ts`:

```ts
import type { AdminShow, AdminShowPatch } from '@shared/api-types';

import {
  applyMetadata,
  clearMetadata,
  fetchAdminShows,
  fetchMergeSuggestions,
  mergeShows,
  patchShow,
  searchMetadata,
  unmergeSlug,
} from './api';
import {
  canMerge,
  candidateLabel,
  initialAdminState,
  toggleMergeSource,
  visibleShows,
  type AdminUiState,
} from './state';
```

`unmergeSlug` é usado no botão de desfazer fusão: para cada slug em `show.mergedSlugs`, uma linha no painel de metadata com "Soltar `<slug>`" chamando `unmergeSlug(show.id, slug).then(carregar)`.

Acrescentar as funções:

```ts
/** Aplica o patch e recarrega: o servidor e a verdade, nao o DOM. */
async function aplicar(showId: number, patch: AdminShowPatch): Promise<void> {
  try {
    await patchShow(showId, patch);
    await carregar();
  } catch (error) {
    mostrarErro(error instanceof Error ? error.message : String(error));
  }
}

async function fundir(): Promise<void> {
  if (!canMerge(state) || state.mergeTargetId === null) return;
  try {
    await mergeShows(state.mergeTargetId, state.mergeSourceIds);
    state = { ...state, mergeTargetId: null, mergeSourceIds: [] };
    await carregar();
  } catch (error) {
    mostrarErro(error instanceof Error ? error.message : String(error));
  }
}

async function abrirPainel(show: AdminShow): Promise<void> {
  const painel = document.querySelector<HTMLElement>('#adm-painel');
  if (painel === null) return;
  painel.hidden = false;
  painel.replaceChildren();

  const busca = document.createElement('input');
  busca.type = 'search';
  busca.value = show.name;

  const grade = document.createElement('div');
  grade.className = 'adm-grade';

  const desfazer = document.createElement('button');
  desfazer.type = 'button';
  desfazer.textContent = 'Voltar ao automático';
  desfazer.addEventListener('click', () => {
    void clearMetadata(show.id).then(carregar).catch((error: unknown) => {
      mostrarErro(error instanceof Error ? error.message : String(error));
    });
  });

  const procurar = async (): Promise<void> => {
    grade.replaceChildren();
    try {
      for (const candidato of await searchMetadata(show.id, busca.value)) {
        const cartao = document.createElement('button');
        cartao.type = 'button';
        cartao.className = 'adm-cartao';

        if (candidato.posterUrl !== null) {
          const capa = document.createElement('img');
          capa.src = candidato.posterUrl;
          capa.alt = '';
          cartao.append(capa);
        }
        const rotulo = document.createElement('span');
        rotulo.textContent = candidateLabel(candidato);
        const sinopse = document.createElement('small');
        sinopse.textContent = candidato.overview ?? '';
        cartao.append(rotulo, sinopse);

        cartao.addEventListener('click', () => {
          void applyMetadata(show.id, candidato)
            .then(() => {
              painel.hidden = true;
              return carregar();
            })
            .catch((error: unknown) => {
              mostrarErro(error instanceof Error ? error.message : String(error));
            });
        });
        grade.append(cartao);
      }
    } catch (error) {
      mostrarErro(error instanceof Error ? error.message : String(error));
    }
  };

  busca.addEventListener('change', () => {
    void procurar();
  });
  painel.append(busca, desfazer);

  // Desfazer fusao: uma linha por pasta que foi fundida nesta serie. O efeito
  // real vem do scan que a rota dispara, entao a lista so muda na recarga.
  for (const slug of show.mergedSlugs) {
    const soltar = document.createElement('button');
    soltar.type = 'button';
    soltar.textContent = `Soltar ${slug}`;
    soltar.addEventListener('click', () => {
      void unmergeSlug(show.id, slug)
        .then(carregar)
        .catch((error: unknown) => {
          mostrarErro(error instanceof Error ? error.message : String(error));
        });
    });
    painel.append(soltar);
  }

  painel.append(grade);
  await procurar();
}
```

- [ ] **Step 5: Bloco de sugestões e botão de fundir**

Acrescentar em `admin.ts`:

```ts
/** Sugestoes de duplicados. Nada aqui funde sozinho: e uma lista de atalhos. */
async function carregarSugestoes(): Promise<void> {
  const alvo = document.querySelector<HTMLElement>('#adm-sugestoes');
  if (alvo === null) return;
  try {
    const sugestoes = await fetchMergeSuggestions();
    const nomes = new Map(state.shows.map((show) => [show.id, show.name] as const));
    alvo.replaceChildren(
      ...sugestoes.map((sugestao) => {
        const linha = document.createElement('div');
        linha.className = 'adm-sugestao';
        linha.textContent = sugestao.showIds
          .map((id) => nomes.get(id) ?? String(id))
          .join('  +  ');

        const botao = document.createElement('button');
        botao.type = 'button';
        botao.textContent = 'Fundir no primeiro';
        botao.addEventListener('click', () => {
          const [primeiro, ...fontes] = sugestao.showIds;
          if (primeiro === undefined || fontes.length === 0) return;
          void mergeShows(primeiro, fontes)
            .then(carregar)
            .catch((error: unknown) => {
              mostrarErro(error instanceof Error ? error.message : String(error));
            });
        });
        linha.append(botao);
        return linha;
      }),
    );
  } catch (error) {
    mostrarErro(error instanceof Error ? error.message : String(error));
  }
}
```

Chamar `void carregarSugestoes();` no fim de `carregar()`, depois do `render()`. Acrescentar ao `index.html`, dentro de `.adm-top`, o botão de fusão manual:

```html
      <button id="adm-fundir" type="button">Fundir selecionados</button>
```

e em `admin.ts`:

```ts
document.querySelector<HTMLButtonElement>('#adm-fundir')?.addEventListener('click', () => {
  void fundir();
});
```

O `render()` passa a habilitar/desabilitar o botão:

```ts
  const botaoFundir = document.querySelector<HTMLButtonElement>('#adm-fundir');
  if (botaoFundir !== null) botaoFundir.disabled = !canMerge(state);
```

- [ ] **Step 6: Verificar de ponta a ponta**

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS.

Depois, com `npm run dev`, abrir `http://localhost:5173/admin/`, e conferir à mão: renomear uma série muda o nome no catálogo da TV; ocultar tira o canal da home; "Capa/Sinopse" lista candidatos e aplicar troca a capa na hora (sem esperar cache); "Fundir selecionados" some com o canal duplicado; um `npm run scan` depois disso não recria nada do que foi fundido nem desfaz o nome.

- [ ] **Step 7: Commit**

```bash
git add src/web/admin tests/web/admin-state.test.ts
git commit -m "feat(web): acoes de curadoria no painel /admin"
```

---

## Verificação final

- [ ] `npm test` verde
- [ ] `npm run typecheck` sem erro
- [ ] `npm run build` gera `dist/web/admin/index.html`
- [ ] `npm run scan` depois de uma fusão manual não recria a série fundida
- [ ] `POST /api/library/metadata` com `{"reset": true}` não apaga capa marcada como manual
