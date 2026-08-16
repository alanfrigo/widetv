import { stat, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { planEvictions, type CacheEntry } from './cache-budget';
import type { CacheFileRow } from './index-store';

/**
 * Executor do orcamento de disco: le o que existe, aplica o plano de
 * `cache-budget.ts` e apaga.
 *
 * Separado do planejador pelo mesmo motivo que `remux-job` e separado de
 * `remux-plan`: a regra ("o que sai") e testavel sem tocar em disco, e o que
 * fica aqui e so a parte que nao da para testar sem arquivos - stat, unlink e a
 * ordem entre eles.
 *
 * Faz duas manutencoes de brinde, porque ja esta lendo o diretorio de qualquer
 * jeito:
 *
 * - linha sem arquivo (volume trocado, limpeza manual, container recriado) e
 *   apagada do indice. Sem isso ela contaria bytes que nao existem e o
 *   orcamento evictaria arquivos de verdade para caber num fantasma;
 * - linha anterior a versao 12 do schema nao sabe quanto ocupa; o tamanho e
 *   descoberto por stat e gravado. Custo pago uma vez por linha.
 */

export interface CacheEvictorStore {
  listCacheFiles(): CacheFileRow[];
  setCacheFileBytes(key: string, bytes: number): void;
  deleteCacheFile(key: string): void;
}

export interface CacheEvictorOptions {
  store: CacheEvictorStore;
  /** `<DATA_DIR>/remux`; remux e variantes dividem o mesmo diretorio. */
  remuxDir: string;
  /**
   * Teto em bytes, lido a CADA varredura: e uma funcao, e nao um numero, porque
   * a preferencia pode mudar no painel com o servidor de pe - um valor
   * capturado na construcao deixaria o teto novo sem efeito ate o reboot.
   *
   * **Zero ou negativo desliga o teto**, que e a leitura natural de
   * `REMUX_CACHE_MAX_BYTES=0` ("sem limite") e nao "apague tudo". O planejador
   * puro nao tem essa nocao de proposito: para ele um teto de zero significa
   * que nada cabe, que e o comportamento matematicamente correto.
   */
  capBytes: () => number;
  /** Chaves intocaveis nesta rodada; ver `cache-access.ts`. */
  pinned: () => ReadonlySet<string>;
  log?: (message: string) => void;
}

export interface EvictionReport {
  /** Ocupacao apurada ANTES de apagar, ja com os tamanhos corrigidos. */
  totalBytes: number;
  /** Arquivos removidos por orcamento. */
  evicted: number;
  freedBytes: number;
  /** Linhas apagadas porque o arquivo nao estava mais la. */
  missing: number;
  /** Linhas que ganharam tamanho por stat nesta rodada. */
  measured: number;
}

const EMPTY_REPORT: EvictionReport = {
  totalBytes: 0,
  evicted: 0,
  freedBytes: 0,
  missing: 0,
  measured: 0,
};

export interface CacheEvictor {
  /**
   * Uma passada completa. Chamadas concorrentes compartilham a rodada em
   * andamento em vez de duplicar unlink - duas varreduras simultaneas
   * planejariam sobre a mesma lista e a segunda tentaria apagar o que a
   * primeira ja apagou.
   */
  sweep(): Promise<EvictionReport>;
}

export function createCacheEvictor(options: CacheEvictorOptions): CacheEvictor {
  const { store, remuxDir, pinned } = options;
  const log = options.log ?? (() => undefined);
  let running: Promise<EvictionReport> | null = null;

  async function run(): Promise<EvictionReport> {
    const rows = store.listCacheFiles();
    if (rows.length === 0) return EMPTY_REPORT;

    const usable: CacheEntry[] = [];
    let totalBytes = 0;
    let missing = 0;
    let measured = 0;

    for (const row of rows) {
      // `basename` pelo mesmo motivo da capa e do proprio remux: o nome vem do
      // banco e vira caminho de unlink. Mesmo escrito por nos, ele nao pode
      // sair de `remux/`.
      const path = join(remuxDir, basename(row.file));
      let bytes = row.bytes;
      try {
        const info = await stat(path);
        if (bytes <= 0) {
          bytes = info.size;
          store.setCacheFileBytes(row.key, bytes);
          measured += 1;
        }
      } catch {
        store.deleteCacheFile(row.key);
        missing += 1;
        continue;
      }
      totalBytes += bytes;
      usable.push({ key: row.key, file: row.file, bytes, lastAccessAt: row.lastAccessAt });
    }

    const cap = options.capBytes();
    // Teto desligado: a manutencao acima ja valeu a passada, mas nada sai.
    if (cap <= 0) {
      return { totalBytes, evicted: 0, freedBytes: 0, missing, measured };
    }

    const plan = planEvictions(usable, cap, pinned());
    let evicted = 0;
    let freedBytes = 0;

    for (const item of plan) {
      const path = join(remuxDir, basename(item.file));
      // Arquivo primeiro, linha depois - nunca o contrario. Apagar a linha
      // antes deixaria o arquivo orfao para a coleta do fim do `runRemux`, que
      // so roda quando o remux automatico esta ligado: com AUTO_REMUX=false o
      // lixo ficaria em disco para sempre, exatamente o oposto do que este
      // modulo existe para fazer.
      //
      // A leitura em voo sobrevive ao unlink: no POSIX o `createReadStream` da
      // rota de stream segura o descritor e termina de ler um arquivo ja
      // removido do diretorio. O que protege o INICIO de uma leitura futura e o
      // pinning, nao esta ordem.
      try {
        await unlink(path);
      } catch {
        // Sumiu entre o stat e agora: a linha some junto, que e o objetivo.
      }
      store.deleteCacheFile(item.key);
      evicted += 1;
      freedBytes += item.bytes;
    }

    if (evicted > 0 || missing > 0) {
      log(
        `cache de remux: ${String(evicted)} arquivo(s) removido(s) por orcamento ` +
          `(${formatGiB(freedBytes)}), ${String(missing)} linha(s) sem arquivo. ` +
          `Ocupacao ${formatGiB(totalBytes - freedBytes)} de ${formatGiB(cap)}.`,
      );
    }

    return { totalBytes, evicted, freedBytes, missing, measured };
  }

  return {
    sweep(): Promise<EvictionReport> {
      running ??= run().finally(() => {
        running = null;
      });
      return running;
    },
  };
}

function formatGiB(bytes: number): string {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}
