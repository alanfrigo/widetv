import { join, resolve } from 'node:path';

import { ensureDataDir } from '../data-dir';
import { openStore } from '../library/index-store';
import { runScan } from '../library/scan-job';
import { effectiveSmartGrouping } from '../settings/store';

/**
 * Indexacao do acervo.
 *
 *   npm run scan -- [raiz]                 (desenvolvimento)
 *   node dist/server/scan.js [raiz]        (dentro do container)
 *
 * A segunda forma existe porque `npm run scan` depende do tsx, que e
 * dependencia de desenvolvimento e nao vai na imagem: dentro do container o
 * unico jeito de reindexar e o arquivo compilado.
 *
 * A raiz vem do argumento ou de LIBRARY_ROOT. Rodar de novo e barato: so o que
 * mudou de mtime ou tamanho passa pelo ffprobe.
 */

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

async function main(): Promise<void> {
  const root = process.argv[2] ?? process.env.LIBRARY_ROOT;
  if (root === undefined || root.trim() === '') {
    throw new Error('informe a raiz: npm run scan -- "/caminho/da/biblioteca"');
  }

  // Mesma resolucao do servidor, incluindo o caso da variavel chegar em branco.
  const dataDir = resolve(process.env.DATA_DIR?.trim() || './data');
  ensureDataDir(dataDir);
  const store = openStore(join(dataDir, 'library.sqlite'));

  // Mesmo criterio do servidor: escolha do painel quando existe, senao o
  // SMART_GROUPING do ambiente. Um scan manual com criterio proprio reagruparia
  // o acervo de um jeito que o rescan da madrugada desfaria na rodada seguinte.
  const smartGrouping = effectiveSmartGrouping(
    store,
    process.env.SMART_GROUPING?.trim().toLowerCase() !== 'false',
  );

  let ultimoAviso = 0;
  const report = await runScan({
    root,
    store,
    smartGrouping,
    // Mesmo override do servidor: fora do PATH em launchd/container.
    ffprobePath: process.env.FFPROBE_PATH?.trim() || 'ffprobe',
    onProgress: ({ done, total, show }) => {
      // Progresso vai para stderr para nao sujar um stdout redirecionado.
      const agora = Date.now();
      if (agora - ultimoAviso < 250 && done < total) return;
      ultimoAviso = agora;
      process.stderr.write(`\r${done}/${total}  ${show.slice(0, 48).padEnd(48)}`);
    },
  });
  process.stderr.write('\n');
  store.close();

  console.log(`canais:     ${report.shows}`);
  console.log(`episodios:  ${report.episodes}`);
  console.log(`analisados: ${report.probed}  (${report.cached} do cache)`);
  if (report.removedEpisodes > 0 || report.removedShows > 0) {
    console.log(`removidos:  ${report.removedShows} canais, ${report.removedEpisodes} episodios`);
  }
  console.log(`tempo:      ${formatDuration(report.durationMs)}`);

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
