import { resolve, join } from 'node:path';

import { ensureDataDir } from '../data-dir';
import { openStore } from '../library/index-store';
import { runTranscodeLegacy, type TranscodeReport } from '../library/transcode-job';

/**
 * Reconversao dos arquivos que NENHUM remux salva.
 *
 *   npm run transcode-legacy -- [raiz] [opcoes]
 *   node dist/server/transcode-legacy.js [raiz] [opcoes]
 *
 * Remux copia bytes; nao decodifica imagem. Um acervo com MPEG-4 Part 2
 * (DivX/XviD dos rips antigos) nao toca em navegador nenhum, e trocar o
 * container nao muda isso - o arquivo precisa ser reconvertido. Esta e a unica
 * ferramenta do projeto que faz isso, e a unica que escreve na biblioteca.
 *
 * NADA aqui roda sozinho: sem `--replace`, o original nunca e tocado; sem
 * nenhuma flag, nem ffmpeg roda. Depende do INDICE - rode o scan antes.
 */

interface Options {
  root: string;
  dryRun: boolean;
  replace: boolean;
  keepOriginalsDir: string | null;
  limit: number | undefined;
  only: string | undefined;
}

function parseArgs(argv: readonly string[]): Options | string {
  let root: string | undefined;
  let dryRun = true;
  let replace = false;
  let keepOriginalsDir: string | null = null;
  let limit: number | undefined;
  let only: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--apply') {
      dryRun = false;
    } else if (arg === '--replace') {
      // `--replace` implica converter: pedir para substituir e continuar em
      // dry-run nao e um estado que alguem queira.
      dryRun = false;
      replace = true;
    } else if (arg === '--keep-originals') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) return '--keep-originals precisa de um diretorio';
      keepOriginalsDir = resolve(value);
    } else if (arg === '--limit') {
      const value = argv[++i];
      if (value === undefined || !/^\d+$/.test(value)) return '--limit precisa de um inteiro';
      limit = Number(value);
    } else if (arg === '--only') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) return '--only precisa de um caminho relativo';
      only = value;
    } else if (arg.startsWith('--')) {
      return `opcao desconhecida: ${arg}`;
    } else if (root === undefined) {
      root = arg;
    }
  }

  const chosen = root ?? process.env.LIBRARY_ROOT;
  if (chosen === undefined || chosen.trim() === '') {
    return 'informe a raiz: npm run transcode-legacy -- "/caminho/da/biblioteca"';
  }
  return { root: chosen, dryRun, replace, keepOriginalsDir, limit, only };
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${String(s)}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${String(m)}m ${String(s % 60)}s` : `${String(Math.floor(m / 60))}h ${String(m % 60)}m`;
}

function formatGiB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

const USAGE = `
Uso: npm run transcode-legacy -- [raiz] [opcoes]

  (sem opcao)          lista e mede os candidatos. NAO converte nada.
  --apply              converte, gravando "<nome>.h264.mp4" ao lado do original.
  --replace            converte e, DEPOIS de conferir o resultado, tira o
                       original de circulacao. Implica --apply.
  --keep-originals DIR com --replace, MOVE o original para DIR preservando o
                       caminho relativo, em vez de apagar. Torna o lote
                       reversivel com um "mv".
  --limit N            no maximo N episodios nesta rodada.
  --only CAMINHO       so o que comeca com este caminho relativo.
`.trimStart();

function printReport(report: TranscodeReport, options: Options): void {
  console.log(`candidatos:  ${String(report.candidates)}`);
  console.log(`no disco:    ${formatGiB(report.sourceBytes)} nos originais`);

  if (options.dryRun) {
    console.log('');
    console.log('DRY-RUN: nada foi convertido e nenhum arquivo foi tocado.');
    // Medido nesta receita (crf 20, tune animation) num episodio real do
    // acervo de referencia: 195 MB de .avi viraram 164 MB de h264 - 0,84x.
    // Vai anunciado como estimativa porque o fator depende do conteudo, mas
    // erra para MENOS espaco livre, que e o lado seguro de errar.
    console.log(`estimativa:  ~${formatGiB(report.sourceBytes * 0.84)} depois de converter`);
    console.log('Rode com --apply para converter, ou --replace para tambem');
    console.log('substituir os originais (que so saem depois da conferencia).');
    for (const item of report.items.slice(0, 10)) {
      console.log(`  ${item.episodeId}`);
    }
    if (report.items.length > 10) {
      console.log(`  ... e mais ${String(report.items.length - 10)}`);
    }
    return;
  }

  console.log(`convertidos: ${String(report.converted)}`);
  if (report.skipped > 0) console.log(`ja prontos:  ${String(report.skipped)}`);
  if (report.replaced > 0) {
    console.log(
      `substituidos: ${String(report.replaced)}` +
        (options.keepOriginalsDir === null
          ? ''
          : ` (originais movidos para ${options.keepOriginalsDir})`),
    );
  }
  console.log(`gerado:      ${formatGiB(report.outputBytes)}`);
  console.log(`tempo:       ${formatDuration(report.durationMs)}`);

  const failures = report.items.filter((item) => item.status === 'failed');
  if (failures.length > 0) {
    console.log('');
    console.log(`FALHARAM ${String(failures.length)} (os originais continuam intactos):`);
    for (const item of failures.slice(0, 10)) {
      console.log(`  ${item.episodeId}: ${item.reason ?? 'motivo desconhecido'}`);
    }
  }

  if (report.converted > 0) {
    console.log('');
    // O id do episodio E o caminho relativo, entao o arquivo novo e um episodio
    // NOVO para o indice. Sem rescan, o catalogo continua apontando para o .avi
    // (que pode nem existir mais, com --replace).
    console.log('AGORA RODE O SCAN: os arquivos novos tem outro nome, e o indice');
    console.log('ainda aponta para os antigos. O progresso salvo desses episodios');
    console.log('nao sobrevive a troca de nome.');
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (typeof parsed === 'string') {
    console.error(parsed);
    console.error('');
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  // Mesma resolucao do servidor, incluindo o caso da variavel chegar em branco.
  const dataDir = resolve(process.env.DATA_DIR?.trim() || './data');
  ensureDataDir(dataDir);
  const store = openStore(join(dataDir, 'library.sqlite'));

  if (!parsed.dryRun) {
    console.error(
      parsed.replace
        ? 'ATENCAO: --replace tira os originais de circulacao depois de converter.'
        : 'Convertendo. Os originais NAO serao tocados.',
    );
  }

  let ultimoAviso = 0;
  const report = await runTranscodeLegacy({
    store,
    libraryRoot: parsed.root,
    dryRun: parsed.dryRun,
    replace: parsed.replace,
    keepOriginalsDir: parsed.keepOriginalsDir,
    limit: parsed.limit,
    only: parsed.only,
    ffmpegPath: process.env.FFMPEG_PATH?.trim() || 'ffmpeg',
    ffprobePath: process.env.FFPROBE_PATH?.trim() || 'ffprobe',
    onProgress: ({ done, total, episode }) => {
      // Progresso vai para stderr para nao sujar um stdout redirecionado.
      const agora = Date.now();
      if (agora - ultimoAviso < 250 && done < total) return;
      ultimoAviso = agora;
      process.stderr.write(
        `\r${String(done)}/${String(total)}  ${episode.slice(0, 48).padEnd(48)}`,
      );
    },
  });
  // Sempre fecha a linha de progresso, inclusive em dry-run: sem isto o
  // relatorio sai grudado no contador ("3/3   candidatos: 3").
  process.stderr.write('\n');
  store.close();

  printReport(report, parsed);

  if (report.failed > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
