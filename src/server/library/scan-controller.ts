import type {
  AppSettings,
  LibraryStatus,
  MetadataSummary,
  ScanMode,
  ScanProgressRef,
  ScanSummary,
  TaskAccepted,
  ThumbSummary,
} from '@shared/api-types';

import type { EnrichReport, Enricher } from '../metadata/service';
import type { SettingsService } from '../settings/store';

import type { Store } from './index-store';
import { runRemux, type RemuxJobOptions, type RemuxReport } from './remux-job';
import { startDailyRescan, type RescanTime } from './rescan-timer';
import { runScan, type ScanJobOptions, type ScanReport } from './scan-job';
import { runThumbs, type ThumbJobOptions, type ThumbReport } from './thumb-job';

/**
 * Dono unico das tarefas de fundo da biblioteca: scan, metadata, remux e
 * quadros.
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
  /**
   * Rodada de quadros pedida pela PESSOA (o botao do painel): roda mesmo com
   * `autoThumbs` desligado - desligar a automacao nao e proibir o pedido - e
   * devolve `started:false` quando ja ha uma em voo.
   */
  startThumbs(reset: boolean): TaskAccepted;
  /**
   * Dispara a rodada de quadros quando ligada; no-op quando desligada.
   * `retryFailed` (rodada de boot): reoferece tambem os episodios carimbados
   * sem arquivo - tentativas falhadas de rodadas antigas ganham nova chance.
   */
  triggerThumbs(options?: { retryFailed?: boolean }): void;
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
  /** Caminho dos binarios quando fora do PATH (launchd, container). */
  ffmpegPath?: string;
  ffprobePath?: string;
  /**
   * Teto de disco das copias geradas, em bytes; `0` = sem teto. A rodada de
   * catalogo para quando o orcamento acaba - ver `RemuxJobOptions.cacheMaxBytes`.
   *
   * Funcao, e nao numero: a preferencia muda no painel com o servidor de pe, e
   * um valor capturado na construcao so valeria no proximo boot.
   */
  cacheMaxBytes?: () => number;
  /** Chamado no fim da rodada de remux, para aplicar o teto ao que foi gerado. */
  onRemuxSettled?: () => void;
  /** Injetaveis para teste. */
  scan?: (options: ScanJobOptions) => Promise<ScanReport>;
  remux?: (options: RemuxJobOptions) => Promise<RemuxReport>;
  thumbs?: (options: ThumbJobOptions) => Promise<ThumbReport>;
  now?: () => number;
  startTimer?: typeof startDailyRescan;
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Permissao negada em qualquer ponto da cadeia (o scanner embrulha o erro
 * original em `cause`). No NAS esse e O defeito classico de deploy - dataset
 * com ACL que nao inclui o uid do container - e o EACCES cru nao diz isso.
 */
function isPermissionDenied(error: unknown): boolean {
  for (let atual = error; atual instanceof Error; atual = atual.cause) {
    const code = (atual as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') return true;
  }
  return false;
}

function permissionHint(error: unknown): string {
  if (!isPermissionDenied(error)) return '';
  const uid = process.getuid?.();
  return (
    ` Permissao negada: a biblioteca precisa de LEITURA para o usuario do container` +
    `${uid === undefined ? '' : ` (uid ${uid})`}. No TrueNAS, ajuste a ACL do dataset.`
  );
}

export function createLibraryController(deps: LibraryControllerDeps): LibraryController {
  const now = deps.now ?? Date.now;
  const scan = deps.scan ?? runScan;
  const remux = deps.remux ?? runRemux;
  const thumbs = deps.thumbs ?? runThumbs;
  const startTimer = deps.startTimer ?? startDailyRescan;
  const { log } = deps;

  // Fotografia das preferencias no boot. Elas mudam pelo painel, e e
  // `applySettings` que traz a mudanca ate aqui - reler o servico a cada uso
  // faria `status()` (consultado em polling curto) tocar o banco.
  const inicial = deps.settings.get();
  let autoRemux = inicial.autoRemux;
  let autoThumbs = inicial.autoThumbs;
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

  let thumbsRunning = false;
  let thumbsProgress: ScanProgressRef | null = null;
  let lastThumbs: ThumbSummary | null = null;

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
      ffmpegPath: deps.ffmpegPath ?? 'ffmpeg',
      ffprobePath: deps.ffprobePath ?? 'ffprobe',
      cacheMaxBytes: deps.cacheMaxBytes?.() ?? 0,
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
        // Nao e falha: e o teto de disco fazendo o trabalho dele. Precisa
        // aparecer no log, senao o operador ve "concluido" e conclui que o
        // acervo inteiro esta convertido.
        if (report.budgetSkipped > 0) {
          log(
            `remux parou no orcamento de disco: ${report.budgetSkipped} episodio(s) ficaram ` +
              `para a fila sob demanda. Aumente REMUX_CACHE_MAX_BYTES para converter mais.`,
          );
        }
        for (const failure of report.failed.slice(0, 5)) {
          log(`remux falhou em ${failure.path}: ${failure.reason}`);
        }
      })
      .catch((error: unknown) => {
        log(`remux falhou: ${detail(error)}`);
      })
      .finally(() => {
        remuxRunning = false;
        deps.onRemuxSettled?.();
      });
  }

  /**
   * Rodada de quadros. Trava propria, e nao a do scan: as duas convivem de
   * proposito - um rescan noturno nao pode esperar horas de ffmpeg para
   * comecar, e o que a fila de quadros le do indice (quem ainda nao foi
   * tentado) e uma consulta por rodada, nao uma transacao aberta.
   *
   * Nunca lanca e nunca espera: um acervo de 15 mil episodios leva horas aqui.
   */
  function beginThumbs(reset: boolean, origem: string, retryFailed = false): TaskAccepted {
    if (thumbsRunning) return { started: false, reason: 'extracao de quadros ja esta em andamento' };

    thumbsRunning = true;
    thumbsProgress = null;
    let ultimoLog = 0;

    void thumbs({
      store: deps.store,
      libraryRoot: deps.libraryRoot,
      dataDir: deps.dataDir,
      reset,
      retryFailed,
      ffmpegPath: deps.ffmpegPath ?? 'ffmpeg',
      // Prioridade do remux sobre o quadro: veja o cabecalho de thumb-job.ts. O
      // remux e o que faz o MKV TOCAR; a miniatura e ilustracao, e a tela ja
      // tem um desenho para quando ela falta. Uma fila unica poria 15 mil
      // miniaturas na frente da conversao que faz o acervo abrir.
      shouldYield: () => remuxRunning,
      onProgress: (progresso) => {
        thumbsProgress = {
          done: progresso.done,
          total: progresso.total,
          show: progresso.show,
        };
        const agora = now();
        if (agora - ultimoLog < SCAN_LOG_INTERVAL_MS && progresso.done < progresso.total) return;
        ultimoLog = agora;
        log(`${origem} ${progresso.done}/${progresso.total}  ${progresso.show}`);
      },
      log,
      now,
    })
      .then((report) => {
        lastThumbs = {
          considered: report.considered,
          generated: report.generated,
          skipped: report.skipped,
          failed: report.failed,
          durationMs: report.durationMs,
          finishedAt: now(),
        };
        if (report.considered === 0 && report.backdrops === 0) return;
        log(
          `${origem} concluido: ${report.generated} quadros` +
            (report.retried > 0 ? ` (${report.retried} na segunda tentativa)` : '') +
            `, ${report.backdrops} artes de canal, ${report.skipped} pulados` +
            (report.failed > 0 ? `, ${report.failed} falharam` : ''),
        );
      })
      .catch((error: unknown) => {
        // A rodada morreu inteira (DATA_DIR sem escrita, por exemplo). Nada de
        // `lastThumbs`: nao ha numero confiavel, e o log conta o que houve.
        log(`${origem} falhou: ${detail(error)}`);
      })
      .finally(() => {
        thumbsRunning = false;
        thumbsProgress = null;
      });

    return { started: true };
  }

  function triggerThumbs(options?: { retryFailed?: boolean }): void {
    // Desligado no painel: nao ha rodada nova. Desligar tambem nao apaga o que
    // ja existe - as miniaturas em disco continuam sendo servidas.
    if (!autoThumbs) return;
    beginThumbs(false, 'quadros', options?.retryFailed ?? false);
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
    // Remux depois, pelo mesmo motivo: os canais ja funcionam, so os MKV ainda
    // nao tocam - e cada um passa a tocar assim que a sua copia fica pronta,
    // sem esperar a rodada inteira.
    triggerRemux();
    // Quadros por ultimo, e sem esperar o remux terminar: a fila deles cede a
    // vez sozinha enquanto houver remux rodando (veja `beginThumbs`). Ultimo
    // porque e o mais longo e o menos essencial - a tela desenha o listrado no
    // lugar da miniatura que ainda nao existe.
    triggerThumbs();
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
    log(
      `${origem} falhou: ${motivo}.${permissionHint(error)} ` +
        `Rode manualmente: ${scanCommand(deps.libraryRoot)}`,
    );
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
      ffprobePath: deps.ffprobePath ?? 'ffprobe',
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
        thumbs: {
          state: thumbsRunning ? 'running' : 'idle',
          progress: thumbsProgress,
          last: lastThumbs,
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
        // proprio showId. `notFound: true` tambem e o que devolve a gravacao ao
        // caminho de SOBRESCRITA: sem nada para preservar, a fusao do
        // enriquecimento vira substituicao, que e exatamente o pedido aqui.
        for (const show of deps.store.listShows()) {
          // A escolha manual e imune ao "refazer tudo": ela existe justamente
          // porque a busca automatica errou nesta serie, e apaga-la aqui faria
          // do botao de manutencao um apagador de curadoria.
          if (deps.store.getShowMetadata(show.id)?.manual === true) continue;
          deps.store.upsertShowMetadata({
            showId: show.id,
            posterFile: null,
            backdropFile: null,
            // Zera o carimbo junto: "buscar tudo de novo" inclui a arte 16:9.
            backdropCheckedAt: null,
            // E a origem dela: sem isso, a arte tirada de quadro seria
            // preservada como "nao veio da rede" e sobreviveria a um reset que
            // existe justamente para dizer "o que esta ai esta errado".
            backdropSource: null,
            year: null,
            overview: null,
            source: null,
            fetchedAt: 0,
            notFound: true,
            manual: false,
          });
        }
        log(`metadata apagada de ${deps.store.listShows().length} canais, buscando de novo`);
      }

      // `trigger` nunca lanca e nunca abre uma segunda rodada. Escopo
      // 'refresh' porque quem apertou o botao esta justamente pedindo o que a
      // rodada automatica se recusa a fazer sozinha - reconsultar as series que
      // ficaram sem arte 16:9 (toda linha gravada antes dela existir).
      deps.enricher.trigger('refresh');
      return { started: true };
    },

    triggerRemux,

    triggerThumbs,

    startThumbs(reset): TaskAccepted {
      // Sem `autoThumbs` aqui de proposito: quem apertou o botao esta pedindo
      // esta rodada, e a preferencia governa o disparo AUTOMATICO.
      return beginThumbs(reset, reset ? 'quadros (refazendo todos)' : 'quadros');
    },

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

      if (settings.autoThumbs !== autoThumbs) {
        autoThumbs = settings.autoThumbs;
        // Desligar nao cancela a rodada em voo nem apaga o que ja existe: matar
        // o ffmpeg no meio deixaria arquivo pela metade, e as miniaturas ja
        // prontas continuam sendo servidas.
        log(`extracao de quadros ${autoThumbs ? 'ligada' : 'desligada'}`);
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
