import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';

import { registerAuthGuard, registerAuthRoutes } from './auth/routes';
import { registerChannelRoutes } from './channels/routes';
import { loadConfig } from './config';
import { ensureDataDir } from './data-dir';
import { registerHistoryRoutes } from './history/routes';
import { openStore, type Store } from './library/index-store';
import { runRemux } from './library/remux-job';
import { runScan } from './library/scan-job';
import { createVariantQueue } from './library/variant-queue';
import { createEnricher, type Enricher } from './metadata/service';
import { registerStreamRoutes, type AudioResolution } from './stream/direct';
import { registerSubtitleRoutes } from './stream/subtitle';

/**
 * Montagem do servidor.
 *
 * O scan nao bloqueia o boot. Indexar 14 mil arquivos leva minutos, e um
 * servidor que so responde no fim disso reprova no healthcheck e e reiniciado
 * pelo orquestrador antes de terminar - reiniciando o scan junto, para sempre.
 * Entao: sobe primeiro, indexa depois, em segundo plano.
 */

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SCAN_LOG_INTERVAL_MS = 10_000;

/** Comando de indexacao manual, ja com o caminho certo para este ambiente. */
function scanCommand(libraryRoot: string): string {
  return `node dist/server/scan.js "${libraryRoot}"`;
}

/**
 * Indexa em segundo plano quando o indice esta vazio.
 *
 * Quem sobe isto num NAS nao tem shell no container: exigir um comando manual
 * antes do primeiro canal aparecer transformava um deploy novo em beco sem
 * saida.
 */
/**
 * Conversao MP4 em segundo plano, uma rodada por vez.
 *
 * E disparada no boot (indice ja populado) e no fim de cada scan. A trava de
 * "ja rodando" importa: os dois gatilhos podem se cruzar, e duas rodadas
 * simultaneas leriam o mesmo NAS em dobro para produzir os mesmos arquivos.
 */
function createRemuxTrigger(
  app: FastifyInstance,
  store: Store,
  libraryRoot: string,
  dataDir: string,
): () => void {
  let running = false;
  let ultimoLog = 0;

  return () => {
    if (running) return;
    running = true;

    void runRemux({
      store,
      libraryRoot,
      dataDir,
      onProgress: ({ done, total, episode }) => {
        const agora = Date.now();
        if (agora - ultimoLog < SCAN_LOG_INTERVAL_MS && done < total) return;
        ultimoLog = agora;
        app.log.info(`remux ${done}/${total}  ${episode}`);
      },
    })
      .then((report) => {
        if (report.planned === 0) return;
        app.log.info(
          `remux concluido: ${report.converted} convertidos, ${report.skipped} ja prontos` +
            (report.failed.length > 0 ? `, ${report.failed.length} falharam` : ''),
        );
        for (const failure of report.failed.slice(0, 5)) {
          app.log.warn(`remux falhou em ${failure.path}: ${failure.reason}`);
        }
      })
      .catch((error: unknown) => {
        app.log.error(
          `remux falhou: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        running = false;
      });
  };
}

function bootstrapScan(
  app: FastifyInstance,
  store: Store,
  libraryRoot: string,
  enricher: Enricher,
  onScanDone?: () => void,
): void {
  app.log.info(`indice vazio, indexando ${libraryRoot} em segundo plano`);

  let ultimoLog = 0;
  void runScan({
    root: libraryRoot,
    store,
    onProgress: ({ done, total, show }) => {
      const agora = Date.now();
      if (agora - ultimoLog < SCAN_LOG_INTERVAL_MS && done < total) return;
      ultimoLog = agora;
      app.log.info(`scan ${done}/${total}  ${show}`);
    },
  })
    .then((report) => {
      if (report.shows === 0) {
        // Quase sempre e LIBRARY_ROOT apontando para o lugar errado, ou o
        // volume montado vazio. Dizer isso agora poupa muita procura.
        app.log.error(
          `scan terminou sem nenhum canal. Confira se ${libraryRoot} e mesmo a raiz ` +
            'do acervo (uma pasta por desenho) e se o volume esta montado.',
        );
        return;
      }
      app.log.info(
        `scan concluido: ${report.shows} canais, ${report.episodes} episodios ` +
          `(${report.failed.length} arquivos falharam)`,
      );
      // Capas depois dos canais, e sem esperar: os canais ja funcionam sem elas,
      // e uma rodada de rede em 460 series nao pode atrasar nada.
      enricher.trigger();
      // Remux por ultimo, pelo mesmo motivo: os canais ja funcionam, so os MKV
      // ainda nao tocam - e cada um passa a tocar assim que a sua copia fica
      // pronta, sem esperar a rodada inteira.
      onScanDone?.();
    })
    .catch((error: unknown) => {
      app.log.error(
        `scan falhou: ${error instanceof Error ? error.message : String(error)}. ` +
          `Rode manualmente: ${scanCommand(libraryRoot)}`,
      );
    });
}

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

  // Busca de capa/sinopse. Uma instancia so no processo inteiro: e ela que
  // segura a trava de "ja rodando" entre o fim do scan e a rota de canais.
  const enricher = createEnricher(store, config.dataDir, {
    tmdbApiKey: config.tmdbApiKey,
    log: (message) => {
      app.log.info(message);
    },
  });

  const triggerRemux = config.autoRemux
    ? createRemuxTrigger(app, store, config.libraryRoot, config.dataDir)
    : undefined;

  // Indice existente mas sem nenhuma serie conta como vazio: e o estado de um
  // scan que nunca rodou e o de um scan interrompido no comeco.
  if (store.listShows().length === 0) {
    if (config.autoScan) {
      bootstrapScan(app, store, config.libraryRoot, enricher, triggerRemux);
    } else {
      app.log.warn(
        `indice vazio em ${dbPath} e AUTO_SCAN=false. Rode: ${scanCommand(config.libraryRoot)}`,
      );
    }
  } else {
    // Acervo ja indexado: uma rodada de remux no boot pega o que ficou pendente
    // (deploy da feature, rodada interrompida). Quando esta tudo pronto, ela so
    // percorre o indice e volta - barata o bastante para rodar sempre.
    triggerRemux?.();
  }

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
  // Fila das variantes de dublagem, uma por processo: e ela que impede dois
  // pedidos iguais de gerar o mesmo MP4 duas vezes.
  const variants = createVariantQueue({
    store,
    libraryRoot: config.libraryRoot,
    dataDir: config.dataDir,
    log: (message) => {
      app.log.warn(message);
    },
  });

  /** `?audio=N`: N e o `index` da faixa no arquivo FONTE. */
  async function resolveAudio(episodeId: string, audioIndex: number): Promise<AudioResolution> {
    const row = store.getEpisode(episodeId);
    if (row === null) return { status: 'invalid' };
    const chosen = row.audioTracks.find((track) => track.isDefault) ?? row.audioTracks[0];
    // A faixa pedida ja e a que toca no arquivo servido: nada a gerar.
    if (chosen !== undefined && chosen.index === audioIndex) return { status: 'default' };
    return variants.request(episodeId, audioIndex);
  }

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
        return {
          relativePath: row.id,
          remuxPath:
            remux === null ? null : join(config.dataDir, 'remux', basename(remux.file)),
        };
      },
    },
    config.libraryRoot,
    resolveAudio,
  );

  registerHistoryRoutes(app, {
    source: {
      hasEpisode: (id) => store.getEpisode(id) !== null,
      getWatchHistory: (id) => store.getWatchHistory(id),
      upsertWatchHistory: (row) => {
        store.upsertWatchHistory(row);
      },
      deleteWatchHistory: (id) => {
        store.deleteWatchHistory(id);
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

  app.addHook('onClose', async () => store.close());

  await app.listen({ port: config.port, host: '0.0.0.0' });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
