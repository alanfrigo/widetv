import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import Fastify from 'fastify';

import { registerAuthGuard, registerAuthRoutes } from './auth/routes';
import { registerChannelRoutes } from './channels/routes';
import { loadConfig } from './config';
import { ensureDataDir } from './data-dir';
import { libraryRootWarning } from './library-root';
import { registerHistoryRoutes } from './history/routes';
import { createCacheAccess } from './library/cache-access';
import { createCacheEvictor } from './library/cache-evictor';
import { openStore, remuxCacheKey, variantCacheKey } from './library/index-store';
import { registerLibraryRoutes } from './library/routes';
import { createLibraryController, scanCommand } from './library/scan-controller';
import { remuxFileName } from './library/remux-job';
import { createRemuxQueue } from './library/remux-queue';
import { defaultAudioNeedsCompat } from './library/remux-plan';
import { createVariantQueue } from './library/variant-queue';
import { createEnricher } from './metadata/service';
import { registerSettingsRoutes } from './settings/routes';
import { createSettingsService } from './settings/store';
import { registerStreamRoutes, type AudioResolution } from './stream/direct';
import { registerSubtitleRoutes } from './stream/subtitle';
import { registerThumbRoutes } from './stream/thumb';

/**
 * Montagem do servidor.
 *
 * O scan nao bloqueia o boot. Indexar 14 mil arquivos leva minutos, e um
 * servidor que so responde no fim disso reprova no healthcheck e e reiniciado
 * pelo orquestrador antes de terminar - reiniciando o scan junto, para sempre.
 * Entao: sobe primeiro, indexa depois, em segundo plano.
 *
 * Este arquivo so monta e conecta. Quem orquestra scan, metadata e remux e o
 * controlador da biblioteca (library/scan-controller.ts) - inclusive a trava
 * que impede duas varreduras do mesmo NAS.
 */

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Intervalo da varredura periodica do cache de copias geradas. Maior que o TTL
 * do pin (5 min) de proposito: e o que garante que a rodada seguinte encontre
 * liberado o arquivo que a anterior teve de poupar por estar tocando.
 */
const CACHE_SWEEP_INTERVAL_MS = 10 * 60_000;

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  // Antes de abrir o banco: o SQLite so descobriria um diretorio sem escrita na
  // primeira gravacao, ja com o servidor de pe.
  ensureDataDir(config.dataDir);
  const dbPath = join(config.dataDir, 'library.sqlite');

  const store = openStore(dbPath);
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    // O id de episodio e o caminho relativo inteiro dentro de um :param, e o
    // default do Fastify (100 chars) devolve 414 para qualquer release com
    // nome de cena ("The.Simpsons.S37E01...1080p...DUAL-SiGLA.mkv" passa de
    // 100 sozinho). 2048 cobre pasta + temporada + arquivo com folga.
    maxParamLength: 2048,
  });

  // Aviso, nao erro: a checagem de verdade e o scan. Mas o scan e assincrono
  // (ou nem roda, com AUTO_SCAN=false), e o operador olha o log logo depois do
  // deploy - e agora que um dataset ilegivel precisa aparecer.
  const avisoBiblioteca = libraryRootWarning(config.libraryRoot);
  if (avisoBiblioteca !== null) {
    app.log.warn(avisoBiblioteca);
  }

  // Preferencias do usuario. O `.env` entra so como DEFAULT: gravar no painel
  // sobrepoe, apagar volta ao ambiente.
  const settings = createSettingsService(store, {
    rescanTime: config.rescanTime,
    autoRemux: config.autoRemux,
    remuxCacheMaxBytes: config.remuxCacheMaxBytes,
    autoThumbs: config.autoThumbs,
    smartGrouping: config.smartGrouping,
    tmdbConfigured: config.tmdbApiKey !== null,
  });

  // Busca de capa/sinopse. Uma instancia so no processo inteiro: e ela que
  // segura a trava de "ja rodando" entre o fim do scan e a rota de canais.
  const enricher = createEnricher(store, config.dataDir, {
    tmdbApiKey: config.tmdbApiKey,
    log: (message) => {
      app.log.info(message);
    },
  });

  // Orcamento de disco das copias geradas. O remux copia o video inteiro em vez
  // de recodificar, entao cada episodio convertido custa quase o tamanho do
  // original, e cada dublagem custa outro tanto: sem teto, o acervo inteiro
  // acabaria duplicado dentro de DATA_DIR.
  //
  // `cacheAccess` carimba o uso (com throttle, porque o `<video>` pede uma faixa
  // por pedaco) e protege o que esta tocando; `cacheEvictor` derruba o mais
  // frio quando o total passa do teto.
  const cacheAccess = createCacheAccess({ store, now: () => Date.now() });
  const cacheEvictor = createCacheEvictor({
    store,
    remuxDir: join(config.dataDir, 'remux'),
    // Lido a cada varredura: mudar o teto no painel vale na hora, sem reboot.
    capBytes: () => settings.get().remuxCacheMaxBytes,
    pinned: () => cacheAccess.pinned(),
    log: (message) => {
      app.log.info(message);
    },
  });
  /** Nao propaga: uma falha de unlink nao pode derrubar quem gerou a copia. */
  const sweepCache = (): void => {
    void cacheEvictor.sweep().catch((error: unknown) => {
      app.log.warn(
        'varredura do cache de remux falhou: ' +
          (error instanceof Error ? error.message : String(error)),
      );
    });
  };

  const controller = createLibraryController({
    store,
    enricher,
    libraryRoot: config.libraryRoot,
    dataDir: config.dataDir,
    settings,
    ffmpegPath: config.ffmpegPath,
    ffprobePath: config.ffprobePath,
    cacheMaxBytes: () => settings.get().remuxCacheMaxBytes,
    onRemuxSettled: sweepCache,
    log: (message) => {
      app.log.info(message);
    },
  });

  // Uma passada no boot, antes de qualquer conversao: recolhe linhas sem
  // arquivo (volume trocado, container recriado), mede as copias anteriores ao
  // schema 12 e aplica um teto que pode ter sido reduzido entre dois deploys.
  sweepCache();

  // Varredura periodica. Os outros gatilhos (boot, fim de conversao, mudanca de
  // preferencia) sao todos EVENTOS, e existe um estado que nenhum deles alcanca:
  // o cache acima do teto so por causa dos pins. A varredura para acima do
  // orcamento de proposito - derrubar quem esta assistindo seria pior -, mas sem
  // uma volta periodica o excedente ficaria em disco ate o proximo evento, que
  // pode nao vir por horas. O intervalo e maior que o TTL do pin para a rodada
  // seguinte encontrar os arquivos ja liberados.
  const cacheTimer = setInterval(sweepCache, CACHE_SWEEP_INTERVAL_MS);
  // Sem unref, um timer de 10 min segura o processo vivo no shutdown.
  cacheTimer.unref();

  // Indice existente mas sem nenhuma serie conta como vazio: e o estado de um
  // scan que nunca rodou e o de um scan interrompido no comeco.
  if (store.listShows().length === 0) {
    if (config.autoScan) {
      controller.bootstrap();
    } else {
      app.log.warn(
        `indice vazio em ${dbPath} e AUTO_SCAN=false. Rode: ${scanCommand(config.libraryRoot)}`,
      );
    }
  } else {
    // Acervo ja indexado: uma rodada de remux no boot pega o que ficou pendente
    // (deploy da feature, rodada interrompida). Quando esta tudo pronto, ela so
    // percorre o indice e volta - barata o bastante para rodar sempre.
    // Metadata tambem: e o que faz o TTL de not_found valer na pratica (sem
    // este disparo, uma serie "nao encontrada" ha 8 dias so seria retentada
    // depois de um scan ou clique no painel) e o que busca a arte 16:9 quando
    // a TMDB_API_KEY aparece entre um boot e outro.
    enricher.trigger();
    controller.triggerRemux();
    // Mesmo raciocinio para os quadros, e aqui ele e o que torna a fila
    // RETOMAVEL: um acervo grande leva horas, o servidor reinicia no meio, e a
    // rodada do boot continua exatamente de onde a anterior parou (o que ja foi
    // tentado esta carimbado no indice).
    // `retryFailed`: uma vez por boot, os episodios que ficaram carimbados sem
    // quadro (falha ambiental de rodada antiga) ganham nova tentativa.
    controller.triggerThumbs({ retryFailed: true });
  }

  // Mudou preferencia no painel? O controlador reage sem reiniciar o servidor:
  // reagenda o rescan, liga/desliga o remux, anota o agrupamento.
  settings.subscribe((next) => {
    controller.applySettings(next);
    // O teto pode ter DIMINUIDO: a varredura aplica o valor novo agora, em vez
    // de deixar o disco acima do limite ate a proxima conversao.
    sweepCache();
  });

  await app.register(cookie);

  const session = {
    secret: config.sessionSecret,
    secureCookies: config.secureCookies,
    ttlMs: SESSION_TTL_MS,
  };
  const now = () => Date.now();

  registerAuthGuard(app, { session, now });
  registerAuthRoutes(app, { passwordHash: config.authPasswordHash, session, now });
  registerChannelRoutes(app, {
    source: store,
    epochMs: config.channelEpochMs,
    now,
    dataDir: config.dataDir,
    onMetadataMissing: () => {
      enricher.trigger();
    },
  });
  registerSettingsRoutes(app, { settings });
  registerLibraryRoutes(app, { controller });

  // Fila das variantes de dublagem, uma por processo: e ela que impede dois
  // pedidos iguais de gerar o mesmo MP4 duas vezes.
  const variants = createVariantQueue({
    store,
    libraryRoot: config.libraryRoot,
    dataDir: config.dataDir,
    ffmpegPath: config.ffmpegPath,
    onSettled: sweepCache,
    log: (message) => {
      app.log.warn(message);
    },
  });

  /**
   * `?audio=N`: N e o `index` da faixa no arquivo FONTE.
   *
   * A preferencia de audio do painel NAO entra aqui: quem escolhe a faixa de
   * cada episodio e o cliente, que conhece as trilhas do arquivo que esta
   * tocando. O servidor so guarda a preferencia.
   */
  async function resolveAudio(episodeId: string, audioIndex: number): Promise<AudioResolution> {
    const row = store.getEpisode(episodeId);
    if (row === null) return { status: 'invalid' };
    const chosen = row.audioTracks.find((track) => track.isDefault) ?? row.audioTracks[0];
    // A faixa pedida ja e a que toca no arquivo servido: nada a gerar.
    if (chosen !== undefined && chosen.index === audioIndex) return { status: 'default' };
    const resolution = await variants.request(episodeId, audioIndex);
    // Variante que vai ser servida agora e variante que nao pode ser evictada
    // no meio da reproducao. O carimbo entra aqui, e nao no `getEpisode`, porque
    // e aqui que se sabe QUAL faixa foi escolhida.
    if (resolution.status === 'ready') {
      cacheAccess.record(variantCacheKey(episodeId, audioIndex));
    }
    return resolution;
  }

  // Fila de prioridade do remux principal: o episodio que alguem tentou
  // assistir e cairia no original mudo e convertido na frente da rodada de
  // catalogo (que anda na ordem da grade e pode levar horas ate chegar nele).
  const remuxQueue = createRemuxQueue({
    store,
    libraryRoot: config.libraryRoot,
    dataDir: config.dataDir,
    ffmpegPath: config.ffmpegPath,
    ffprobePath: config.ffprobePath,
    onSettled: sweepCache,
    log: (message) => {
      app.log.warn(message);
    },
  });

  // `EpisodeRow.id` JA e o caminho relativo a raiz: e assim que o mesmo indice
  // funciona no host e dentro do container.
  registerStreamRoutes(
    app,
    {
      getEpisode: (id) => {
        const row = store.getEpisode(id);
        if (row === null) return null;
        // `basename` pelo mesmo motivo da capa: o nome vem do banco e vira
        // caminho - mesmo escrito por nos, ele nao pode sair de `remux/`.
        const remux = store.getRemux(row.id, row.mtimeMs, row.size);
        // Este closure e o unico ponto por requisicao que ja consulta o remux,
        // entao e aqui que o uso e carimbado. O `record` faz throttle sozinho:
        // o `<video>` pede uma faixa por pedaco e uma escrita por requisicao
        // seriam centenas de writes no SQLite por episodio.
        //
        // Vale tambem para o HEAD do preload do proximo episodio, que passa por
        // aqui - e e o que impede o proximo da grade de ser evictado justamente
        // enquanto esta sendo baixado.
        if (remux !== null) cacheAccess.record(remuxCacheKey(row.id));
        // Linha de versao antiga do plano marca pendencia quando o defeito dela
        // e audivel: com a faixa default dolby/dts, o MP4 antigo pode ser
        // exatamente o da gemea AAC quebrada - mudo no NAVEGADOR. O caminho
        // continua indo junto mesmo assim: a rota decide por cliente (202 so
        // para `?compat=browser`), e um cliente nativo toca a faixa dolby do
        // MP4 antigo normalmente - descarta-lo aqui apagaria o catalogo da TV
        // inteiro num bump de versao do plano.
        const fresh = remux !== null && remux.file === remuxFileName(row.id, row.mtimeMs, row.size);
        const wouldBeSilent =
          row.videoCodec !== null && defaultAudioNeedsCompat(row.audioTracks);
        return {
          relativePath: row.id,
          remuxPath: remux === null ? null : join(config.dataDir, 'remux', basename(remux.file)),
          remuxPending: wouldBeSilent && !fresh,
        };
      },
    },
    config.libraryRoot,
    resolveAudio,
    (episodeId) => {
      remuxQueue.ensure(episodeId);
    },
  );

  registerHistoryRoutes(app, {
    source: {
      getEpisode: (id) => store.getEpisode(id),
      // A faixa "Continuar assistindo" precisa do canal e da capa para nao
      // obrigar o cliente a buscar os episodios de cada canal do historico.
      getShowByChannel: (channelNumber) => store.getShowByChannel(channelNumber),
      getShowMetadata: (showId) => store.getShowMetadata(showId),
      getWatchHistory: (id) => store.getWatchHistory(id),
      upsertWatchHistory: (row) => {
        store.upsertWatchHistory(row);
      },
      deleteWatchHistory: (id) => {
        store.deleteWatchHistory(id);
      },
      clearWatchHistory: () => {
        store.clearWatchHistory();
      },
      listWatchHistory: (limit) => store.listWatchHistory(limit),
    },
    now,
  });
  // Legenda de texto extraida sob demanda e cacheada em DATA_DIR/subs. Nao e
  // transcode de video: veja o cabecalho de stream/subtitle.ts.
  registerSubtitleRoutes(app, {
    source: {
      getEpisode: (id) => {
        const row = store.getEpisode(id);
        return row === null ? null : { relativePath: row.id, subtitleTracks: row.subtitleTracks };
      },
    },
    libraryRoot: config.libraryRoot,
    dataDir: config.dataDir,
  });
  // Quadro do episodio, tirado do proprio video pela fila de miniaturas. So le
  // o que ja esta em DATA_DIR: nada aqui gera imagem dentro de um request.
  registerThumbRoutes(app, {
    source: {
      getEpisode: (id) => {
        const row = store.getEpisode(id);
        return row === null ? null : { thumbFile: row.thumbFile };
      },
    },
    dataDir: config.dataDir,
  });

  // SPA compilada. Em desenvolvimento quem serve isso e o Vite, com proxy do /api.
  //
  // O guarda de NODE_ENV nao e cosmetico: rodando por tsx a partir de src/server,
  // '../web' aponta para o CODIGO-FONTE do frontend, e servir aquilo entregaria
  // os arquivos .ts crus pelo HTTP.
  const webRoot = process.env.WEB_ROOT ?? join(import.meta.dirname, '../web');
  if (process.env.NODE_ENV !== 'development' && existsSync(join(webRoot, 'index.html'))) {
    await app.register(staticFiles, { root: webRoot });
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'rota desconhecida' });
      }
      return reply.sendFile('index.html');
    });
  }

  app.addHook('onClose', async () => {
    // Antes do banco: o agendamento diario e a unica coisa que ainda poderia
    // abrir uma varredura depois do close e escrever num Store fechado.
    controller.stop();
    clearInterval(cacheTimer);
    store.close();
  });

  await app.listen({ port: config.port, host: '0.0.0.0' });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
