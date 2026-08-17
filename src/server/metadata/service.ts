import { randomUUID } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ShowMetadataRow, ShowRow } from '../library/index-store';
import {
  downloadImage,
  ImageGoneError,
  lookupShowMetadata,
  type ChainOptions,
  type LookupResult,
} from './providers';

/**
 * Enriquecimento do acervo com capa, arte 16:9, ano e sinopse.
 *
 * Isto e I/O de rede no meio de um servidor de video: a regra que organiza o
 * modulo e que NENHUM request de usuario pode esperar por ele. `GET
 * /api/channels` no maximo *dispara* uma rodada e devolve o que ja existe no
 * indice; a capa aparece na proxima carga da tela.
 *
 * A trava de "ja rodando" nao e otimizacao. Sem ela, uma tela de canais que
 * recarrega a cada poucos segundos abriria uma rodada nova por carga, e 460
 * series x N rodadas simultaneas viram um flood na API do provedor - que
 * responde 429 e transforma um acervo inteiro em "nao encontrado".
 */

/**
 * So leitura: e o que a rodada precisa para decidir quais series buscar.
 *
 * O gatilho "ha serie sem metadata?" da rota de canais NAO passa por aqui: ele
 * roda a cada abertura do catalogo e vira uma consulta so no Store, em vez de
 * um `getShowMetadata` por serie.
 */
export interface MetadataReader {
  listShows(): ShowRow[];
  getShowMetadata(showId: number): ShowMetadataRow | null;
}

/**
 * Fonte estreita: este modulo so precisa das series e da tabela de metadata.
 *
 * Nao ha "apagar metadata" aqui de proposito. O reset do painel ("buscar tudo
 * de novo") e feito por quem orquestra, regravando as linhas com `fetchedAt: 0`
 * e `notFound: true` - o TTL vence na hora e a rodada seguinte reconsulta.
 * Um DELETE novo no Store so serviria a este caso e custaria mais uma migracao.
 */
export interface MetadataStore extends MetadataReader {
  upsertShowMetadata(row: ShowMetadataRow): void;
}

/** Quanto tempo um "nao encontrado" vale antes de valer a pena tentar de novo. */
export const NOT_FOUND_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Duas buscas em voo. O gargalo aqui nao e a nossa CPU, e a educacao com uma
 * API publica de graca: paralelismo alto so rende 429.
 */
const DEFAULT_CONCURRENCY = 2;

export interface EnrichOptions extends ChainOptions {
  concurrency?: number;
  /** Injetavel para teste. Default: `Date.now`. */
  now?: () => number;
  notFoundTtlMs?: number;
  /** Injetavel para teste; por padrao percorre a cadeia de provedores. */
  lookup?: (showName: string) => Promise<LookupResult>;
  /** Injetavel para teste; por padrao baixa a imagem de verdade. */
  download?: (url: string) => Promise<Uint8Array>;
  log?: (message: string) => void;
}

export interface EnrichReport {
  /** Series que estavam sem metadata (ou com not_found vencido) nesta rodada. */
  considered: number;
  found: number;
  /** Quantas ganharam arquivo de capa em disco. */
  posters: number;
  notFound: number;
  /** Falhas de rede: nada foi gravado, serao tentadas de novo. */
  failed: number;
}

/** Nome do arquivo de arte da serie. O id e numerico: nao ha o que escapar. */
export function posterFileName(showId: number): string {
  return `${String(showId)}.jpg`;
}

/** Mesmo nome da capa, em outro diretorio: a serie tem uma de cada. */
export function backdropFileName(showId: number): string {
  return `${String(showId)}.jpg`;
}

export function postersDir(dataDir: string): string {
  return join(dataDir, 'posters');
}

export function backdropsDir(dataDir: string): string {
  return join(dataDir, 'backdrops');
}

/**
 * Ate onde a rodada procura trabalho.
 *
 * `missing` e a rodada AUTOMATICA (boot, fim de scan, catalogo sem capa): so
 * serie sem linha nenhuma e `not_found` vencido. `refresh` e o botao do painel
 * ("so o que falta"), e ai vale tambem completar quem ficou sem arte 16:9.
 *
 * A diferenca de escopo muda o QUE entra na fila, nunca o que a gravacao pode
 * apagar: uma linha que ja tem capa, ano e sinopse so ganha campo, nunca perde.
 * Veja `enrichOne`.
 */
export type EnrichScope = 'missing' | 'refresh';

/**
 * Series que valem uma busca agora.
 *
 * Sempre: as que nunca foram buscadas e as marcadas como inexistentes ha mais
 * de `ttlMs`. Uma serie ja encontrada nunca volta SOZINHA - capa nao muda, e
 * reconsultar 460 series a cada boot seria abuso.
 *
 * No escopo `refresh`, entram tambem as que nunca tiveram a arte 16:9
 * procurada e as que ficaram SEM CAPA (o provedor respondeu sem imagem, ou a
 * imagem sumiu do CDN): "so o que falta" existe justamente para completar
 * buraco, e sem isto uma serie encontrada sem poster ficaria selada para
 * sempre. O criterio da arte e `backdropCheckedAt`, e nao `backdropFile ===
 * null`: o segundo confunde "ainda nao procurei" com "procurei e o provedor
 * nao tem", e reofereceria para sempre toda serie que o TMDB conhece mas nao
 * ilustra.
 */
export function listShowsMissingMetadata(
  store: MetadataReader,
  nowMs: number,
  ttlMs: number = NOT_FOUND_TTL_MS,
  scope: EnrichScope = 'missing',
): ShowRow[] {
  return store.listShows().filter((show) => {
    const row = store.getShowMetadata(show.id);
    if (row === null) return true;
    if (row.notFound) return nowMs - row.fetchedAt >= ttlMs;
    return scope === 'refresh' && (row.backdropCheckedAt === null || row.posterFile === null);
  });
}

/** Roda `worker` sobre `items` com no maximo `limit` em voo. */
async function mapWithLimit<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await worker(items[index]!);
    }
  });
  await Promise.all(runners);
}

/**
 * Grava uma arte em `<dir>/<fileName>`.
 *
 * Temporario + rename, como o cache de legenda: rename e atomico no mesmo
 * filesystem, entao a rota nunca serve um JPEG pela metade - nem quando a
 * pagina pede a imagem no exato instante em que ela esta sendo baixada.
 */
async function writeArt(dir: string, fileName: string, bytes: Uint8Array): Promise<string> {
  const target = join(dir, fileName);
  const tmp = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, bytes);
    await rename(tmp, target);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
  return fileName;
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Enriquece uma serie, FUNDINDO com o que ja existe.
 *
 * A regra que organiza a funcao: uma rodada so pode ACRESCENTAR a uma linha que
 * ja tem dado bom. O escopo `refresh` traz para ca series com capa, ano e
 * sinopse gravados (elas voltam so por causa da arte 16:9), e uma busca que
 * agora responda "nao conheco" - ou que responda por um provedor mais fraco
 * porque o forte caiu - nao pode custar o que ja estava em disco. Quem clicou
 * em "so o que falta" pediu o contrario disso.
 *
 * Sobrescrita continua existindo, e e o caminho de linha AUSENTE ou marcada
 * como `not_found`. E o que o `reset` do painel produz de proposito: ele
 * regrava tudo como not_found antes de disparar, justamente para dizer "o que
 * esta ai esta errado, apague".
 */
async function enrichOne(
  store: MetadataStore,
  dataDir: string,
  show: ShowRow,
  options: EnrichOptions,
  report: EnrichReport,
): Promise<void> {
  const now = options.now ?? Date.now;
  const lookup = options.lookup ?? ((name: string) => lookupShowMetadata(name, options));
  const download = options.download ?? ((url: string) => downloadImage(url, options));
  const log = options.log ?? ((): void => undefined);

  // Sem TMDB na cadeia, arte 16:9 e estruturalmente impossivel (so ele tem).
  // Este flag e o que impede o carimbo de "ja procurei arte" nesse estado -
  // senao, adicionar a chave depois nao recuperaria backdrop nenhum sem um
  // "refazer tudo" que apaga capa e sinopse boas junto.
  const backdropCapable =
    typeof options.tmdbApiKey === 'string' && options.tmdbApiKey.trim() !== '';

  // O que precisa sobreviver a esta rodada. `not_found` nao guarda nada, e
  // linha ausente muito menos: nos dois casos a fusao vira sobrescrita sozinha.
  const existing = store.getShowMetadata(show.id);
  const keep = existing !== null && !existing.notFound ? existing : null;

  /**
   * A arte 16:9 tirada de um quadro do proprio video.
   *
   * Sai de `existing`, e nao de `keep`, de proposito: o caminho de SOBRESCRITA
   * ("o que esta ai veio da rede e esta errado, apague") vale para o que o
   * provedor respondeu, e esta imagem nao veio de la - inclusive na linha que a
   * propria extracao criou so para ter onde gravar o nome do arquivo, que nasce
   * marcada como `not_found`. Apagar aqui devolveria o canal ao listrado sem
   * nada no lugar.
   *
   * O reset do painel e a excecao, e ele zera `backdropSource` junto: ali a
   * pessoa esta dizendo que a arte tambem esta errada.
   */
  const frame = existing?.backdropSource === 'frame' ? existing : null;

  let result: LookupResult;
  try {
    result = await lookup(show.name);
  } catch (error) {
    // Provedor que lanca em vez de devolver `error` cai aqui: mesmo tratamento,
    // porque a diferenca que importa e "gravou" x "nao gravou".
    result = { status: 'error', reason: detail(error) };
  }

  if (result.status === 'error') {
    report.failed += 1;
    log(`metadata de "${show.name}" falhou: ${result.reason}`);
    return;
  }

  if (result.status === 'not-found') {
    report.notFound += 1;

    if (keep !== null) {
      // "Nao conheco esta serie" nao e motivo para apagar o que outro provedor
      // ja tinha respondido - e o provedor de hoje pode ate ser outro. Registra
      // so a tentativa (quando a cadeia era capaz de arte), e a serie sai da
      // fila da rebusca em vez de voltar a cada clique.
      store.upsertShowMetadata({
        ...keep,
        backdropCheckedAt: backdropCapable ? now() : keep.backdropCheckedAt,
        manual: false,
      });
      return;
    }

    store.upsertShowMetadata({
      showId: show.id,
      posterFile: null,
      // A arte de quadro sobrevive: ela nao veio do provedor, entao "nao
      // conheco esta serie" nao e motivo para apaga-la.
      backdropFile: frame?.backdropFile ?? null,
      backdropCheckedAt: backdropCapable ? now() : null,
      backdropSource: frame?.backdropSource ?? null,
      year: null,
      overview: null,
      source: null,
      fetchedAt: now(),
      notFound: true,
      manual: false,
    });
    return;
  }

  const { metadata } = result;

  // A cadeia respondeu, mas com um provedor fora do ar no caminho: sem esta
  // linha de log uma chave de TMDB invalida (401 em tudo) seria invisivel -
  // as capas continuam vindo do TVMaze e ninguem descobre o provedor morto.
  if (result.providerFailed) {
    log(
      `metadata de "${show.name}" veio incompleta: ` +
        (result.failureReason ?? 'um provedor da cadeia falhou'),
    );
  }

  // So baixa o que a linha NAO tem. Nao e economia de rede: capa e arte sao
  // gravadas em `<showId>.jpg`, entao um provedor mais fraco escreveria por
  // cima da imagem boa mesmo que a coluna do banco fosse preservada.
  let posterFile = keep?.posterFile ?? null;

  if (metadata.posterUrl !== null && posterFile === null) {
    try {
      const dir = postersDir(dataDir);
      await mkdir(dir, { recursive: true });
      posterFile = await writeArt(dir, posterFileName(show.id), await download(metadata.posterUrl));
      report.posters += 1;
    } catch (error) {
      log(`capa de "${show.name}" falhou: ${detail(error)}`);
      // Imagem que SUMIU do provedor (404) e permanente: grava a linha sem a
      // capa, senao a serie voltaria para a fila a cada abertura do catalogo,
      // batendo na mesma URL morta para sempre. O escopo `refresh` ainda a
      // reoferece (posterFile null) quando alguem pedir.
      if (!(error instanceof ImageGoneError)) {
        // A capa e a razao de ser disto tudo. Gravar a linha sem ela selaria o
        // show como "ja resolvido"; sem gravar, a proxima rodada tenta de novo.
        report.failed += 1;
        return;
      }
    }
  }

  let backdropFile = keep?.backdropFile ?? frame?.backdropFile ?? null;
  let backdropSource = keep?.backdropSource ?? frame?.backdropSource ?? null;

  // Arte do provedor SUBSTITUI a tirada de quadro; o contrario nunca acontece.
  // O quadro e o remendo de quando nao ha nada melhor - e quando o TMDB
  // finalmente responde (a chave apareceu, a serie foi renomeada), o remendo
  // sai. Sobrescreve o mesmo `<showId>.jpg`, entao nao ha as duas em disco.
  if (metadata.backdropUrl !== null && (backdropFile === null || backdropSource === 'frame')) {
    try {
      const dir = backdropsDir(dataDir);
      await mkdir(dir, { recursive: true });
      backdropFile = await writeArt(
        dir,
        backdropFileName(show.id),
        await download(metadata.backdropUrl),
      );
      backdropSource = 'tmdb';
    } catch (error) {
      // Ao contrario da capa, a arte 16:9 NAO aborta a gravacao: sem ela a tela
      // cai no padrao listrado, que e um desenho previsto. Desistir aqui
      // jogaria fora a capa que ja esta em disco e mandaria a serie inteira
      // para a proxima rodada por causa de um fundo.
      log(`arte de "${show.name}" falhou: ${detail(error)}`);
    }
  }

  report.found += 1;
  store.upsertShowMetadata({
    showId: show.id,
    posterFile,
    backdropFile,
    // Carimba "ja procurei arte" so quando a cadeia inteira respondeu E era
    // capaz de responder arte (TMDB presente). Com um provedor fora do ar a
    // busca foi incompleta; sem TMDB ela nem procurou arte - carimbar em
    // qualquer um dos casos selaria a serie sem 16:9 para sempre.
    backdropCheckedAt:
      result.providerFailed || !backdropCapable ? (keep?.backdropCheckedAt ?? null) : now(),
    backdropSource,
    // Campo a campo, o que ja existe manda. Um provedor que so preencheu buraco
    // nao rebaixa o resto da linha para si - nem toma o credito em `source`,
    // que identifica quem estabeleceu a serie.
    year: keep?.year ?? metadata.year,
    overview: keep?.overview ?? metadata.overview,
    source: keep?.source ?? metadata.source,
    fetchedAt: now(),
    notFound: false,
    manual: false,
  });
}

async function runEnrich(
  store: MetadataStore,
  dataDir: string,
  options: EnrichOptions,
  inFlight: Set<number>,
  scope: EnrichScope,
): Promise<EnrichReport> {
  const now = options.now ?? Date.now;
  const ttlMs = options.notFoundTtlMs ?? NOT_FOUND_TTL_MS;

  const pending = listShowsMissingMetadata(store, now(), ttlMs, scope).filter(
    (show) => !inFlight.has(show.id),
  );
  const report: EnrichReport = {
    considered: pending.length,
    found: 0,
    posters: 0,
    notFound: 0,
    failed: 0,
  };
  if (pending.length === 0) return report;

  for (const show of pending) inFlight.add(show.id);
  try {
    await mapWithLimit(pending, options.concurrency ?? DEFAULT_CONCURRENCY, (show) =>
      enrichOne(store, dataDir, show, options, report),
    );
  } finally {
    for (const show of pending) inFlight.delete(show.id);
  }

  return report;
}

/**
 * Uma passada: busca metadata de toda serie que ainda nao tem.
 *
 * Nunca lanca por causa de uma serie: falha de rede vira contador no relatorio,
 * porque uma serie fora do ar nao pode abortar as outras 459.
 */
export function enrichMissing(
  store: MetadataStore,
  dataDir: string,
  options: EnrichOptions = {},
  scope: EnrichScope = 'missing',
): Promise<EnrichReport> {
  return runEnrich(store, dataDir, options, new Set<number>(), scope);
}

export interface Enricher {
  /**
   * Roda agora. Se uma rodada ja esta em andamento, devolve ELA, nao outra -
   * inclusive quando o escopo pedido e outro: esperar a rodada estreita e
   * melhor que abrir uma segunda varredura do acervo em paralelo.
   */
  run(scope?: EnrichScope): Promise<EnrichReport>;
  /** Dispara sem esperar e sem propagar erro. E o que a rota de canais usa. */
  trigger(scope?: EnrichScope): void;
  readonly running: boolean;
  /** Resumo da ultima rodada terminada; null antes da primeira. */
  readonly last: EnrichReport | null;
}

/**
 * Enriquecedor com trava de "ja rodando".
 *
 * A trava e a propria promessa em andamento: chamadas concorrentes recebem a
 * mesma, entao nao ha duas varreduras do acervo ao mesmo tempo. O conjunto
 * `inFlight` cobre a segunda metade do problema - um show ja sendo buscado nao
 * entra na rodada seguinte, mesmo que ela comece antes desta terminar.
 */
export function createEnricher(
  store: MetadataStore,
  dataDir: string,
  options: EnrichOptions = {},
): Enricher {
  const inFlight = new Set<number>();
  let current: Promise<EnrichReport> | null = null;
  let last: EnrichReport | null = null;

  function run(scope: EnrichScope = 'missing'): Promise<EnrichReport> {
    current ??= runEnrich(store, dataDir, options, inFlight, scope)
      .then((report) => {
        // Guardado ANTES de soltar a trava: quem consultar `last` no instante
        // em que `running` virou false ja enxerga a rodada que acabou.
        last = report;
        return report;
      })
      .finally(() => {
        current = null;
      });
    return current;
  }

  return {
    run,
    trigger(scope: EnrichScope = 'missing'): void {
      void run(scope).catch((error: unknown) => {
        (options.log ?? ((): void => undefined))(`enriquecimento falhou: ${detail(error)}`);
      });
    },
    get running(): boolean {
      return current !== null;
    },
    get last(): EnrichReport | null {
      return last;
    },
  };
}
