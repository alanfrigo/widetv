# Administração do acervo pela web — design

Painel de curadoria do catálogo, servido pela própria instância do widetv em
`/admin`, separado da SPA de TV. Cinco operações: fundir séries duplicadas,
escolher capa e sinopse entre os resultados dos provedores, renomear série,
ocultar série do catálogo e fixar número de canal.

## Problema

O índice é derivado do disco. `scanLibrary` deriva o nome da pasta,
`upsertShow` grava por slug e reescreve `name` a cada rodada, e `pruneShows`
apaga a linha da série cuja pasta sumiu. Toda decisão humana sobre o catálogo —
"estas duas pastas são a mesma série", "esta série chama-se assim", "esta capa
está errada" — é apagada pelo rescan noturno seguinte.

`mergeDuplicateShows` (em `library/dedupe.ts`) resolve um caso restrito e
automático: gêmeos de digest e canal-fantasma de temporada, ambos verificáveis
sem olhar o disco. Duplicata que não cai nessas duas assinaturas não tem
conserto hoje, e a fusão manual pelo banco volta no scan seguinte.

## Decisão central: overrides chaveados por slug

Tabelas próprias, chaveadas pelo **slug de pasta** — o único identificador
estável entre rodadas — e sem chave estrangeira para `shows`.

A ausência da FK é deliberada: uma raiz sem permissão ou um volume desmontado
levam a linha de `shows` no prune, e um `ON DELETE CASCADE` levaria a curadoria
junto. O override precisa sobreviver justamente ao acidente que motiva o
rescan.

Alternativas descartadas:

- **Colunas em `shows`** (`name_override`, `hidden`, `merged_into`): o merge
  APAGA a linha da fonte, então não sobra onde gravar para onde ela foi. E o
  prune leva o override no primeiro NAS fora do ar.
- **JSON na tabela `settings`**: sem migração, mas "listar ocultos" vira parse
  de JSON em caminho de request e o serviço de settings passa a ter dois donos.

## 1. Modelo de dados

Migração 13 em `library/index-store.ts` (`SCHEMA_VERSION = 13`):

```sql
CREATE TABLE IF NOT EXISTS show_override (
  slug TEXT PRIMARY KEY,
  name TEXT,                 -- null = usa o nome derivado da pasta
  hidden INTEGER NOT NULL DEFAULT 0,
  channel_number INTEGER,    -- null = numero automatico
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS show_alias (
  slug TEXT PRIMARY KEY,           -- pasta que foi fundida
  target_slug TEXT NOT NULL,       -- pasta que sobreviveu
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_show_alias_target ON show_alias (target_slug);

ALTER TABLE show_metadata ADD COLUMN manual INTEGER NOT NULL DEFAULT 0;
```

Métodos novos em `Store`:

| Método | Contrato |
|---|---|
| `listShowOverrides()` | `ShowOverrideRow[]`, todas as linhas |
| `getShowOverride(slug)` | `ShowOverrideRow \| null` |
| `setShowOverride(row)` | upsert; linha totalmente neutra (name null, hidden 0, channel null) é DELETADA em vez de gravada |
| `listShowAliases()` | `ShowAliasRow[]` |
| `addShowAlias(slug, targetSlug)` | grava com o alvo já resolvido ao slug final e reaponta, na mesma transação, os aliases que miravam o slug recém-fundido |
| `removeShowAlias(slug)` | desfaz a fusão |
| `setChannelNumber(showId, n)` | transação com swap; `channel_number` é UNIQUE, então a troca passa por um valor temporário negativo. Quem chama (o PATCH) precisa reconciliar o override da série DESLOCADA: sem isso as duas reivindicam o mesmo número e `channelNumberFixes` inverte a dupla a cada scan, para sempre |
| `listVisibleShows()` | `listShows()` menos os slugs com `hidden = 1` |

`ShowMetadataRow` ganha `manual: boolean`.

**Cadeia de alias.** O alvo é resolvido no momento da escrita: `addShowAlias`
segue a cadeia até o slug final e recusa quando o resultado é a própria fonte
(ciclo). A leitura ainda resolve com guarda de ciclo, porque um banco escrito
por versão anterior não tem essa garantia.

**Ocultar.** `listShows()` continua devolvendo tudo — o painel precisa ver o
que está oculto. O filtro entra em `channels/service.ts`: `listChannels` e
`listNowPlaying` passam a ler `listVisibleShows()`. Acesso direto por número de
canal (`/api/channels/:n/now`, `/episodes`, `/poster`) continua funcionando; o
que some é a entrada no catálogo.

## 2. Contrato HTTP

`src/server/admin/routes.ts`, atrás do guard de sessão que já cobre `/api/`.
Tipos em `@shared/api-types`.

```
GET    /api/admin/shows                            -> AdminShow[]
GET    /api/admin/merge-suggestions                -> MergeSuggestion[]
PATCH  /api/admin/shows/:id      { name?, hidden?, channelNumber? }  -> AdminShow
POST   /api/admin/shows/:id/merge   { sourceIds: number[] }          -> 202
POST   /api/admin/shows/:id/unmerge { slug: string }                 -> 202
GET    /api/admin/shows/:id/metadata/search?q=...  -> MetadataCandidate[]
PUT    /api/admin/shows/:id/metadata { candidate } -> AdminShow
DELETE /api/admin/shows/:id/metadata               -> 202
```

```ts
export interface AdminShow {
  id: number;
  slug: string;
  name: string;
  /** basename de absolutePath: o nome REAL da pasta, para a pessoa se achar. */
  folderName: string;
  channelNumber: number;
  episodeCount: number;
  seasons: number[];
  hidden: boolean;
  /** true quando o nome exibido veio de override, e nao da pasta. */
  renamed: boolean;
  year: number | null;
  overview: string | null;
  source: string | null;
  /** Capa/sinopse escolhidas a mao: o enriquecimento automatico nao toca. */
  manual: boolean;
  posterUrl: string | null;
  backdropUrl: string | null;
  /** Slugs de pastas fundidas nesta serie. Vazio quando nao houve fusao. */
  mergedSlugs: string[];
}

export interface MergeSuggestion {
  /** Por que o agrupamento foi sugerido, para a pessoa julgar. */
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
```

### Segurança do PUT de metadata

O corpo carrega URLs de imagem escolhidas pelo cliente e o servidor as baixa.
Sem trava isso é SSRF: dá para apontar o servidor para `169.254.169.254` ou
para qualquer host da rede onde ele roda. O download só aceita:

- esquema `https`;
- host em allowlist: `image.tmdb.org`, `static.tvmaze.com`, e qualquer
  subdomínio de `mzstatic.com`.

URL fora disso é 400, sem requisição nenhuma. A sessão única não substitui esta
checagem — um cookie vaza mais fácil que a rede interna.

### Semântica das rotas de fusão

`merge` grava o alias de cada fonte e chama o `store.mergeShows` que já existe,
então o catálogo fica correto na hora. `unmerge` apaga o alias e dispara scan
incremental, e o desfazer real acontece lá: `upsertEpisodes` faz
`ON CONFLICT(id) DO UPDATE SET show_id`, então o arquivo volta para o show
recriado.

**O invariante que isso exige do scan.** Não basta o upsert: depois de uma
fusão, os episódios da pasta fonte estão gravados sob o `show_id` do ALVO, e o
scan percorre as séries em ordem de nome. Quando o alvo vem primeiro — o caso
comum, `Serie` antes de `Serie Extra` — o `pruneEpisodes` DELE roda enquanto as
linhas da fonte ainda apontam para ele, e o `DELETE ... WHERE show_id = ? AND
id NOT IN keep_ids` as apaga. Como `watch_history.episode_id` tem
`ON DELETE CASCADE`, some junto a posição de retomada e a marca de "já vi" (e
também remux, variante de áudio e o quadro do episódio). As linhas são
reinseridas logo depois, então o catálogo parece certo e nada aparece no log.
Por isso `runScan` acumula `{ showId, keptEpisodeIds }` durante o laço e roda
TODOS os `pruneEpisodes` depois dele: só quando todo `upsertEpisodes` já
aconteceu é que cada arquivo em disco está sob o `show_id` final, e aí o prune
só alcança o que sumiu de verdade.

`merge` responde 202 e o painel acompanha por `GET /api/library/status`.
`unmerge` responde 202 quando o scan começou e **409 quando já havia um scan
rodando** — e, nesse caso, devolve o alias que tinha acabado de apagar: dizer
"recusei" e deixar a tabela sem o alias faria o scan seguinte (o noturno, sem
ninguém olhando) desfazer a fusão assim mesmo. Recolocar é melhor que
reordenar, porque `startScan` retorna antes de `runScan` ler a tabela de
alias.

## 3. Transform do scan

Módulo novo `src/server/library/overrides.ts`, puro — sem disco, sem SQLite:

```ts
export interface ShowOverride {
  slug: string;
  name: string | null;
  hidden: boolean;
  channelNumber: number | null;
}
export interface ShowAlias { slug: string; targetSlug: string }

/** Segue a cadeia de alias com guarda de ciclo. Devolve o slug final. */
export function resolveAliasTarget(
  slug: string,
  aliases: ReadonlyMap<string, string>,
): string;

/** Funde as pastas com alias e aplica o nome manual. Nao conhece o banco. */
export function applyShowOverrides(
  shows: readonly ScannedShow[],
  aliases: readonly ShowAlias[],
  overrides: readonly ShowOverride[],
): ScannedShow[];
```

Regras:

- A fonte com alias tem os episódios anexados ao show alvo e some da lista. O
  `absolutePath` que fica é o do alvo.
- Depois de concatenar, os episódios são reordenados por `compareEpisodes` e
  `orderIndex` é reescrito — o mesmo que `groupFolders` já faz na fusão
  automática do scanner. Sem isso a S02 de uma pasta estreia antes da S01 da
  outra, porque a ordem de leitura do filesystem não tem relação com a ordem
  das temporadas. Exige **exportar `compareEpisodes`** de `scanner.ts`, hoje
  privado.
- Alias cujo alvo não apareceu na varredura (pasta desmontada) é ignorado: a
  fonte fica como show próprio. Não há duplicata, porque o alvo também não
  está lá.
- `name` do override substitui o nome derivado. Como `shows.name` é o termo que
  `lookupShowMetadata` usa, renomear passa a valer para a busca de capa sem
  código extra.

Mudanças em `scan-job.ts`:

```ts
const scanned = await scanLibrary(root, { smartGrouping });
const shows = applyShowOverrides(scanned, store.listShowAliases(), store.listShowOverrides());
```

e, no fim da rodada, `reconcileChannelNumbers(store)`, que reaplica
`channel_number` fixado para série que foi apagada e recriada. `keptSlugs` só
recebe slug resolvido: o slug fonte precisa ficar de fora para a linha dele
morrer no prune.

E a poda de episódios sai de dentro do laço: o laço só acumula
`{ showId, keptEpisodeIds }` e todos os `pruneEpisodes` rodam depois dele, pelo
invariante da §2 — desfazer uma fusão move episódios entre séries dentro da
mesma rodada. Série protegida (todos os arquivos ilegíveis) continua saindo
antes do upsert e nunca entra nessa lista.

Mutação pelo painel não espera scan: renomear faz `UPDATE shows.name` mais o
override; fundir chama `store.mergeShows` mais o alias.

## 4. Provedores com múltiplos resultados

`metadata/providers.ts` ganha, sem alterar o que existe:

```ts
export interface ShowCandidate {
  source: ProviderName;
  externalId: string;
  title: string;
  year: number | null;
  overview: string | null;
  posterUrl: string | null;
  backdropUrl: string | null;
}

export function searchShowCandidates(
  term: string,
  options?: ChainOptions,
): Promise<ShowCandidate[]>;
```

TMDB `search/tv` (até 10 resultados), TVMaze `/search/shows` (array, e não o
`singlesearch` de resultado único), iTunes `limit=10` em `tvShow` e `movie`.

Os três rodam em PARALELO. A serialização de duas buscas em voo do enricher
existe por etiqueta com API pública num varrimento de 460 séries; um clique
manual são três requisições, e a pessoa está olhando para a tela. Provedor que
falha não mata a busca: volta o que veio dos outros.

`metadata/service.ts` ganha:

```ts
export function applyManualMetadata(
  store: MetadataStore,
  dataDir: string,
  show: ShowRow,
  candidate: ShowCandidate,
  options?: EnrichOptions,
): Promise<void>;
```

Baixa capa e arte para os mesmos `posters/<showId>.jpg` e
`backdrops/<showId>.jpg` pelo `writeArt` atômico existente, e grava a linha com
`manual: true`, `notFound: false` e `source` do candidato.

Três guardas para a escolha manual não ser atropelada:

1. `listShowsMissingMetadata` pula linha `manual` em qualquer escopo.
2. O `reset` do painel (`refreshMetadata(true)` em `scan-controller.ts`), que
   hoje regrava tudo como `not_found`, passa a pular linha `manual`. Sem isso
   um clique em "refazer tudo" apaga a curadoria inteira.
3. `enrichOne` já funde campo a campo; com `manual` fora da fila ele nem chega
   a ser chamado para a série.

`DELETE /api/admin/shows/:id/metadata` é a saída: zera `manual`, marca
`not_found` e devolve a série para a fila automática.

**Cache-bust: nada a fazer.** `posterUrlOf` já emite
`/api/channels/:n/poster?v=<fetchedAt>` e `backdropUrlOf` usa
`backdropCheckedAt ?? fetchedAt`, justamente porque a rota de arte responde
`cache-control: private, max-age=86400`. `applyManualMetadata` grava
`fetchedAt` e `backdropCheckedAt` com o relógio da escolha, então a URL muda
sozinha e a capa nova aparece na hora — inclusive na TV Android, que consome o
mesmo campo de `ChannelSummary`.

## 5. Página /admin

Entry separada, e não uma tela da SPA de TV: o app de TV é dpad-first e digitar
nome de série no controle remoto é sofrimento, além de o bundle da TV não ter
motivo para carregar tabela de administração.

```
src/web/admin/index.html    # entry do vite
src/web/admin/admin.ts      # DOM + fetch
src/web/admin/state.ts      # decisao pura: filtro, selecao, validacao — sem DOM
src/web/admin/api.ts        # cliente das rotas /api/admin
src/web/admin/admin.css
```

`vite.config.ts` ganha
`build.rollupOptions.input = { main: 'index.html', admin: 'admin/index.html' }`.
Em desenvolvimento o Vite já serve `/admin/`. Em produção o `@fastify/static`
serve `dist/web/admin/index.html`, e o `setNotFoundHandler` ganha um ramo: url
que começa com `/admin` recebe `sendFile('admin/index.html')`.

Layout mouse-first, uma tela:

- **Topo:** busca por nome ou pasta, contagem de séries. Toda edição aplica na
  hora; não há botão "salvar".
- **Bloco de duplicados:** grupos sugeridos, cada um com escolha de alvo e
  botão "Fundir".
- **Tabela:** miniatura da capa, canal (input numérico), nome (input inline),
  pasta em cinza, número de episódios, selos `manual`/`oculto`/`renomeado`, e
  ações "Capa/Sinopse", "Ocultar", "Desfazer fusão".
- **Painel de metadata:** abre ao lado, busca pré-preenchida com o nome atual,
  grade de candidatos (pôster, título, ano, trecho da sinopse, selo do
  provedor); clicar aplica.

`fetch` que volta 401 redireciona para `/`: o login mora na SPA de TV e não
vale duplicar.

`state.ts` guarda filtro, seleção de fusão e validação de número de canal, sem
DOM — mesmo desenho de `settings.ts` e `tracks.ts`, e testável sem browser.

## 6. Sugestão de duplicados

Módulo puro `src/server/library/merge-suggest.ts`, com duas chaves de
agrupamento sobre as séries já indexadas:

1. **`nome-identico`** — `groupingKey(parseFolderTitle(show.name))`, que já
   existe em `title-parser.ts` e produz `slug-ascii` ou `slug-ascii@ano`. Anos
   explícitos e diferentes caem em chaves diferentes, então "Doctor Who (1963)"
   e "Doctor Who (2005)" nunca são sugeridos juntos — é a mesma regra
   conservadora de `dedupe.ts`.
2. **`slug-parecido`** — slug sem o sufixo de digest de `disambiguateSlugs`
   (`-<6 hex>` com o `-<n>` opcional). Pega o par cujo nome divergiu mas cuja
   pasta é claramente a mesma série desambiguada.

Grupo com mais de uma série vira sugestão. `showIds` sai ordenado por número de
episódios decrescente: o primeiro é o alvo padrão na tela. Um par que caia nas
duas chaves aparece uma vez só, com `reason: 'nome-identico'`.

Sugestão é sugestão: nada aqui funde sozinho. A fusão automática continua sendo
só a de `dedupe.ts`, que exige prova verificável sem olhar o disco.

## 7. Testes

TDD conforme `docs/CONTRACTS.md`: teste falhando primeiro, verificado falhando,
depois o código mínimo.

| Arquivo | Cobre |
|---|---|
| `tests/library/overrides.test.ts` | resolução de alias, ciclo, alvo ausente, concat com reindex de temporadas, nome override |
| `tests/library/merge-suggest.test.ts` | agrupa gêmeo de digest; "(1963)" vs "(2005)" não agrupa |
| `tests/library/index-store.test.ts` | migração 13 sobre banco v12; override sobrevive a `pruneShows`; swap de canal com a UNIQUE |
| `tests/library/scan-job.test.ts` | scan com alias funde e não recria a fonte; `keptSlugs` sem o slug fonte; histórico sobrevive ao scan que desfaz a fusão (com o alvo ordenado primeiro) |
| `tests/metadata/providers.test.ts` | parsing de candidatos dos três provedores com `fetch` dublê; provedor que cai não zera a lista |
| `tests/metadata/service.test.ts` | `manual` fora da fila do enricher; `reset` não apaga linha manual |
| `tests/admin/routes.test.ts` | validação de corpo, allowlist de host da imagem, troca de canal ocupado (com o override do deslocado reconciliado), 409 do `unmerge` devolvendo o alias, 404 em série inexistente |
| `tests/web/admin-state.test.ts` | filtro, seleção de fusão, validação de número de canal |

## 8. Ordem de implementação

Cada fatia verde antes da seguinte:

1. Store: migração 13, métodos de override/alias, `listVisibleShows`,
   `setChannelNumber`, `manual` em `ShowMetadataRow`.
2. `library/overrides.ts` puro, com `compareEpisodes` exportado do scanner.
3. `scan-job.ts`: transform na entrada, reconciliação de canal na saída.
4. `library/merge-suggest.ts`.
5. `metadata/providers.ts` (`searchShowCandidates`) e
   `metadata/service.ts` (`applyManualMetadata` mais os três guardas do
   `manual`).
6. `admin/routes.ts` e os tipos em `@shared/api-types`; filtro de ocultos em
   `listChannels`/`listNowPlaying`.
7. Página `/admin` (vite multi-entry, ramo do `setNotFoundHandler`, UI).

## Fora de escopo

Editar ano e sinopse à mão (só escolha de candidato), upload de imagem própria,
renomear episódio, mover episódio entre temporadas, e qualquer operação que
mexa em arquivo do acervo em disco. O painel só escreve no índice e em
`DATA_DIR`.
