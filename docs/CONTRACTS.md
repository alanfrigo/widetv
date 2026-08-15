# widetv - contratos internos

Cada modulo abaixo e implementado de forma independente. As assinaturas sao
fixas: outro modulo ja depende delas. Se uma assinatura parecer errada durante a
implementacao, **nao mude sozinho** - reporte, porque a mudanca quebra o vizinho.

O widetv e widescreen-only: nao existe modo de apresentacao, nem `/api/config`,
nem skin de CRT. O que existe e um catalogo (com capa, ano e sinopse) somado a
uma grade ao vivo por serie.

Regras validas para todos:

- TypeScript ESM estrito. `noUncheckedIndexedAccess` e `exactOptionalPropertyTypes` estao ligados.
- Testes em `tests/<area>/<modulo>.test.ts`, vitest com `globals: true`.
- TDD: teste falhando primeiro, verificado falhando, depois o codigo minimo.
- Sem dependencia nova sem necessidade real.
- Import do contrato HTTP: `import type { ... } from '@shared/api-types'`.

---

## 1. `src/server/library/scanner.ts`

Percorre a biblioteca e devolve series com episodios ordenados. **So filesystem e
nomes** - nao chama ffprobe, nao abre arquivo, nao toca em SQLite.

```ts
export interface ScannedEpisode {
  absolutePath: string;
  /** Caminho relativo a raiz, com separador '/'. Id estavel do arquivo. */
  relativePath: string;
  /** Nome do arquivo sem extensao, usado como titulo de exibicao. */
  title: string;
  /** Numero da temporada quando derivavel da pasta ou do nome; senao null. */
  season: number | null;
  /** Numero do episodio quando derivavel do nome; senao null. */
  episode: number | null;
  /** Posicao 0-based na grade da serie, apos ordenacao. */
  orderIndex: number;
}

export interface ScannedShow {
  /** Id estavel derivado do nome da pasta (kebab-case, ASCII). */
  slug: string;
  /** Nome da pasta, como esta em disco. */
  name: string;
  absolutePath: string;
  episodes: ScannedEpisode[];
}

export interface ScanOptions {
  /** Extensoes aceitas, minusculas, com ponto. Default: ['.mp4', '.mkv', '.webm', '.m4v'] */
  extensions?: string[];
}

export function scanLibrary(root: string, options?: ScanOptions): Promise<ScannedShow[]>;
```

Comportamento obrigatorio:

- Dois schemas de pasta: `RAIZ/SERIE/*.mp4` e `RAIZ/SERIE/TEMPORADA N/*.mp4`.
  Uma mesma serie pode misturar os dois (arquivos soltos + pastas de temporada);
  nesse caso os arquivos soltos vem antes das pastas de temporada.
- Ordenacao: **natural sort** case-insensitive, entre pastas de temporada e entre
  arquivos. `ep2` vem antes de `ep10`. `Temporada 2` antes de `Temporada 10`.
- Pastas de temporada sao reconhecidas por regex tolerante:
  `temporada`, `season`, `s01`, `t01`, com ou sem zero a esquerda, qualquer caixa.
  Pasta que nao casar com isso ainda e percorrida, mas `season` fica null.
- `season`/`episode` sao **melhor esforco**: tente `S01E02`, `1x02`, `- 02 -`,
  `Ep 02`, `[02]`. Sem match confiavel, retorne null. Nunca invente numero a
  partir da posicao - `orderIndex` ja cobre isso.
- Ignore arquivos ocultos (`.` inicial), `@eaDir`, `.AppleDouble`, `#recycle`,
  e qualquer extensao fora da lista.
- Serie sem nenhum episodio valido nao aparece no resultado.
- Series ordenadas por `name` com natural sort.
- Raiz inexistente: lanca erro com o caminho na mensagem.
- Nao siga symlinks para fora da raiz.
- Escala alvo: 300+ series, dezenas de milhares de arquivos. Use leitura de
  diretorio assincrona com concorrencia limitada, nao serial ingenua.

Testes cobrem no minimo: os dois schemas, mistura dos dois, natural sort de
arquivos e de temporadas, extracao de S/E nos cinco formatos, arquivos ignorados,
serie vazia, raiz inexistente, acentos e maiusculas no slug.

---

## 2. `src/server/library/probe.ts`

Unica porta de entrada para `ffprobe` no projeto inteiro.

```ts
export interface ProbeResult {
  durationMs: number;
  videoCodec: string | null;
  audioCodec: string | null;
  width: number | null;
  height: number | null;
  /** true quando o atomo `moov` esta antes do `mdat` (seek inicial rapido). */
  faststart: boolean;
  /** Trilhas embutidas; veja 8.1. `index` relativo dentro do tipo. */
  audioTracks: AudioTrackRef[];
  subtitleTracks: SubtitleTrackRef[];
}

export class ProbeError extends Error {
  constructor(filePath: string, cause: string);
  readonly filePath: string;
}

export interface ProbeOptions {
  /** Caminho do binario. Default: 'ffprobe' no PATH. */
  ffprobePath?: string;
  /** Timeout por arquivo em ms. Default: 30000. */
  timeoutMs?: number;
}

export function probeFile(filePath: string, options?: ProbeOptions): Promise<ProbeResult>;
```

Comportamento obrigatorio:

- Usa `child_process.execFile` com array de argumentos. **Nunca** monte string de
  shell: nomes de desenho tem espaco, acento, aspas e parenteses.
- Uma unica invocacao por arquivo, `-v quiet -print_format json -show_format -show_streams`.
- `durationMs` vem de `format.duration`; se ausente, cai para a duracao do stream
  de video. Sem nenhuma das duas: `ProbeError`.
- Duracao 0, negativa ou `NaN` e erro, nao resultado valido - um episodio de
  duracao zero trava a grade num loop infinito.
- `faststart`: use `-show_entries format_tags` nao serve. Detecte lendo os
  primeiros bytes do arquivo e comparando a posicao dos atomos `moov` e `mdat`.
  Arquivo que nao for MP4/MOV: `faststart` = true (nao se aplica).
- Timeout mata o processo e lanca `ProbeError`.
- Exit code != 0 ou JSON invalido: `ProbeError` com stderr resumido.

Testes usam arquivos reais minusculos gerados por `ffmpeg` num `beforeAll`
(1-2 segundos de cor solida, isso e rapido). Pule os testes com `test.skipIf` se
`ffmpeg` nao existir no PATH, mas nao mocke o ffprobe: o valor deste modulo esta
justamente em falar com o binario de verdade.

---

## 3. `src/server/schedule/clock.ts`

O coracao da grade. **Funcao pura**: sem I/O, sem `Date.now()`, sem estado de
modulo. Tudo entra por parametro.

```ts
export interface ScheduleEntry {
  id: string;
  durationMs: number;
}

export interface Slot {
  /** Indice em `entries` do que esta no ar. */
  index: number;
  /** Posicao dentro desse item, em ms, no instante `nowMs`. */
  offsetMs: number;
  /** Epoch ms em que esse item termina. */
  endsAtMs: number;
  /** Indice do proximo item; volta a 0 depois do ultimo. */
  nextIndex: number;
}

export class EmptyScheduleError extends Error {}

/** Somas prefixas cumulativas; exportada para permitir cache por canal. */
export function buildTimeline(entries: readonly ScheduleEntry[]): Int32Array | Float64Array;

export function resolveSlot(
  entries: readonly ScheduleEntry[],
  epochMs: number,
  nowMs: number,
  timeline?: ReturnType<typeof buildTimeline>,
): Slot;

/**
 * Deslocamento estavel por canal, para que canais diferentes nao estejam todos
 * no episodio 1 no mesmo instante. Deve ser deterministico e depender apenas
 * de `channelId` e `cycleMs`.
 */
export function channelPhaseOffsetMs(channelId: string, cycleMs: number): number;
```

Comportamento obrigatorio:

- `elapsed = ((nowMs - epochMs) % cycle + cycle) % cycle` - o modulo tem que
  funcionar para `nowMs < epochMs` (epoch no futuro) sem retornar negativo.
- Busca binaria sobre as somas prefixas. Series longas tem centenas de
  episodios e essa funcao roda em todo request.
- `entries` vazio: `EmptyScheduleError`.
- `durationMs <= 0` em qualquer entrada: erro, nao pule silenciosamente.
- Fronteira exata: quando `elapsed` cai exatamente no inicio de um item, o
  resultado e esse item com `offsetMs = 0`, nunca o anterior com offset igual a
  duracao dele.
- Serie de um episodio so: sempre `index = 0`, `nextIndex = 0`.
- Duracoes somadas passam de 2^31 ms (~24 dias) com facilidade em 300 episodios;
  use `Float64Array`, nao `Int32Array`, se a soma puder estourar.
- Precisao: use inteiros de ms o tempo todo, sem ponto flutuante intermediario
  em segundos.

Testes cobrem no minimo: primeiro item, item do meio, ultimo item, wrap do loop,
fronteira exata entre dois itens, fronteira exata no wrap, `nowMs === epochMs`,
epoch no futuro, um episodio so, lista vazia, duracao invalida, cycle grande
(300 episodios de 22 min, varias voltas), determinismo de `channelPhaseOffsetMs`
(mesma entrada, mesma saida; ids diferentes tendem a offsets diferentes; offset
sempre em `[0, cycleMs)`).

---

## 4. `src/server/library/index-store.ts`

Persistencia SQLite. Dono exclusivo do schema.

```ts
export interface ShowRow {
  id: number;
  slug: string;
  name: string;
  channelNumber: number;
  absolutePath: string;
}

export interface EpisodeRow {
  id: string;              // relativePath, id estavel
  showId: number;
  absolutePath: string;
  title: string;
  season: number | null;
  episode: number | null;
  orderIndex: number;
  durationMs: number;
  videoCodec: string | null;
  audioCodec: string | null;
  width: number | null;
  height: number | null;
  faststart: boolean;
  /** Trilhas embutidas; veja 8.1. Colunas TEXT com JSON, `[]` quando desconhecido. */
  audioTracks: AudioTrackRef[];
  subtitleTracks: SubtitleTrackRef[];
  mtimeMs: number;
  size: number;
}

export interface Store {
  listShows(): ShowRow[];
  getShowByChannel(channelNumber: number): ShowRow | null;
  listEpisodes(showId: number): EpisodeRow[];
  getEpisode(id: string): EpisodeRow | null;

  /** Cria a serie se nova e atribui o proximo numero de canal livre. Idempotente por slug. */
  upsertShow(input: { slug: string; name: string; absolutePath: string }): ShowRow;

  upsertEpisodes(showId: number, rows: readonly Omit<EpisodeRow, 'showId'>[]): void;

  /** Remove episodios da serie que nao estao em `keepIds`. */
  pruneEpisodes(showId: number, keepIds: readonly string[]): number;

  /** Remove series que sumiram do disco. Numeros de canal removidos nao sao reciclados. */
  pruneShows(keepSlugs: readonly string[]): number;

  /** Probe cacheado, valido apenas se mtime e size baterem. */
  getCachedProbe(id: string, mtimeMs: number, size: number): ProbeResult | null;

  /** Metadata externa da serie; null quando nunca foi buscada. Veja 9. */
  getShowMetadata(showId: number): ShowMetadataRow | null;
  upsertShowMetadata(row: ShowMetadataRow): void;

  close(): void;
}

export function openStore(dbPath: string): Store;
```

Comportamento obrigatorio:

- `channelNumber` e atribuido **uma vez**, na primeira vez que o slug aparece, e
  nunca recalculado. Rescan com series novas nao pode mexer nos numeros
  existentes. Primeiro canal e 1.
- Numero de canal de serie removida **nao volta** para o pool. Se a serie
  reaparecer com o mesmo slug depois de um prune, recebe um numero novo.
- `upsertEpisodes` roda numa transacao unica. 300 series x centenas de episodios
  precisa de statements preparados, nao string interpolada.
- `PRAGMA journal_mode = WAL`, `PRAGMA foreign_keys = ON`.
- Schema criado no `openStore` se nao existir, com tabela `schema_version` e
  migracao por versao. `dbPath` `:memory:` funciona (os testes usam isso).
  Migracao ja aplicada e imutavel: schema novo entra como uma entrada nova em
  `MIGRATIONS` (versao 2 = `ALTER TABLE` das trilhas; versao 3 = tabela
  `show_metadata`), nunca editando a 1.
- `faststart` guardado como INTEGER 0/1 e devolvido como boolean.
- Diretorio de `dbPath` e criado se faltar.

Testes cobrem no minimo: estabilidade do numero de canal entre rescans, canal
novo pega o proximo livre, numero de serie removida nao e reciclado, cache de
probe invalidado por mtime e por size, prune de episodios, idempotencia de
upsert, roundtrip de boolean e de campos null.

---

## 5. `src/server/cli/survey.ts`

Script de medicao da Fase 0. Roda contra a biblioteca real antes de qualquer
decisao sobre transcode.

```
npm run survey -- /caminho/da/raiz [--sample 200] [--json relatorio.json]
```

Saida em texto no stdout:

- total de series e de arquivos encontrados
- distribuicao de codecs de video e de audio, com contagem e percentual
- distribuicao de container por extensao
- quantos arquivos tem `faststart` e quantos nao tem
- distribuicao de resolucao (agrupada: <=480p, 720p, 1080p, acima)
- duracao total do acervo e duracao mediana de episodio
- lista de arquivos que falharam no probe, com o motivo
- ao final, um veredito explicito em uma linha para cada risco:
  `H265 DIRECT PLAY: risco alto/baixo` e `FASTSTART: X% precisam de remux`

`--sample N` faz probe de apenas N arquivos amostrados de forma determinista
(espalhados pelo acervo, nao os N primeiros) - a biblioteca inteira pode levar
muito tempo. Sem `--sample`, faz tudo.

Concorrencia = numero de CPUs. Barra de progresso simples em stderr, para nao
sujar o stdout quando alguem redirecionar.

Reusa `scanLibrary` e `probeFile`. Nao toca em SQLite.

---

## 6. Paridade entre os clientes

Nao ha contrato de camadas de CSS aqui - o visual e livre. O que e contrato:

- O video e um elemento `<video>` de verdade. **Sem WebGL, sem canvas** como
  caminho de imagem: o cliente Android usa um player nativo, e qualquer efeito
  que dependa de pintar quadro a quadro no navegador nao teria equivalente la.
- Nada de CDN. O app precisa funcionar sem internet de saida: fonte, icone e
  qualquer asset ficam auto-hospedados. A unica coisa que sai para a internet e
  a busca de metadata (secao 8), no servidor, nunca no cliente.
- O cliente nao guarda estado de negocio. A API e a unica fonte de verdade; o
  unico dado local aceitavel e preferencia de quem assiste (ultimo canal,
  volume).

---

## 7. `src/server/auth/` + Docker

```ts
// src/server/auth/password.ts
export function hashPassword(plain: string): Promise<string>;
export function verifyPassword(plain: string, hash: string): Promise<boolean>;

// src/server/auth/session.ts
export interface SessionConfig {
  secret: string;
  secureCookies: boolean;
  ttlMs: number;
}
export function issueSessionCookie(config: SessionConfig, issuedAtMs: number): string;
export function verifySessionCookie(config: SessionConfig, value: string, nowMs: number): boolean;
```

Comportamento obrigatorio:

- Hash argon2id via `node:crypto` (`crypto.hash`? nao existe) - use o pacote
  `argon2`. Se a instalacao nativa der problema, use `scrypt` do `node:crypto`
  com salt aleatorio de 16 bytes e formato `scrypt$N$r$p$salt$hash`; documente
  a escolha.
- Comparacao de hash em tempo constante (`crypto.timingSafeEqual`).
- Cookie de sessao **stateless**: `<issuedAtMs>.<hmac-sha256>`, assinado com
  `secret`. `verifySessionCookie` valida assinatura em tempo constante e expira
  por `ttlMs`. Nao guarde sessao em memoria - o servidor pode reiniciar.
- Cookie: `httpOnly`, `SameSite=Lax`, `Path=/`, `Secure` quando
  `secureCookies` for true.
- `src/server/cli/hash-password.ts`: le a senha de stdin (sem eco se possivel),
  imprime o hash. Adicione o script `hash-password` no package.json.

Entrega tambem:

- `Dockerfile` multi-stage: builder instala tudo e roda `npm run build`; runtime
  parte de `node:22-slim`, instala so `ffmpeg` (para o survey/probe) e as
  dependencias de producao, roda como usuario nao-root.
  `better-sqlite3` e nativo: garanta que o rebuild aconteca no stage certo,
  mesma arquitetura.
- `docker-compose.yml`: monta `LIBRARY_ROOT` como `:ro`, um volume nomeado para
  `DATA_DIR`, healthcheck, `restart: unless-stopped`.
- `docs/DEPLOY.md`: passo a passo no TrueNAS SCALE (app customizado a partir do
  compose), como gerar `SESSION_SECRET` e `AUTH_PASSWORD_HASH`, e a configuracao
  de reverse proxy com HTTPS. Deixe explicito que expor sem HTTPS entrega o
  cookie de sessao em texto claro.

Testes: `password.ts` e `session.ts` sao testaveis puros - hash verifica,
hash errado falha, cookie valido passa, assinatura adulterada falha, cookie
expirado falha, cookie malformado falha.

---

## 8. Catalogo sob demanda

O catalogo VOD (`/api/channels/:number/episodes`) e a grade ao vivo
(`/api/channels/:number/now`) convivem: o servidor serve os dois, e o cliente
decide o que mostrar.

```ts
// src/server/channels/service.ts
/**
 * Episodios do canal na ordem da grade, para o catalogo sob demanda.
 * @returns null quando o canal nao existe; [] quando existe sem episodios.
 */
export function listChannelEpisodes(source: ChannelSource, channelNumber: number): EpisodeRef[] | null;
```

- `GET /api/channels/:number/episodes` devolve `EpisodeRef[]` cru, sem
  envelope, na ordem da grade. `cache-control: no-store`.

| Situacao | Status | Corpo |
| --- | --- | --- |
| Numero de canal invalido (nao casa `/^\d+$/`) | 400 | `{ error }` |
| Canal inexistente | 404 | `{ error }` |
| Canal existe sem episodios | 200 | `[]` |
| Canal existe com episodios | 200 | `EpisodeRef[]` |

`EpisodeRef` ganha dois campos, obrigatorios e nulaveis (nao opcionais - o
projeto liga `exactOptionalPropertyTypes`):

```ts
export interface EpisodeRef {
  // ...
  /** null quando o probe nao descobriu. */
  width: number | null;
  /** null quando o probe nao descobriu. Cliente deriva o badge, ex.: >=2160 "4K". */
  height: number | null;
}
```

Os dados ja existem no SQLite (`EpisodeRow.width`/`height`, populados pelo
probe) - sem migracao.

Regra de espelhamento: todo campo novo do contrato HTTP (`EpisodeRef.width`/
`height`, `ChannelSummary.posterUrl`/`year`/`overview`, as novas entradas de
`API`) tem que aparecer tambem em
`android/app/src/main/java/com/retrotv/app/net/Models.kt`. No Kotlin, todo
campo novo entra com **default null** (ou `emptyList()`): um servidor mais
antigo nao manda o campo, e o app tem que continuar tocando do mesmo jeito.

### 8.1 Trilhas de audio e legenda

O acervo novo e MKV dual-audio (dois E-AC-3: `por` "Brazilian" default e `eng`)
com dezenas de legendas subrip embutidas. O cliente precisa saber o que existe
dentro do arquivo antes de tocar, e o web precisa da legenda em WebVTT porque o
`<track>` do navegador nao le subrip de dentro do container.

```ts
/** Faixa de audio embutida. `index` e relativo entre audios (0-based). */
export interface AudioTrackRef {
  index: number;
  lang: string | null;    // tag language do container (ISO 639-2), ex. "por"
  title: string | null;   // tag title, ex. "Brazilian"
  codec: string | null;   // ex. "eac3"
  isDefault: boolean;
}

/** Legenda embutida. `index` relativo entre legendas (0-based), casa com `-map 0:s:N`. */
export interface SubtitleTrackRef {
  index: number;
  lang: string | null;
  title: string | null;
  codec: string | null;   // ex. "subrip"
  isDefault: boolean;
  forced: boolean;
}

export interface EpisodeRef {
  // ...
  audioTracks: AudioTrackRef[];
  subtitleTracks: SubtitleTrackRef[];
}
```

- `index` e **relativo dentro do tipo**, na ordem do container - nao e o indice
  do stream no arquivo. Um mkv com video + 2 audios + 2 legendas tem audios 0 e
  1 e legendas 0 e 1, embora no container elas sejam os streams 3 e 4. E
  exatamente o `N` que o `-map 0:s:N` do ffmpeg entende.
- Os dois campos sao **sempre presentes**; `[]` quando o indice nao conhece as
  trilhas (linha gravada por uma versao anterior, arquivo sem audio, etc.).
  Cliente nenhum pode assumir que ha pelo menos uma faixa.
- `probe.ts` popula os dois a partir do `-show_streams` que ja era pedido: ele
  ja traz `tags.language`, `tags.title` e `disposition`. Nao ha `-show_entries`
  a acrescentar - ele so restringiria o que ja vem. Stream com
  `disposition.attached_pic` (capa) e ignorado, como no video.
- `index-store.ts` guarda as duas listas como **JSON em colunas TEXT**
  (`audio_tracks`, `subtitle_tracks`), adicionadas na **migracao de schema 2**
  com `ALTER TABLE`. As colunas sao nulaveis de proposito: `NULL` significa
  "linha de antes das trilhas", e `getCachedProbe` trata isso como cache miss
  (`audio_tracks IS NOT NULL AND subtitle_tracks IS NOT NULL`), para um indice
  antigo ser reprobado mesmo com `mtime` e `size` iguais. A escrita nunca grava
  `NULL`: pior caso, `'[]'`. Leitura faz `JSON.parse` com fallback `[]` - texto
  corrompido nao pode derrubar a listagem do canal.

```
GET /api/stream/:id/subtitle/:track   ->  text/vtt; charset=utf-8
```

- `:id` e o mesmo id do stream direto (caminho relativo, um segmento
  percent-encoded). `API.subtitle(episodeId, track)` encoda o id **por dentro**
  (diferente de `API.stream`, que recebe o id ja encodado, como sempre recebeu).
- `:track` e o `index` de `subtitleTracks`.

| Situacao | Status |
| --- | --- |
| `:track` nao casa `/^\d+$/` | 400 |
| Episodio inexistente, arquivo sumido do disco, caminho fora da raiz | 404 |
| `:track` fora do range de `subtitleTracks` (inclui indice sem trilhas) | 404 |
| Codec de legenda que nao e texto (ex.: `hdmv_pgs_subtitle`) | 415 |
| ffmpeg falhou ou estourou o timeout (60 s) | 500 |
| Legenda extraida | 200 |

- Codecs aceitos: `subrip`, `ass`, `webvtt`, `mov_text`. Legenda em bitmap so
  viraria texto com OCR; 415 e melhor do que deixar o cliente esperando.
- Extracao: `ffmpeg -nostdin -v error -i <arquivo> -map 0:s:<track> -f webvtt
  pipe:1`, com a mesma protecao de path traversal do `direct.ts`
  (`resolveWithinRoot`).
- **Isto nao e transcode de video.** A proibicao do projeto vale para imagem:
  recodificar video em software derruba o NAS sem GPU. Aqui o ffmpeg so
  reescreve dialogos de texto - kilobytes, uma vez por faixa.
- Cache em disco em `<DATA_DIR>/subs/<sha1(relPath+track+mtimeMs+size)>.vtt`,
  escrito em temporario e renomeado (rename e atomico: ninguem le um `.vtt`
  pela metade, nem com dois espectadores pedindo a mesma legenda). `mtime` e
  `size` na chave garantem que um remux invalide o cache. Resposta com
  `cache-control: private, max-age=3600`.
- A rota fica **atras do guard de sessao**, como o stream: nao entra em
  `PUBLIC_PATHS`.

---

## 9. `src/server/metadata/` - capa, ano e sinopse

Cada serie ganha capa e sinopse buscadas na internet uma unica vez. A regra que
manda em tudo aqui: **nenhum request de usuario espera pela rede.** A rota de
canais no maximo dispara uma rodada e responde com o que ja existe no indice.

### 9.1 Provedores (`providers.ts`)

Sem dependencia nova: o `fetch` global do Node 22 basta.

```ts
export interface ShowMetadata {
  posterUrl: string | null;   // URL no provedor; quem baixa e o servico
  year: number | null;
  overview: string | null;    // SEMPRE texto puro, sem HTML
  source: 'tmdb' | 'tvmaze' | 'itunes';
}

export type LookupResult =
  | { status: 'found'; metadata: ShowMetadata }
  | { status: 'not-found' }
  | { status: 'error'; reason: string };

export function lookupShowMetadata(showName: string, options?: ChainOptions): Promise<LookupResult>;
```

Ordem da cadeia, parando no primeiro que devolver **capa**:

1. **TMDB** - so quando `TMDB_API_KEY` existe, e ai vem primeiro (melhor arte,
   sinopse em pt-BR): `/3/search/tv?query=&api_key=&language=pt-BR`, poster em
   `https://image.tmdb.org/t/p/w500<poster_path>`.
2. **TVMaze**, sem chave: `singlesearch/shows?q=`. O `summary` vem com HTML e e
   limpo antes de virar `overview`.
3. **iTunes Search**, sem chave: `media=tvShow` e, se vazio, `media=movie`. O
   `artworkUrl100` e um template - trocar `100x100` por `600x600` da a arte
   grande.

- Termo de busca = nome da pasta com o sufixo de ano entre parenteses removido
  (`Batman (1989)` -> `Batman`).
- Provedor que responde **sem** capa nao encerra a cadeia, mas o que ele achou
  fica guardado: se ninguem depois tiver capa, o resultado e `found` com
  `posterUrl: null`.
- HTTP 404 e "nao conheco" (`null`); qualquer outro status fora de 2xx, JSON
  invalido ou falha de transporte **lanca**. Um provedor que lanca nao derruba
  a cadeia: os proximos ainda sao tentados.
- Veredito final: `found` > `error` > `not-found`. Se qualquer provedor falhou
  por rede e ninguem achou nada, o resultado e `error` - marcar `not_found` por
  causa de um DNS fora do ar congelaria o acervo inteiro sem capa ate o TTL.

### 9.2 Persistencia (migracao 3)

```sql
CREATE TABLE show_metadata (
  show_id INTEGER PRIMARY KEY REFERENCES shows(id) ON DELETE CASCADE,
  poster_file TEXT,          -- so o NOME do arquivo, ex. "12.jpg"
  year INTEGER,
  overview TEXT,
  source TEXT,
  fetched_at INTEGER NOT NULL,
  not_found INTEGER NOT NULL DEFAULT 0
);
```

- `poster_file` guarda **nome**, nao caminho: `DATA_DIR` muda entre o host e o
  container, e caminho absoluto no banco viraria capa quebrada no deploy.
- A capa vive em `<DATA_DIR>/posters/<showId>.jpg`, escrita em temporario e
  renomeada (rename e atomico: ninguem le um JPEG pela metade).
- `not_found = 1` com `fetched_at`: so e reconsultado depois de **7 dias**.
- Serie ja encontrada nunca e reconsultada.
- **Erro de rede nao grava linha nenhuma** - inclusive quando a busca deu certo
  mas o download da capa falhou. Linha sem capa selaria o show como resolvido e
  a imagem nunca mais seria tentada.

### 9.3 Servico (`service.ts`)

```ts
export function enrichMissing(store: MetadataStore, dataDir: string, options?: EnrichOptions): Promise<EnrichReport>;
export function createEnricher(store: MetadataStore, dataDir: string, options?: EnrichOptions): Enricher;
```

- Concorrencia **2**. O gargalo nao e CPU, e educacao com uma API publica de
  graca: paralelismo alto so rende 429.
- `createEnricher` tem trava de "ja rodando": chamadas concorrentes recebem a
  MESMA promessa, e um show em voo nao entra em outra rodada.
- Uma serie que falha nao aborta as outras; tudo vira contador no `EnrichReport`.
- Disparado em dois lugares, sempre fire-and-forget: ao final do scan de
  bootstrap (`index.ts`) e quando `GET /api/channels` ve serie sem linha de
  metadata.

### 9.4 Contrato HTTP

```ts
export interface ChannelSummary {
  number: number;
  name: string;
  episodeCount: number;
  /** Rota da capa quando ha arquivo, senao null. Nunca URL de provedor. */
  posterUrl: string | null;
  year: number | null;
  overview: string | null;
}
```

Os tres campos sao obrigatorios e nulaveis (o projeto liga
`exactOptionalPropertyTypes`). `posterUrl` sai da coluna `poster_file`, nao de
um `stat` no disco: `listChannels` roda a cada request e 460 chamadas sincronas
ao filesystem custariam mais do que valem.

```
GET /api/channels/:number/poster   ->  image/jpeg
```

| Situacao | Status |
| --- | --- |
| `:number` nao casa `/^\d+$/` | 400 |
| Canal inexistente | 404 |
| Canal sem linha de metadata, ou linha sem `poster_file` | 404 |
| Arquivo apagado do volume | 404 |
| Capa presente | 200 |

`cache-control: private, max-age=86400`. Fica **atras do guard de sessao**, como
todo o resto - nao entra em `PUBLIC_PATHS`.
