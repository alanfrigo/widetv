/**
 * Registro de uso das copias geradas: quem foi tocado, quando, e o que nao pode
 * ser apagado agora.
 *
 * Existe por causa de uma assimetria: o carimbo de uso e escrito no caminho
 * QUENTE (uma vez por requisicao de stream) e lido no caminho frio (a varredura
 * do evictor). O `<video>` faz uma requisicao Range por pedaco - dezenas por
 * minuto, centenas por episodio -, entao gravar no SQLite a cada uma seria uma
 * escrita por chunk de video. O throttle aqui e o que torna o carimbo viavel.
 *
 * O segundo trabalho e o pinning. Evictar um arquivo que esta tocando nao da
 * "um pouco menos de cache": a proxima requisicao Range nao encontra o arquivo,
 * a rota cai no original, e o navegador que nao demuxa MKV morre no meio do
 * episodio. Enquanto alguem esta assistindo, aquele arquivo e intocavel.
 *
 * Relogio injetado para o teste nao depender de tempo real.
 */

export interface CacheAccessStore {
  touchCacheFile(key: string, at: number): void;
}

export interface CacheAccessOptions {
  store: CacheAccessStore;
  now: () => number;
  /**
   * Intervalo minimo entre duas gravacoes do MESMO arquivo. Nao precisa ser
   * curto: o carimbo so ordena a evicção, e errar por um minuto nao muda quem
   * e o mais frio do cache.
   */
  touchIntervalMs?: number;
  /**
   * Por quanto tempo um arquivo tocado continua protegido. Precisa cobrir com
   * folga a pausa de quem parou o episodio e voltou - a memoria dura o processo,
   * entao errar para mais custa so adiar uma evicção.
   */
  pinTtlMs?: number;
}

export interface CacheAccess {
  /** Uma requisicao usou este arquivo. Barato: quase sempre so um Map.set. */
  record(key: string): void;
  /**
   * Protege sem carimbar. E o caso do preload: o proximo episodio ainda nao foi
   * pedido pelo player, mas ja esta sendo baixado e nao pode sumir.
   */
  pin(key: string): void;
  /** Chaves protegidas neste instante, para o plano de evicção. */
  pinned(): ReadonlySet<string>;
}

const DEFAULT_TOUCH_INTERVAL_MS = 60_000;
const DEFAULT_PIN_TTL_MS = 5 * 60_000;

export function createCacheAccess(options: CacheAccessOptions): CacheAccess {
  const { store, now } = options;
  const touchIntervalMs = options.touchIntervalMs ?? DEFAULT_TOUCH_INTERVAL_MS;
  const pinTtlMs = options.pinTtlMs ?? DEFAULT_PIN_TTL_MS;

  /** key -> instante do ultimo uso visto (nao do ultimo gravado). */
  const lastSeen = new Map<string, number>();
  /** key -> instante da ultima gravacao no banco. */
  const lastWritten = new Map<string, number>();

  function remember(key: string, at: number): void {
    lastSeen.set(key, at);
    // Poda oportunista: sem ela o Map cresce com um episodio por reproducao e
    // nunca encolhe num servidor que fica semanas de pe.
    if (lastSeen.size > 512) {
      const cutoff = at - pinTtlMs;
      for (const [candidate, seen] of lastSeen) {
        if (seen <= cutoff) {
          lastSeen.delete(candidate);
          lastWritten.delete(candidate);
        }
      }
    }
  }

  return {
    record(key): void {
      const at = now();
      remember(key, at);
      const written = lastWritten.get(key);
      if (written !== undefined && at - written < touchIntervalMs) return;
      lastWritten.set(key, at);
      store.touchCacheFile(key, at);
    },

    pin(key): void {
      remember(key, now());
    },

    pinned(): ReadonlySet<string> {
      const cutoff = now() - pinTtlMs;
      const active = new Set<string>();
      for (const [key, seen] of lastSeen) {
        if (seen > cutoff) active.add(key);
      }
      return active;
    },
  };
}
