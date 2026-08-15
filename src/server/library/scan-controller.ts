import type {
  AppSettings,
  LibraryStatus,
  MetadataSummary,
  ScanMode,
  ScanProgressRef,
  ScanSummary,
  TaskAccepted,
} from '@shared/api-types';

import type { EnrichReport, Enricher } from '../metadata/service';
import type { SettingsService } from '../settings/store';

import type { Store } from './index-store';
import { runRemux, type RemuxJobOptions, type RemuxReport } from './remux-job';
import { startDailyRescan, type RescanTime } from './rescan-timer';
import { runScan, type ScanJobOptions, type ScanReport } from './scan-job';

/**
 * Dono unico das tarefas de fundo da biblioteca: scan, metadata e remux.
 *
 * Existe para haver UM lugar com a trava de scan. Os tres gatilhos - bootstrap
 * do boot, rescan da madrugada e o botao do painel - pedem a mesma varredura;
 * espalhados em funcoes soltas, dois deles se cruzam e o NAS e lido em dobro
 * para produzir exatamente o mesmo indice. Aqui o segundo pedido recebe um
 * "ja esta rodando" e vai embora.
 *
 * Nenhum gatilho bloqueia quem chamou: todos devolvem na hora e o trabalho
 * segue em segundo plano. Um scan de 14 mil arquivos leva minutos - esperar por
 * ele dentro de um request so renderia timeout no proxy.
 */

/** De quanto em quanto tempo o progresso vira linha de log. */
const SCAN_LOG_INTERVAL_MS = 10_000;

/** Comando de indexacao manual, ja com o caminho certo para este ambiente. */
export function scanCommand(libraryRoot: string): string {
  return `node dist/server/scan.js "${libraryRoot}"`;
}

export interface LibraryController {
  status(): LibraryStatus;
  /** 202 quando aceitou; `{started:false, reason}` quando ja roda. Nunca lanca. */
  startScan(mode: ScanMode): TaskAccepted;
  refreshMetadata(reset: boolean): TaskAccepted;
  /** Dispara a rodada de remux quando ligada; no-op quando desligada. */
  triggerRemux(): void;
  /** Indice vazio: indexa em segundo plano. Chamado uma vez, no boot. */
  bootstrap(): void;
  /** Reage a mudanca de preferencia sem reiniciar o servidor. */
  applySettings(settings: AppSettings): void;
  /** Cancela o agendamento diario. Usado no shutdown. */
  stop(): void;
}

export interface LibraryControllerDeps {
  store: Store;
  enricher: Enricher;
  libraryRoot: string;
  dataDir: string;
  settings: SettingsService;
  log: (message: string) => void;
  /** Injetaveis para teste. */
  scan?: (options: ScanJobOptions) => Promise<ScanReport>;
  remux?: (options: RemuxJobOptions) => Promise<RemuxReport>;
  now?: () => number;
  startTimer?: typeof startDailyRescan;
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createLibraryController(deps: LibraryControllerDeps): LibraryController {
  const now = deps.now ?? Date.now;
  const scan = deps.scan ?? runScan;
  const remux = deps.remux ?? runRemux;
  const startTimer = deps.startTimer ?? startDailyRescan;
  const { log } = deps;

  // Fotografia das preferencias no boot. Elas mudam pelo painel, e e
  // `applySettings` que traz a mudanca ate aqui - reler o servico a cada uso
  // faria `status()` (consultado em polling curto) tocar o banco.
  const inicial = deps.settings.get();
  let autoRemux = inicial.autoRemux;
  let smartGrouping = inicial.smartGrouping;
  /** So para detectar mudanca de horario; o valor util vem de `settings.rescanTime()`. */
  let rescanTimeRaw = inicial.rescanTime;

  let scanRunning = false;
  let scanStartedAt: number | null = null;
  let scanProgress: ScanProgressRef | null = null;
  let lastScan: ScanSummary | null = null;
  /** Rodada em voo, ja com o erro tratado: usada por quem quer ESPERAR o fim. */
  let currentScan: Promise<void> | null = null;

  let remuxRunning = false;

  let lastMetadataReport: EnrichReport | null = null;
  let lastMetadata: MetadataSummary | null = null;

  let cancelRescan: (() => void) | null = null;

  /**
   * Carimba a hora de fim da rodada de metadata.
   *
   * O enricher nao guarda relogio, e a rodada pode ter sido disparada pela rota
   * de canais - que nao passa por aqui. Entao o carimbo sai na primeira leitura
   * de `status()` depois do fim; o painel consulta em segundos, e para "quando
   * terminou" essa precisao basta. A comparacao e por REFERENCIA: o mesmo
   * relatorio nunca e carimbado duas vezes.
   */
  function absorbMetadata(report: EnrichReport | null): void {
    if (report === null || report === lastMetadataReport) return;
    lastMetadataReport = report;
    lastMetadata = { ...report, finishedAt: now() };
  }

  function triggerRemux(): void {
    // Desligado no painel: nao ha rodada nova. A que ja esta em voo termina -
    // matar o ffmpeg no meio deixaria arquivo pela metade em DATA_DIR.
    if (!autoRemux || remuxRunning) return;
    remuxRunning = true;
    let ultimoLog = 0;

    void remux({
      store: deps.store,
      libraryRoot: deps.libraryRoot,
      dataDir: deps.dataDir,
      onProgress: ({ done, total, episode }) => {
        const agora = now();
        if (agora - ultimoLog < SCAN_LOG_INTERVAL_MS && done < total) return;
        ultimoLog = agora;
        log(`remux ${done}/${total}  ${episode}`);
      },
    })
      .then((report) => {
        if (report.planned === 0) return;
        log(
          `remux concluido: ${report.converted} convertidos, ${report.skipped} ja prontos` +
            (report.failed.length > 0 ? `, ${report.failed.length} falharam` : ''),
        );
        for (const failure of report.failed.slice(0, 5)) {
          log(`remux falhou em ${failure.path}: ${failure.reason}`);
        }
      })
      .catch((error: unknown) => {
        log(`remux falhou: ${detail(error)}`);
      })
      .finally(() => {
        remuxRunning = false;
      });
  }

  function concluirScan(report: ScanReport, origem: string): void {
    lastScan = {
      shows: report.shows,
      episodes: report.episodes,
      probed: report.probed,
      cached: report.cached,
      removedShows: report.removedShows,
      removedEpisodes: report.removedEpisodes,
      // A lista inteira fica no log; no painel so cabe o numero.
      failed: report.failed.length,
      durationMs: report.durationMs,
      finishedAt: now(),
      error: null,
    };

    if (report.shows === 0) {
      // Quase sempre e LIBRARY_ROOT apontando para o lugar errado, ou o volume
      // montado vazio. Dizer isso agora poupa muita procura.
      log(
        `${origem} terminou sem nenhum canal. Confira se ${deps.libraryRoot} e mesmo a raiz ` +
          'do acervo (uma pasta por desenho) e se o volume esta montado.',
      );
      return;
    }

    log(
      `${origem} concluido: ${report.shows} canais, ${report.episodes} episodios, ` +
        `${report.probed} analisados (${report.cached} do cache), ` +
        `${report.removedShows} canais e ${report.removedEpisodes} episodios removidos` +
        (report.failed.length > 0 ? `, ${report.failed.length} falharam` : ''),
    );

    // Capas depois dos canais, e sem esperar: os canais ja funcionam sem elas,
    // e uma rodada de rede em 460 series nao pode atrasar nada.
    deps.enricher.trigger();
    // Remux por ultimo, pelo mesmo motivo: os canais ja funcionam, so os MKV
    // ainda nao tocam - e cada um passa a tocar assim que a sua copia fica
    // pronta, sem esperar a rodada inteira.
    triggerRemux();
  }

  function falharScan(error: unknown, origem: string, iniciadoEm: number): void {
    const motivo = detail(error);
    // Contadores zerados com `error` preenchido: a rodada morreu no meio e nao
    // ha numero confiavel. O painel precisa MOSTRAR a falha - um silencio aqui
    // vira "o scan sumiu" para quem esta olhando a tela.
    lastScan = {
      shows: 0,
      episodes: 0,
      probed: 0,
      cached: 0,
      removedShows: 0,
      removedEpisodes: 0,
      failed: 0,
      durationMs: now() - iniciadoEm,
      finishedAt: now(),
      error: motivo,
    };
    log(`${origem} falhou: ${motivo}. Rode manualmente: ${scanCommand(deps.libraryRoot)}`);
  }

  /** Trava unica dos tres gatilhos. Nunca lanca; nunca espera. */
  function beginScan(mode: ScanMode, origem: string): TaskAccepted {
    if (scanRunning) return { started: false, reason: 'scan ja esta em andamento' };

    scanRunning = true;
    const iniciadoEm = now();
    scanStartedAt = iniciadoEm;
    scanProgress = null;
    let ultimoLog = 0;

    currentScan = scan({
      root: deps.libraryRoot,
      store: deps.store,
      // Vale a fotografia do momento do disparo: trocar a preferencia no meio
      // de uma varredura reagruparia metade do acervo por um criterio e metade
      // por outro.
      smartGrouping,
      // 'full' e o botao de "o indice esta torto", e nesse caso o cache e
      // justamente o que estava errado.
      useCache: mode !== 'full',
      onProgress: (progresso) => {
        scanProgress = {
          done: progresso.done,
          total: progresso.total,
          show: progresso.show,
        };
        // O estado acima e atualizado a cada arquivo (e so memoria); o LOG e
        // throttled. Sem isto, 14 mil arquivos viram 14 mil linhas no journal.
        const agora = now();
        if (agora - ultimoLog < SCAN_LOG_INTERVAL_MS && progresso.done < progresso.total) return;
        ultimoLog = agora;
        log(`${origem} ${progresso.done}/${progresso.total}  ${progresso.show}`);
      },
    })
      .then((report) => {
        concluirScan(report, origem);
      })
      .catch((error: unknown) => {
        falharScan(error, origem, iniciadoEm);
      })
      .finally(() => {
        scanRunning = false;
        scanStartedAt = null;
        scanProgress = null;
      });

    return { started: true };
  }

  function agendarRescan(time: RescanTime | null): void {
    cancelRescan?.();
    cancelRescan = null;
    if (time === null) return;

    // Rescan diario da madrugada: adiciona o que chegou no NAS e remove o que
    // saiu (o prune do scan-job cuida dos dois), depois busca capa das series
    // novas e remuxa o que precisar. Rodar de novo e barato: so arquivo com
    // mtime/tamanho novos passa pelo ffprobe.
    cancelRescan = startTimer({
      time,
      log,
      run: async () => {
        const aceito = beginScan('incremental', 'rescan');
        if (!aceito.started) {
          // Bootstrap gigante ainda no ar: amanha tem outra madrugada.
          log('rescan pulado: outro scan ja esta em andamento');
          return;
        }
        // O agendador so marca o disparo seguinte depois que este termina: e o
        // que impede dois scans no mesmo disco num acervo que leve horas.
        await currentScan;
      },
    });
  }

  agendarRescan(deps.settings.rescanTime());

  return {
    status(): LibraryStatus {
      absorbMetadata(deps.enricher.last);
      // Tudo daqui e memoria: esta rota e consultada em polling curto enquanto
      // um scan roda, e uma consulta ao banco por segundo brigaria com a
      // escrita do proprio scan.
      return {
        scan: {
          state: scanRunning ? 'running' : 'idle',
          progress: scanProgress,
          startedAt: scanStartedAt,
          last: lastScan,
        },
        metadata: {
          state: deps.enricher.running ? 'running' : 'idle',
          last: lastMetadata,
        },
        remux: { state: remuxRunning ? 'running' : 'idle' },
      };
    },

    startScan(mode): TaskAccepted {
      return beginScan(mode, 'scan');
    },

    refreshMetadata(reset): TaskAccepted {
      if (deps.enricher.running) {
        return { started: false, reason: 'busca de metadata ja esta em andamento' };
      }

      if (reset) {
        // Reset sem DELETE: regrava cada linha como "nao encontrada ha muito
        // tempo" (`fetchedAt: 0`), o que vence o TTL na hora e faz a rodada
        // seguinte reconsultar TUDO. E o que resolve capa errada depois de
        // renomear pasta, sem precisar de metodo novo no Store.
        //
        // A capa antiga some da tela ate a nova chegar - e o preco de admitir
        // que ela estava errada, e o arquivo em disco e sobrescrito pelo
        // proprio showId.
        for (const show of deps.store.listShows()) {
          deps.store.upsertShowMetadata({
            showId: show.id,
            posterFile: null,
            year: null,
            overview: null,
            source: null,
            fetchedAt: 0,
            notFound: true,
          });
        }
        log(`metadata apagada de ${deps.store.listShows().length} canais, buscando de novo`);
      }

      // `trigger` nunca lanca e nunca abre uma segunda rodada.
      deps.enricher.trigger();
      return { started: true };
    },

    triggerRemux,

    bootstrap(): void {
      // Quem sobe isto num NAS nao tem shell no container: exigir um comando
      // manual antes do primeiro canal aparecer transformava um deploy novo em
      // beco sem saida.
      log(`indice vazio, indexando ${deps.libraryRoot} em segundo plano`);
      beginScan('incremental', 'scan');
    },

    applySettings(settings): void {
      if (settings.autoRemux !== autoRemux) {
        autoRemux = settings.autoRemux;
        log(`remux automatico ${autoRemux ? 'ligado' : 'desligado'}`);
      }

      if (settings.smartGrouping !== smartGrouping) {
        smartGrouping = settings.smartGrouping;
        // Nao reagrupa nada agora: o indice atual continua como esta ate a
        // proxima varredura, e o painel precisa dizer isso ao usuario.
        log(
          `agrupamento de pastas ${smartGrouping ? 'ligado' : 'desligado'}: ` +
            'vale a partir do proximo scan',
        );
      }

      if (settings.rescanTime !== rescanTimeRaw) {
        rescanTimeRaw = settings.rescanTime;
        // Trocar o horario no painel nao pode exigir reiniciar o servidor.
        agendarRescan(deps.settings.rescanTime());
        log(
          rescanTimeRaw === null
            ? 'rescan diario desligado'
            : `rescan diario reagendado para ${rescanTimeRaw}`,
        );
      }
    },

    stop(): void {
      cancelRescan?.();
      cancelRescan = null;
    },
  };
}
