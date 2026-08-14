/**
 * Medicao da Fase 0: passa o acervo real pelo ffprobe e responde uma pergunta
 * so - esse projeto precisa de transcode?
 *
 *   npm run survey -- /caminho/da/raiz [--sample 200] [--json relatorio.json]
 *
 * Relatorio no stdout, progresso no stderr: quem redireciona o stdout leva o
 * relatorio limpo.
 */

import { writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { extname } from 'node:path';
import { pathToFileURL } from 'node:url';

import { probeFile } from '../library/probe.js';
import type { ProbeResult } from '../library/probe-types.js';
import { scanLibrary, type ScannedShow } from '../library/scanner.js';

export interface SurveyArgs {
  root: string;
  /** Valor de --sample; null quando o acervo inteiro deve ser analisado. */
  sample: number | null;
  /** Caminho de --json; null quando nao foi pedido. */
  jsonPath: string | null;
}

/** Um arquivo do acervo, do jeito que o scanner o entrega, antes do probe. */
export interface SurveyFile {
  showSlug: string;
  showName: string;
  relativePath: string;
  absolutePath: string;
  /** Extensao em minusculas, com ponto. */
  extension: string;
}

const USAGE = 'uso: npm run survey -- /caminho/da/raiz [--sample 200] [--json relatorio.json]';

export function parseArgs(argv: readonly string[]): SurveyArgs {
  let root: string | null = null;
  let sample: number | null = null;
  let jsonPath: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--sample') {
      i += 1;
      const value = argv[i];
      const parsed = value === undefined ? Number.NaN : Number(value);
      // NaN silencioso viraria "sem amostra" e o survey varreria as 14 mil.
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`--sample precisa de um inteiro >= 1, recebi: ${value ?? '(nada)'}`);
      }
      sample = parsed;
    } else if (arg === '--json') {
      i += 1;
      const value = argv[i];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`--json precisa do caminho do arquivo. ${USAGE}`);
      }
      jsonPath = value;
    } else if (arg.startsWith('--')) {
      throw new Error(`opcao desconhecida: ${arg}. ${USAGE}`);
    } else if (root !== null) {
      throw new Error(`informe uma raiz so, recebi "${root}" e "${arg}". ${USAGE}`);
    } else {
      root = arg;
    }
  }

  if (root === null) {
    throw new Error(`informe a raiz da biblioteca. ${USAGE}`);
  }
  return { root, sample, jsonPath };
}

/**
 * Amostragem deterministica: sem ela, o survey de 14 mil arquivos leva horas.
 * Nunca sao "os N primeiros" - isso mediria uma serie so.
 */
export function pickSample(files: readonly SurveyFile[], n: number): SurveyFile[] {
  if (n <= 0) return [];
  if (n >= files.length) return [...files];

  const groups = groupByShow(files);
  const chosen: number[] = [];

  if (n < groups.length) {
    // Nao cabe nem uma amostra por serie: escolhe series espalhadas pelo acervo
    // e mede o episodio do meio de cada uma.
    for (const g of evenIndices(groups.length, n)) {
      const group = groups[g] ?? [];
      chosen.push(group[Math.floor(group.length / 2)] ?? 0);
    }
  } else {
    const quotas = allocateQuotas(
      n,
      groups.map((group) => group.length),
    );
    groups.forEach((group, i) => {
      for (const j of evenIndices(group.length, quotas[i] ?? 0)) {
        chosen.push(group[j] ?? 0);
      }
    });
  }

  chosen.sort((a, b) => a - b);
  return chosen.map((index) => files[index]!);
}

/** Indices dos arquivos de cada serie, na ordem em que as series aparecem. */
function groupByShow(files: readonly SurveyFile[]): number[][] {
  const bySlug = new Map<string, number[]>();
  files.forEach((file, index) => {
    const group = bySlug.get(file.showSlug);
    if (group) group.push(index);
    else bySlug.set(file.showSlug, [index]);
  });
  return [...bySlug.values()];
}

/**
 * Divide `n` amostras entre as series: uma para cada (senao uma serie inteira
 * some da conta de codecs) e o resto proporcional ao tamanho, por maior sobra.
 * A soma bate exatamente `n` e ninguem recebe mais do que tem.
 */
function allocateQuotas(n: number, sizes: readonly number[]): number[] {
  const quotas = sizes.map(() => 1);
  const rest = n - sizes.length;
  const capacity = sizes.map((size) => size - 1);
  const totalCapacity = capacity.reduce((sum, value) => sum + value, 0);
  if (rest <= 0 || totalCapacity === 0) return quotas;

  const exact = capacity.map((value) => (rest * value) / totalCapacity);
  let given = 0;
  exact.forEach((value, i) => {
    const floor = Math.floor(value);
    quotas[i] = 1 + floor;
    given += floor;
  });

  // Sobras: quem tem a maior parte fracionaria leva, empate pelo indice.
  const order = exact
    .map((value, i) => ({ i, frac: value - Math.floor(value) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  let remaining = rest - given;
  for (const { i } of order) {
    if (remaining <= 0) break;
    if ((quotas[i] ?? 0) >= (sizes[i] ?? 0)) continue;
    quotas[i] = (quotas[i] ?? 0) + 1;
    remaining -= 1;
  }
  return quotas;
}

/**
 * `k` indices distintos espalhados por `[0, m)`, sempre os mesmos para a mesma
 * entrada. O meio de cada fatia, e nao o inicio: pegar o inicio devolveria o
 * indice 0 e o comeco de cada serie, que e justamente onde a amostra engana.
 */
function evenIndices(m: number, k: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < k; i += 1) {
    out.push(Math.floor(((i + 0.5) * m) / k));
  }
  return out;
}

export interface ProbedFile {
  file: SurveyFile;
  probe: ProbeResult;
}

export interface SurveyFailure {
  path: string;
  reason: string;
}

export interface SummaryInput {
  root: string;
  /** Tudo que o scanner achou, antes da amostragem. */
  allFiles: readonly SurveyFile[];
  probed: readonly ProbedFile[];
  failures: readonly SurveyFailure[];
  /** Valor de --sample, ou null quando o acervo inteiro foi analisado. */
  sampleRequested: number | null;
}

export interface CountBucket {
  label: string;
  count: number;
  /** Percentual sobre o denominador da secao, com uma casa decimal. */
  percent: number;
}

export interface SurveyReport {
  root: string;
  shows: number;
  /** Arquivos encontrados no acervo. */
  files: number;
  /** Arquivos que o ffprobe leu com sucesso. */
  probed: number;
  /** Arquivos que entraram na amostra (analisados + falhados). */
  sampled: number;
  sampleRequested: number | null;
  videoCodecs: CountBucket[];
  audioCodecs: CountBucket[];
  /** Por extensao, medido sobre o acervo inteiro: nao depende do ffprobe. */
  containers: CountBucket[];
  resolutions: CountBucket[];
  faststart: FaststartSummary;
  /** Soma das duracoes medidas (so da amostra, quando ha --sample). */
  totalDurationMs: number;
  medianDurationMs: number;
  /**
   * Extrapolacao da duracao do acervo quando so uma amostra foi medida; null
   * quando tudo foi medido e `totalDurationMs` ja e o numero real.
   */
  estimatedTotalDurationMs: number | null;
  /** Arquivos que o ffprobe nao conseguiu ler, com o motivo. */
  failures: SurveyFailure[];
  verdicts: SurveyVerdicts;
}

export type RiskLevel = 'alto' | 'baixo' | 'indeterminado';

export interface RiskVerdict {
  level: RiskLevel;
  count: number;
  percent: number;
}

export interface CodecRiskVerdict extends RiskVerdict {
  /** Nomes dos codecs contados, do mais comum para o menos. */
  labels: string[];
}

export interface SurveyVerdicts {
  h265: RiskVerdict;
  /** Codecs que o navegador nao decodifica: mpeg4, wmv3, vc1 e companhia. */
  unsupported: CodecRiskVerdict;
  /** Quantos precisam de remux para o `moov` vir antes do `mdat`. */
  faststart: RiskVerdict;
}

/**
 * Acima disso o transcode deixa de ser excecao e vira requisito do projeto:
 * 5% de um acervo de 14 mil arquivos ja sao ~700 episodios que nao tocam.
 */
export const HIGH_RISK_PERCENT = 5;

export interface FaststartSummary {
  yes: number;
  no: number;
  /** Percentual dos analisados que precisa de remux para tocar sem baixar tudo. */
  percentNeedingRemux: number;
}

/** Balde de campo ausente; fica sempre no fim da lista, nao se mistura. */
export const MISSING_LABEL = '(sem stream)';

/**
 * Toda a leitura do acervo vira numero aqui. Funcao pura de proposito: o
 * veredito e o que decide o projeto, entao ele precisa ser testavel sem disco.
 */
export function summarize(input: SummaryInput): SurveyReport {
  const shows = new Set(input.allFiles.map((file) => file.showSlug)).size;
  const durations = input.probed.map((item) => item.probe.durationMs);
  return {
    root: input.root,
    shows,
    files: input.allFiles.length,
    probed: input.probed.length,
    sampled: input.probed.length + input.failures.length,
    sampleRequested: input.sampleRequested,
    videoCodecs: distribution(
      input.probed.map((item) => item.probe.videoCodec),
      input.probed.length,
    ),
    audioCodecs: distribution(
      input.probed.map((item) => item.probe.audioCodec),
      input.probed.length,
    ),
    containers: distribution(
      input.allFiles.map((file) => file.extension),
      input.allFiles.length,
    ),
    resolutions: ordered(
      distribution(
        input.probed.map((item) => resolutionBucket(item.probe.height)),
        input.probed.length,
      ),
      RESOLUTION_ORDER,
    ),
    faststart: faststartSummary(input.probed),
    totalDurationMs: durations.reduce((sum, value) => sum + value, 0),
    medianDurationMs: median(durations),
    estimatedTotalDurationMs: estimateTotal(durations, input),
    failures: [...input.failures],
    verdicts: {
      h265: h265Verdict(input.probed),
      unsupported: unsupportedVerdict(input.probed),
      faststart: faststartVerdict(input.probed),
    },
  };
}

/** `hevc` e `h265` sao o mesmo codec com dois nomes no ffprobe. */
function isH265(codec: string | null): boolean {
  const name = codec?.toLowerCase() ?? '';
  return name === 'hevc' || name === 'h265';
}

function h265Verdict(probed: readonly ProbedFile[]): RiskVerdict {
  const count = probed.filter((item) => isH265(item.probe.videoCodec)).length;
  const percent = percentOf(count, probed.length);
  // Sem nenhum arquivo medido nao existe "risco baixo", existe "nao sei".
  if (probed.length === 0) return { level: 'indeterminado', count: 0, percent: 0 };
  return { level: percent >= HIGH_RISK_PERCENT ? 'alto' : 'baixo', count, percent };
}

function faststartVerdict(probed: readonly ProbedFile[]): RiskVerdict {
  if (probed.length === 0) return { level: 'indeterminado', count: 0, percent: 0 };
  const count = probed.filter((item) => !item.probe.faststart).length;
  const percent = percentOf(count, probed.length);
  return { level: percent >= HIGH_RISK_PERCENT ? 'alto' : 'baixo', count, percent };
}

/**
 * Codecs que um navegador atual decodifica sem ajuda.
 *
 * AV1 esta aqui de proposito e nao no balde de risco: o Chrome traz o dav1d por
 * software em qualquer maquina e o ExoPlayer decodifica nativo. Classificar AV1
 * como perigoso so porque nao e h264 levaria a construir um transcoder que
 * ninguem precisa.
 *
 * H.265 fica de fora desta lista porque tem veredito proprio: so toca onde o
 * sistema operacional expoe decodificador de hardware.
 */
const BROWSER_PLAYABLE = new Set(['h264', 'avc1', 'av1', 'av01', 'vp8', 'vp9']);

function unsupportedVerdict(probed: readonly ProbedFile[]): CodecRiskVerdict {
  const unplayable = probed
    .map((item) => item.probe.videoCodec?.toLowerCase() ?? '')
    // Codec ausente e problema de acervo, nao de formato: nao entra na conta.
    .filter((name) => name !== '' && !BROWSER_PLAYABLE.has(name) && !isH265(name));

  if (probed.length === 0) {
    return { level: 'indeterminado', count: 0, percent: 0, labels: [] };
  }

  const percent = percentOf(unplayable.length, probed.length);
  return {
    level: percent >= HIGH_RISK_PERCENT ? 'alto' : 'baixo',
    count: unplayable.length,
    percent,
    labels: distribution(unplayable, unplayable.length).map((bucket) => bucket.label),
  };
}

/** Media da amostra x tamanho do acervo. Sem amostragem nao ha o que estimar. */
function estimateTotal(durations: readonly number[], input: SummaryInput): number | null {
  const probed = durations.length;
  if (input.sampleRequested === null) return null;
  if (probed === 0 || probed >= input.allFiles.length) return null;
  const total = durations.reduce((sum, value) => sum + value, 0);
  return Math.round((total / probed) * input.allFiles.length);
}

/** Mediana em ms; com quantidade par, a media dos dois do meio. */
function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2);
}

function faststartSummary(probed: readonly ProbedFile[]): FaststartSummary {
  const yes = probed.filter((item) => item.probe.faststart).length;
  const no = probed.length - yes;
  return { yes, no, percentNeedingRemux: percentOf(no, probed.length) };
}

const RESOLUTION_ORDER = ['<=480p', '720p', '1080p', 'acima de 1080p', MISSING_LABEL];

/** Faixa de resolucao pela altura; a largura varia demais (4:3, 16:9, anamorfico). */
function resolutionBucket(height: number | null): string | null {
  if (height === null) return null;
  if (height <= 480) return '<=480p';
  if (height <= 720) return '720p';
  if (height <= 1080) return '1080p';
  return 'acima de 1080p';
}

/** Resolucao se le em ordem crescente, nao por tamanho da fatia. */
function ordered(buckets: CountBucket[], order: readonly string[]): CountBucket[] {
  return [...buckets].sort(
    (a, b) => order.indexOf(a.label) - order.indexOf(b.label),
  );
}

/** Contagem por rotulo, maior primeiro, com o balde de ausente sempre no fim. */
function distribution(
  values: readonly (string | null)[],
  total: number,
): CountBucket[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    const label = value ?? MISSING_LABEL;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count, percent: percentOf(count, total) }))
    .sort(compareBuckets);
}

function compareBuckets(a: CountBucket, b: CountBucket): number {
  const aMissing = a.label === MISSING_LABEL ? 1 : 0;
  const bMissing = b.label === MISSING_LABEL ? 1 : 0;
  if (aMissing !== bMissing) return aMissing - bMissing;
  if (a.count !== b.count) return b.count - a.count;
  return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
}

/** Percentual com uma casa; denominador zero vira 0 em vez de NaN. */
function percentOf(count: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((count / total) * 1000) / 10;
}

/** Percentual em texto: sem casa decimal quando e inteiro, uma casa quando nao. */
function formatPercent(percent: number): string {
  return `${Number.isInteger(percent) ? String(percent) : percent.toFixed(1)}%`;
}

/** Duracao legivel: `1h 30m`, `22m 30s`, `45s`. */
function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${String(hours)}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${String(minutes)}m ${String(seconds).padStart(2, '0')}s`;
  return `${String(seconds)}s`;
}

/** Uma linha de distribuicao, alinhada para a coluna dar para comparar de olho. */
function formatBucket(bucket: CountBucket): string {
  return `  ${bucket.label.padEnd(16)} ${String(bucket.count).padStart(7)}  ${formatPercent(bucket.percent).padStart(6)}`;
}

/** Quantas falhas cabem no texto; o resto so no --json. */
const MAX_FAILURES_PRINTED = 50;

/**
 * Relatorio em texto para o stdout. As linhas de VEREDITO sao o motivo de o
 * script existir e seguem o formato do contrato ao pe da letra.
 */
export function formatReport(report: SurveyReport): string {
  const { h265, unsupported, faststart } = report.verdicts;
  const analisados = report.probed;
  const escopo =
    report.sampleRequested === null
      ? 'acervo inteiro'
      : `amostra deterministica de ${String(report.sampleRequested)}`;
  const lines: string[] = [
    'SURVEY DA BIBLIOTECA',
    `raiz:        ${report.root}`,
    `series:      ${String(report.shows)}`,
    `arquivos:    ${String(report.files)}`,
    `analisados:  ${String(analisados)} de ${String(report.files)}  (${escopo})`,
    `falhas:      ${String(report.failures.length)}`,
    '',
    `CODEC DE VIDEO  (${String(analisados)} analisados)`,
    ...report.videoCodecs.map(formatBucket),
    '',
    `CODEC DE AUDIO  (${String(analisados)} analisados)`,
    ...report.audioCodecs.map(formatBucket),
    '',
    `CONTAINER  (${String(report.files)} arquivos do acervo, sem ffprobe)`,
    ...report.containers.map(formatBucket),
    '',
    `RESOLUCAO  (${String(analisados)} analisados)`,
    ...report.resolutions.map(formatBucket),
    '',
    `FASTSTART  (${String(analisados)} analisados)`,
    formatBucket({
      label: 'moov na frente',
      count: report.faststart.yes,
      percent: percentOf(report.faststart.yes, analisados),
    }),
    formatBucket({
      label: 'precisa remux',
      count: report.faststart.no,
      percent: report.faststart.percentNeedingRemux,
    }),
    '',
    'DURACAO',
    `  medida:            ${formatDuration(report.totalDurationMs)}  (${String(analisados)} arquivos)`,
    `  mediana:           ${formatDuration(report.medianDurationMs)}`,
  ];

  if (report.estimatedTotalDurationMs !== null) {
    lines.push(
      `  acervo estimado:   ${formatDuration(report.estimatedTotalDurationMs)}  (extrapolado da amostra)`,
    );
  }

  if (report.failures.length > 0) {
    lines.push('', `FALHAS NO PROBE  (${String(report.failures.length)})`);
    for (const failure of report.failures.slice(0, MAX_FAILURES_PRINTED)) {
      lines.push(`  ${failure.path}`, `    ${failure.reason}`);
    }
    if (report.failures.length > MAX_FAILURES_PRINTED) {
      lines.push(`  ... e mais ${String(report.failures.length - MAX_FAILURES_PRINTED)}`);
    }
  }

  lines.push(
    '',
    'VEREDITO',
    `H265 DIRECT PLAY: risco ${h265.level} - ${String(h265.count)} de ${String(analisados)} arquivos (${formatPercent(h265.percent)}) em h265`,
    `CODEC NAO REPRODUZIVEL: risco ${unsupported.level} - ${String(unsupported.count)} de ${String(analisados)} arquivos (${formatPercent(unsupported.percent)}) fora do que o navegador decodifica${unsupported.labels.length > 0 ? `: ${unsupported.labels.join(', ')}` : ''}`,
    `FASTSTART: ${formatPercent(faststart.percent)} precisam de remux - ${String(faststart.count)} de ${String(analisados)} arquivos`,
  );

  return lines.join('\n');
}

export interface SurveyRunOptions {
  root: string;
  /** null = acervo inteiro. */
  sample: number | null;
  /** Default: numero de CPUs. */
  concurrency?: number;
  /** Injetavel para teste; por padrao chama o ffprobe de verdade. */
  probe?: (filePath: string) => Promise<ProbeResult>;
  /** Progresso; o CLI manda para stderr. */
  onProgress?: (done: number, total: number) => void;
}

/** Achata o resultado do scanner na lista de arquivos que o survey mede. */
function flatten(shows: readonly ScannedShow[]): SurveyFile[] {
  const files: SurveyFile[] = [];
  for (const show of shows) {
    for (const episode of show.episodes) {
      files.push({
        showSlug: show.slug,
        showName: show.name,
        relativePath: episode.relativePath,
        absolutePath: episode.absolutePath,
        extension: extname(episode.absolutePath).toLowerCase(),
      });
    }
  }
  return files;
}

export async function runSurvey(options: SurveyRunOptions): Promise<SurveyReport> {
  const probe = options.probe ?? ((filePath: string) => probeFile(filePath));
  const concurrency = Math.max(1, options.concurrency ?? cpus().length);

  const allFiles = flatten(await scanLibrary(options.root));
  const selected = options.sample === null ? allFiles : pickSample(allFiles, options.sample);

  const results = new Array<ProbedFile | SurveyFailure>(selected.length);
  let done = 0;
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      const file = selected[index];
      if (file === undefined) return;
      try {
        results[index] = { file, probe: await probe(file.absolutePath) };
      } catch (error) {
        results[index] = {
          path: file.absolutePath,
          reason: error instanceof Error ? error.message : String(error),
        };
      } finally {
        done += 1;
        options.onProgress?.(done, selected.length);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, selected.length) }, worker),
  );

  // Particiona na ordem original: relatorio igual em toda rodada, apesar da
  // concorrencia.
  const probed: ProbedFile[] = [];
  const failures: SurveyFailure[] = [];
  for (const result of results) {
    if (result === undefined) continue;
    if ('probe' in result) probed.push(result);
    else failures.push(result);
  }

  return summarize({
    root: options.root,
    allFiles,
    probed,
    failures,
    sampleRequested: options.sample,
  });
}

/** Intervalo entre repintadas da barra: o NAS nao precisa de 14 mil linhas. */
const PROGRESS_INTERVAL_MS = 250;

export async function main(argv: readonly string[]): Promise<void> {
  const args = parseArgs(argv);
  let lastPaint = 0;

  const report = await runSurvey({
    root: args.root,
    sample: args.sample,
    onProgress: (done, total) => {
      const now = Date.now();
      if (now - lastPaint < PROGRESS_INTERVAL_MS && done < total) return;
      lastPaint = now;
      const percent = total === 0 ? 100 : Math.floor((done / total) * 100);
      // Progresso no stderr: o stdout e do relatorio, e alguem vai redirecionar.
      process.stderr.write(`\rprobe ${String(done)}/${String(total)} (${String(percent)}%)`);
    },
  });
  process.stderr.write('\n');

  if (args.jsonPath !== null) {
    await writeFile(args.jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stderr.write(`json: ${args.jsonPath}\n`);
  }

  process.stdout.write(`${formatReport(report)}\n`);
}

/** Rodando como script, e nao importado por teste ou por outro modulo. */
const executadoDireto =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (executadoDireto) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
