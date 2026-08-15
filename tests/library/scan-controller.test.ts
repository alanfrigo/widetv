import { beforeEach, afterEach, describe, expect, test } from 'vitest';

import type {
  AppSettings,
  ScanMode,
  SettingsPatch,
} from '../../src/shared/api-types';
import { openStore, type Store } from '../../src/server/library/index-store';
import type { RemuxJobOptions, RemuxReport } from '../../src/server/library/remux-job';
import type { DailyRescanOptions, RescanTime } from '../../src/server/library/rescan-timer';
import {
  createLibraryController,
  type LibraryController,
} from '../../src/server/library/scan-controller';
import type { ScanJobOptions, ScanReport } from '../../src/server/library/scan-job';
import type { ThumbJobOptions, ThumbReport } from '../../src/server/library/thumb-job';
import type { EnrichReport, EnrichScope, Enricher } from '../../src/server/metadata/service';

/**
 * O que estes testes protegem, em uma frase: os tres gatilhos de scan
 * (bootstrap, madrugada, botao do painel) compartilham UMA trava, e o painel
 * sempre consegue ver o que aconteceu - inclusive quando a rodada morreu.
 *
 * Tudo aqui e injetado: scan, remux e o agendador sao de mentira. O que esta
 * sob teste e a orquestracao, nao o ffprobe.
 */

const AGORA = Date.parse('2026-01-01T03:00:00Z');

/** Deixa as continuacoes de promessa (.then/.finally) rodarem. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function scanReport(overrides: Partial<ScanReport> = {}): ScanReport {
  return {
    shows: 2,
    episodes: 10,
    probed: 4,
    cached: 6,
    removedEpisodes: 1,
    removedShows: 0,
    failed: [],
    durationMs: 1_234,
    ...overrides,
  };
}

function remuxReport(): RemuxReport {
  return { planned: 0, converted: 0, skipped: 0, removedFiles: 0, failed: [], durationMs: 1 };
}

function thumbReport(overrides: Partial<ThumbReport> = {}): ThumbReport {
  return {
    considered: 4,
    generated: 3,
    skipped: 1,
    failed: 0,
    retried: 1,
    backdrops: 2,
    removedFiles: 0,
    durationMs: 7,
    ...overrides,
  };
}

function enrichReport(): EnrichReport {
  return { considered: 3, found: 2, posters: 2, notFound: 1, failed: 0 };
}

interface FakeScan {
  calls: ScanJobOptions[];
  scan: (options: ScanJobOptions) => Promise<ScanReport>;
  /** Empurra um progresso da rodada em voo. */
  progresso(done: number, total: number, show: string): void;
  terminar(overrides?: Partial<ScanReport>): Promise<void>;
  falhar(motivo: string, code?: string): Promise<void>;
}

function makeScan(): FakeScan {
  const calls: ScanJobOptions[] = [];
  let resolver: ((report: ScanReport) => void) | null = null;
  let rejeitar: ((error: unknown) => void) | null = null;

  return {
    calls,
    scan: (options) => {
      calls.push(options);
      return new Promise<ScanReport>((resolve, reject) => {
        resolver = resolve;
        rejeitar = reject;
      });
    },
    progresso(done, total, show) {
      calls.at(-1)?.onProgress?.({ done, total, show });
    },
    async terminar(overrides = {}) {
      resolver?.(scanReport(overrides));
      await flush();
    },
    async falhar(motivo, code) {
      const error = new Error(motivo);
      // Mesmo formato dos erros de fs: um Error com `code` pendurado.
      if (code !== undefined) (error as NodeJS.ErrnoException).code = code;
      rejeitar?.(error);
      await flush();
    },
  };
}

interface FakeEnricher {
  enricher: Enricher;
  disparos: number;
  /** Escopos recebidos, em ordem: e o que distingue o botao do painel do resto. */
  escopos: EnrichScope[];
  /** Termina a rodada em voo, como o enricher de verdade faria. */
  terminar(): void;
}

function makeEnricher(ordem: string[]): FakeEnricher {
  let running = false;
  let last: EnrichReport | null = null;

  const fake: FakeEnricher = {
    enricher: {
      run: () => Promise.resolve(enrichReport()),
      trigger: (scope: EnrichScope = 'missing'): void => {
        ordem.push('enricher');
        fake.disparos += 1;
        fake.escopos.push(scope);
        running = true;
      },
      get running(): boolean {
        return running;
      },
      get last(): EnrichReport | null {
        return last;
      },
    },
    disparos: 0,
    escopos: [],
    terminar: (): void => {
      running = false;
      last = enrichReport();
    },
  };
  return fake;
}

/** `HH:MM` -> RescanTime, igual ao que o servico de settings faz. */
function parseTime(raw: string | null): RescanTime | null {
  if (raw === null) return null;
  const [hour = '0', minute = '0'] = raw.split(':');
  return { hour: Number(hour), minute: Number(minute) };
}

interface FakeSettings {
  service: {
    get(): AppSettings;
    patch(input: SettingsPatch): AppSettings;
    subscribe(listener: (settings: AppSettings) => void): () => void;
    rescanTime(): RescanTime | null;
  };
  /** Muda o valor guardado SEM notificar: quem notifica nos testes e a chamada direta. */
  set(patch: SettingsPatch): AppSettings;
}

function makeSettings(overrides: Partial<AppSettings> = {}): FakeSettings {
  let atual: AppSettings = {
    audioLang: null,
    subtitleLang: null,
    subtitlesAuto: false,
    rescanTime: '04:00',
    autoRemux: true,
    autoThumbs: true,
    smartGrouping: true,
    tmdbConfigured: false,
    ...overrides,
  };
  const listeners: ((settings: AppSettings) => void)[] = [];

  const set = (patch: SettingsPatch): AppSettings => {
    atual = { ...atual, ...patch };
    return atual;
  };

  return {
    service: {
      get: () => atual,
      patch: (input) => {
        const next = set(input);
        for (const listener of listeners) listener(next);
        return next;
      },
      subscribe: (listener) => {
        listeners.push(listener);
        return () => {
          const index = listeners.indexOf(listener);
          if (index >= 0) listeners.splice(index, 1);
        };
      },
      rescanTime: () => parseTime(atual.rescanTime),
    },
    set,
  };
}

interface FakeTimer {
  calls: DailyRescanOptions[];
  cancelamentos: number;
  start: (options: DailyRescanOptions) => () => void;
}

function makeTimer(): FakeTimer {
  const fake: FakeTimer = {
    calls: [],
    cancelamentos: 0,
    start: (options) => {
      fake.calls.push(options);
      return () => {
        fake.cancelamentos += 1;
      };
    },
  };
  return fake;
}

/** Fila de quadros de mentira: uma promessa que o teste resolve quando quer. */
interface FakeThumbs {
  calls: ThumbJobOptions[];
  run: (options: ThumbJobOptions) => Promise<ThumbReport>;
  terminar(overrides?: Partial<ThumbReport>): Promise<void>;
  falhar(motivo: string): Promise<void>;
}

function makeThumbs(ordem: string[]): FakeThumbs {
  const calls: ThumbJobOptions[] = [];
  let resolver: ((report: ThumbReport) => void) | null = null;
  let rejeitar: ((error: unknown) => void) | null = null;

  return {
    calls,
    run: (options) => {
      ordem.push('thumbs');
      calls.push(options);
      return new Promise<ThumbReport>((resolve, reject) => {
        resolver = resolve;
        rejeitar = reject;
      });
    },
    async terminar(overrides = {}) {
      resolver?.(thumbReport(overrides));
      await flush();
    },
    async falhar(motivo) {
      rejeitar?.(new Error(motivo));
      await flush();
    },
  };
}

interface Harness {
  controller: LibraryController;
  scan: FakeScan;
  enricher: FakeEnricher;
  settings: FakeSettings;
  timer: FakeTimer;
  remuxes: RemuxJobOptions[];
  thumbs: FakeThumbs;
  ordem: string[];
  store: Store;
  logs: string[];
}

let harness: Harness;
let agora = AGORA;

function montar(overrides: Partial<AppSettings> = {}): Harness {
  const ordem: string[] = [];
  const scan = makeScan();
  const enricher = makeEnricher(ordem);
  const settings = makeSettings(overrides);
  const timer = makeTimer();
  const remuxes: RemuxJobOptions[] = [];
  const thumbs = makeThumbs(ordem);
  const store = openStore(':memory:');
  const logs: string[] = [];

  const controller = createLibraryController({
    store,
    enricher: enricher.enricher,
    libraryRoot: '/lib',
    dataDir: '/data',
    settings: settings.service,
    log: (message) => {
      logs.push(message);
    },
    scan: scan.scan,
    remux: (options) => {
      ordem.push('remux');
      remuxes.push(options);
      return Promise.resolve(remuxReport());
    },
    thumbs: thumbs.run,
    now: () => agora,
    startTimer: timer.start,
  });

  return { controller, scan, enricher, settings, timer, remuxes, thumbs, ordem, store, logs };
}

beforeEach(() => {
  agora = AGORA;
  harness = montar();
});

afterEach(() => {
  harness.controller.stop();
  harness.store.close();
});

describe('trava de scan', () => {
  test('o segundo pedido nao abre uma segunda varredura do NAS', async () => {
    const primeiro = harness.controller.startScan('incremental');
    const segundo = harness.controller.startScan('incremental');

    expect(primeiro).toEqual({ started: true });
    expect(segundo.started).toBe(false);
    expect(segundo.reason).toMatch(/ja esta em andamento/);
    expect(harness.scan.calls).toHaveLength(1);

    await harness.scan.terminar();
    // Terminada a rodada, a trava solta.
    expect(harness.controller.startScan('incremental').started).toBe(true);
    expect(harness.scan.calls).toHaveLength(2);
  });

  test('bootstrap e o botao do painel dividem a mesma trava', async () => {
    harness.controller.bootstrap();
    expect(harness.controller.startScan('full').started).toBe(false);
    expect(harness.scan.calls).toHaveLength(1);
    await harness.scan.terminar();
  });

  test('o rescan da madrugada e pulado quando ja ha scan em voo', async () => {
    harness.controller.startScan('incremental');
    const agendado = harness.timer.calls[0];
    expect(agendado).toBeDefined();

    await agendado?.run();
    expect(harness.scan.calls).toHaveLength(1);
    await harness.scan.terminar();
  });
});

describe('status', () => {
  test('progresso aparece durante a rodada e some no fim', async () => {
    expect(harness.controller.status().scan).toMatchObject({
      state: 'idle',
      progress: null,
      startedAt: null,
      last: null,
    });

    harness.controller.startScan('incremental');
    harness.scan.progresso(3, 14_000, 'ThunderCats');

    const rodando = harness.controller.status().scan;
    expect(rodando.state).toBe('running');
    expect(rodando.startedAt).toBe(AGORA);
    expect(rodando.progress).toEqual({ done: 3, total: 14_000, show: 'ThunderCats' });

    await harness.scan.terminar();

    const parado = harness.controller.status().scan;
    expect(parado.state).toBe('idle');
    expect(parado.progress).toBeNull();
    expect(parado.startedAt).toBeNull();
  });

  test('last guarda o resumo da rodada que terminou', async () => {
    harness.controller.startScan('incremental');
    agora = AGORA + 60_000;
    await harness.scan.terminar({ failed: [{ path: '/lib/a.mkv', reason: 'ffprobe' }] });

    expect(harness.controller.status().scan.last).toEqual({
      shows: 2,
      episodes: 10,
      probed: 4,
      cached: 6,
      removedShows: 0,
      removedEpisodes: 1,
      failed: 1,
      durationMs: 1_234,
      finishedAt: AGORA + 60_000,
      error: null,
    });
  });

  test('scan que morre no meio grava error, e nao um silencio', async () => {
    harness.controller.startScan('incremental');
    await harness.scan.falhar('NAS sumiu');

    const last = harness.controller.status().scan.last;
    expect(last?.error).toContain('NAS sumiu');
    expect(harness.controller.status().scan.state).toBe('idle');
    // Falha nao encadeia capa nem remux: nao ha indice novo a enriquecer.
    expect(harness.ordem).toEqual([]);
  });

  test('EACCES no scan ganha a dica de permissao do NAS no log', async () => {
    // O caso classico do deploy em NAS: dataset da biblioteca sem leitura para
    // o uid do container. O EACCES cru nao diz isso; a dica diz.
    harness.controller.startScan('incremental');
    await harness.scan.falhar('EACCES: permission denied, scandir /lib', 'EACCES');

    expect(harness.logs.some((line) => line.includes('Permissao negada'))).toBe(true);
    expect(harness.logs.some((line) => line.includes('ACL'))).toBe(true);
  });

  test('falha sem codigo de permissao NAO ganha a dica', async () => {
    harness.controller.startScan('incremental');
    await harness.scan.falhar('NAS sumiu');

    expect(harness.logs.some((line) => line.includes('Permissao negada'))).toBe(false);
  });

  test('estado de metadata e remux reflete a rodada em voo', async () => {
    expect(harness.controller.status().metadata.state).toBe('idle');

    harness.controller.refreshMetadata(false);
    expect(harness.controller.status().metadata.state).toBe('running');
    expect(harness.controller.status().metadata.last).toBeNull();

    harness.enricher.terminar();
    const metadata = harness.controller.status().metadata;
    expect(metadata.state).toBe('idle');
    expect(metadata.last).toEqual({ ...enrichReport(), finishedAt: AGORA });
  });
});

describe('encadeamento do fim do scan', () => {
  test('dispara capa, remux e quadros, nessa ordem', async () => {
    harness.controller.startScan('incremental');
    await harness.scan.terminar();

    // Quadros por ultimo: e a rodada mais longa e a menos essencial - a tela
    // desenha o listrado no lugar da miniatura que ainda nao existe.
    expect(harness.ordem).toEqual(['enricher', 'remux', 'thumbs']);
  });

  test('scan sem nenhum canal nao encadeia nada', async () => {
    harness.controller.startScan('incremental');
    await harness.scan.terminar({ shows: 0, episodes: 0 });

    expect(harness.ordem).toEqual([]);
    expect(harness.controller.status().scan.last?.shows).toBe(0);
  });
});

describe('modos de scan', () => {
  test('full desliga o cache de probe: e ele que estava errado', async () => {
    harness.controller.startScan('full');
    expect(harness.scan.calls[0]?.useCache).toBe(false);
    await harness.scan.terminar();
  });

  test('incremental reaproveita o cache', async () => {
    harness.controller.startScan('incremental');
    expect(harness.scan.calls[0]?.useCache).toBe(true);
    await harness.scan.terminar();
  });

  test('o rescan da madrugada e incremental', async () => {
    // A rodada agendada so RESOLVE quando o scan termina - e assim que o
    // agendador so marca o disparo seguinte depois deste acabar.
    const rodada = harness.timer.calls[0]?.run();
    expect(harness.scan.calls[0]?.useCache).toBe(true);
    await harness.scan.terminar();
    await rodada;
  });
});

describe('applySettings', () => {
  test('horario novo reagenda; null cancela', () => {
    expect(harness.timer.calls).toHaveLength(1);
    expect(harness.timer.calls[0]?.time).toEqual({ hour: 4, minute: 0 });

    harness.settings.set({ rescanTime: '05:30' });
    harness.controller.applySettings(harness.settings.service.get());

    expect(harness.timer.cancelamentos).toBe(1);
    expect(harness.timer.calls).toHaveLength(2);
    expect(harness.timer.calls[1]?.time).toEqual({ hour: 5, minute: 30 });

    harness.settings.set({ rescanTime: null });
    harness.controller.applySettings(harness.settings.service.get());

    expect(harness.timer.cancelamentos).toBe(2);
    expect(harness.timer.calls).toHaveLength(2);
  });

  test('mesmo horario nao reagenda a toa', () => {
    harness.controller.applySettings(harness.settings.service.get());
    expect(harness.timer.calls).toHaveLength(1);
    expect(harness.timer.cancelamentos).toBe(0);
  });

  test('autoRemux false faz triggerRemux virar no-op', () => {
    harness.controller.triggerRemux();
    expect(harness.remuxes).toHaveLength(1);

    harness.settings.set({ autoRemux: false });
    harness.controller.applySettings(harness.settings.service.get());

    harness.controller.triggerRemux();
    expect(harness.remuxes).toHaveLength(1);
  });

  test('smartGrouping novo chega no scan da rodada SEGUINTE', async () => {
    harness.controller.startScan('incremental');
    expect(harness.scan.calls[0]?.smartGrouping).toBe(true);

    harness.settings.set({ smartGrouping: false });
    harness.controller.applySettings(harness.settings.service.get());
    // A rodada em voo continua com o criterio com que comecou.
    expect(harness.scan.calls[0]?.smartGrouping).toBe(true);

    await harness.scan.terminar();
    harness.controller.startScan('incremental');
    expect(harness.scan.calls[1]?.smartGrouping).toBe(false);
    await harness.scan.terminar();
  });

  test('preferencia gravada antes do boot ja vale na primeira rodada', async () => {
    harness.controller.stop();
    harness.store.close();
    harness = montar({ smartGrouping: false, autoRemux: false, rescanTime: null });

    expect(harness.timer.calls).toHaveLength(0);
    harness.controller.startScan('incremental');
    expect(harness.scan.calls[0]?.smartGrouping).toBe(false);

    await harness.scan.terminar();
    expect(harness.ordem).toEqual(['enricher', 'thumbs']);
  });
});

describe('refreshMetadata', () => {
  test('sem reset, so dispara a busca', () => {
    expect(harness.controller.refreshMetadata(false)).toEqual({ started: true });
    expect(harness.enricher.disparos).toBe(1);
  });

  test('o botao do painel pede escopo "refresh"; o fim de scan nao', async () => {
    // E o que faz uma serie ja gravada, sem arte 16:9, voltar para a fila
    // quando a PESSOA pede - sem que o boot faca isso sozinho.
    harness.controller.refreshMetadata(false);
    expect(harness.enricher.escopos).toEqual(['refresh']);

    harness.enricher.terminar();
    harness.controller.startScan('incremental');
    await harness.scan.terminar();
    expect(harness.enricher.escopos).toEqual(['refresh', 'missing']);
  });

  test('rodada em voo devolve started:false', () => {
    harness.controller.refreshMetadata(false);
    const segundo = harness.controller.refreshMetadata(false);
    expect(segundo.started).toBe(false);
    expect(segundo.reason).toMatch(/ja esta em andamento/);
    expect(harness.enricher.disparos).toBe(1);
  });

  test('reset vence o TTL de toda serie, para a capa errada ser buscada de novo', () => {
    const show = harness.store.upsertShow({
      slug: 'thundercats',
      name: 'ThunderCats',
      absolutePath: '/lib/tc',
    });
    harness.store.upsertShowMetadata({
      showId: show.id,
      posterFile: `${show.id}.jpg`,
      backdropFile: `${show.id}.jpg`,
      backdropCheckedAt: null,
      backdropSource: null,
      year: 1985,
      overview: 'Sinopse errada.',
      source: 'tvmaze',
      fetchedAt: AGORA,
      notFound: false,
    });

    expect(harness.controller.refreshMetadata(true)).toEqual({ started: true });

    const row = harness.store.getShowMetadata(show.id);
    expect(row).toMatchObject({
      fetchedAt: 0,
      notFound: true,
      posterFile: null,
      backdropFile: null,
      // Zerado junto: "buscar tudo de novo" inclui a arte 16:9. E `notFound`
      // aqui e o que devolve a gravacao do enriquecimento ao caminho de
      // SOBRESCRITA - sem nada para preservar, a fusao vira substituicao.
      backdropCheckedAt: null,
      backdropSource: null,
    });
    expect(harness.enricher.disparos).toBe(1);
  });
});

describe('quadros', () => {
  test('progresso proprio, e o resumo fica em last quando termina', async () => {
    expect(harness.controller.status().thumbs).toEqual({
      state: 'idle',
      progress: null,
      last: null,
    });

    expect(harness.controller.startThumbs(false)).toEqual({ started: true });
    harness.thumbs.calls[0]?.onProgress?.({ done: 7, total: 15_000, show: 'ThunderCats' });

    const rodando = harness.controller.status().thumbs;
    expect(rodando.state).toBe('running');
    expect(rodando.progress).toEqual({ done: 7, total: 15_000, show: 'ThunderCats' });

    agora = AGORA + 5_000;
    await harness.thumbs.terminar();

    const parado = harness.controller.status().thumbs;
    expect(parado.state).toBe('idle');
    expect(parado.progress).toBeNull();
    // O resumo publico e sobre EPISODIOS: `retried` e `backdrops` ficam no log.
    expect(parado.last).toEqual({
      considered: 4,
      generated: 3,
      skipped: 1,
      failed: 0,
      durationMs: 7,
      finishedAt: AGORA + 5_000,
    });
  });

  test('a segunda chamada devolve 409 enquanto a primeira nao termina', async () => {
    expect(harness.controller.startThumbs(false).started).toBe(true);

    const segundo = harness.controller.startThumbs(false);
    expect(segundo.started).toBe(false);
    expect(segundo.reason).toMatch(/ja esta em andamento/);
    expect(harness.thumbs.calls).toHaveLength(1);

    await harness.thumbs.terminar();
    expect(harness.controller.startThumbs(false).started).toBe(true);
    await harness.thumbs.terminar();
  });

  test('reset chega na fila; sem reset, so o que falta', async () => {
    harness.controller.startThumbs(true);
    expect(harness.thumbs.calls[0]?.reset).toBe(true);
    await harness.thumbs.terminar();

    harness.controller.startThumbs(false);
    expect(harness.thumbs.calls[1]?.reset).toBe(false);
    await harness.thumbs.terminar();
  });

  test('a fila cede a vez ao remux, e so a ele', async () => {
    harness.controller.startThumbs(false);
    const ceder = harness.thumbs.calls[0]?.shouldYield;
    expect(ceder?.()).toBe(false);

    // Remux em voo: o quadro espera entre um episodio e o outro. O remux e o
    // que faz o MKV TOCAR; a miniatura e ilustracao.
    harness.controller.triggerRemux();
    expect(ceder?.()).toBe(true);

    await harness.thumbs.terminar();
  });

  test('autoThumbs desligado nao dispara nada ao fim do scan', async () => {
    harness.controller.stop();
    harness.store.close();
    harness = montar({ autoThumbs: false });

    harness.controller.startScan('incremental');
    await harness.scan.terminar();

    expect(harness.ordem).toEqual(['enricher', 'remux']);
    expect(harness.thumbs.calls).toHaveLength(0);

    // Mas o BOTAO continua valendo: desligar a automacao nao e proibir o pedido.
    expect(harness.controller.startThumbs(false)).toEqual({ started: true });
    expect(harness.thumbs.calls).toHaveLength(1);
    await harness.thumbs.terminar();
  });

  test('desligar no painel vale para a proxima varredura', async () => {
    harness.settings.set({ autoThumbs: false });
    harness.controller.applySettings(harness.settings.service.get());

    harness.controller.triggerThumbs();
    expect(harness.thumbs.calls).toHaveLength(0);

    harness.settings.set({ autoThumbs: true });
    harness.controller.applySettings(harness.settings.service.get());

    harness.controller.triggerThumbs();
    expect(harness.thumbs.calls).toHaveLength(1);
    await harness.thumbs.terminar();
  });

  test('rodada que morre inteira nao derruba nada e solta a trava', async () => {
    harness.controller.startThumbs(false);
    await harness.thumbs.falhar('DATA_DIR sem escrita');

    expect(harness.controller.status().thumbs.state).toBe('idle');
    expect(harness.controller.status().thumbs.last).toBeNull();
    expect(harness.controller.startThumbs(false).started).toBe(true);
    await harness.thumbs.terminar();
  });
});

describe('stop', () => {
  test('cancela o agendamento diario', () => {
    harness.controller.stop();
    expect(harness.timer.cancelamentos).toBe(1);
    // Idempotente: o onClose do Fastify pode passar duas vezes num shutdown feio.
    harness.controller.stop();
    expect(harness.timer.cancelamentos).toBe(1);
  });
});

describe('startScan nunca lanca', () => {
  test('modo qualquer, rodada em voo ou nao, devolve TaskAccepted', async () => {
    const modes: ScanMode[] = ['incremental', 'full'];
    for (const mode of modes) {
      expect(() => harness.controller.startScan(mode)).not.toThrow();
    }
    await harness.scan.terminar();
  });
});
