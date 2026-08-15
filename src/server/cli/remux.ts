import { join, resolve } from 'node:path';

import { ensureDataDir } from '../data-dir';
import { openStore } from '../library/index-store';
import { runRemux } from '../library/remux-job';

/**
 * Conversao MP4 dos episodios que o navegador nao toca direto (ver
 * library/remux-plan.ts).
 *
 *   npm run remux -- [raiz]                (desenvolvimento)
 *   node dist/server/remux.js [raiz]       (dentro do container)
 *
 * Depende do INDICE: rode o scan antes. Rodar de novo e barato - o que ja foi
 * convertido e pulado pelo par (mtime, size) do arquivo fonte.
 */

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

async function main(): Promise<void> {
  const root = process.argv[2] ?? process.env.LIBRARY_ROOT;
  if (root === undefined || root.trim() === '') {
    throw new Error('informe a raiz: npm run remux -- "/caminho/da/biblioteca"');
  }

  // Mesma resolucao do servidor, incluindo o caso da variavel chegar em branco.
  const dataDir = resolve(process.env.DATA_DIR?.trim() || './data');
  ensureDataDir(dataDir);
  const store = openStore(join(dataDir, 'library.sqlite'));

  let ultimoAviso = 0;
  const report = await runRemux({
    store,
    libraryRoot: root,
    dataDir,
    // Mesmo override do servidor: fora do PATH em launchd/container.
    ffmpegPath: process.env.FFMPEG_PATH?.trim() || 'ffmpeg',
    ffprobePath: process.env.FFPROBE_PATH?.trim() || 'ffprobe',
    onProgress: ({ done, total, episode }) => {
      // Progresso vai para stderr para nao sujar um stdout redirecionado.
      const agora = Date.now();
      if (agora - ultimoAviso < 250 && done < total) return;
      ultimoAviso = agora;
      process.stderr.write(`\r${done}/${total}  ${episode.slice(0, 48).padEnd(48)}`);
    },
  });
  process.stderr.write('\n');
  store.close();

  console.log(`planejados:  ${report.planned}`);
  console.log(`convertidos: ${report.converted}  (${report.skipped} ja prontos)`);
  if (report.removedFiles > 0) {
    console.log(`recolhidos:  ${report.removedFiles} arquivos orfaos`);
  }
  console.log(`tempo:       ${formatDuration(report.durationMs)}`);

  if (report.failed.length > 0) {
    console.log(`\nfalharam (${report.failed.length}):`);
    for (const failure of report.failed.slice(0, 20)) {
      console.log(`  ${failure.path}\n    ${failure.reason}`);
    }
    if (report.failed.length > 20) {
      console.log(`  ... e mais ${report.failed.length - 20}`);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
