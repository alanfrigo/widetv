import { existsSync } from 'node:fs';
import { join } from 'node:path';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';

import { registerAuthGuard, registerAuthRoutes } from './auth/routes';
import { registerChannelRoutes } from './channels/routes';
import { loadConfig } from './config';
import { registerConfigRoutes } from './config-routes';
import { ensureDataDir } from './data-dir';
import { openStore, type Store } from './library/index-store';
import { runScan } from './library/scan-job';
import { registerStreamRoutes } from './stream/direct';
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
function bootstrapScan(app: FastifyInstance, store: Store, libraryRoot: string): void {
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
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

  // Indice existente mas sem nenhuma serie conta como vazio: e o estado de um
  // scan que nunca rodou e o de um scan interrompido no comeco.
  if (store.listShows().length === 0) {
    if (config.autoScan) {
      bootstrapScan(app, store, config.libraryRoot);
    } else {
      app.log.warn(
        `indice vazio em ${dbPath} e AUTO_SCAN=false. Rode: ${scanCommand(config.libraryRoot)}`,
      );
    }
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
  registerChannelRoutes(app, { source: store, epochMs: config.channelEpochMs, now });
  registerConfigRoutes(app, { displayMode: config.displayMode });
  // `EpisodeRow.id` JA e o caminho relativo a raiz: e assim que o mesmo indice
  // funciona no host e dentro do container.
  registerStreamRoutes(
    app,
    {
      getEpisode: (id) => {
        const row = store.getEpisode(id);
        return row === null ? null : { relativePath: row.id };
      },
    },
    config.libraryRoot,
  );
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
