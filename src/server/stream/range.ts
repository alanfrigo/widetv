/**
 * Parsing do header `Range` para servir video com seek.
 *
 * Este app sintoniza SEMPRE no meio de um arquivo, entao o Range nao e um
 * detalhe de otimizacao: e o caminho principal. Header invalido nunca derruba o
 * request - na duvida serve o arquivo inteiro, que e o comportamento que a
 * RFC 9110 manda.
 */

export type RangeRequest =
  | { kind: 'full' }
  /** `start` e `end` sao inclusivos, ja recortados ao tamanho do arquivo. */
  | { kind: 'partial'; start: number; end: number }
  | { kind: 'unsatisfiable' };

const FULL: RangeRequest = { kind: 'full' };
const UNSATISFIABLE: RangeRequest = { kind: 'unsatisfiable' };

/**
 * Aceita apenas digitos; evita que '0x10', '1e9' ou '' virem numero.
 * Valor grande demais e sintaticamente valido, entao vira MAX_SAFE_INTEGER em
 * vez de null: cabe ao teste de satisfazibilidade rejeitar (416), nao ao
 * parser ignorar (200).
 */
function parseCount(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : Number.MAX_SAFE_INTEGER;
}

export function parseRangeHeader(header: string | undefined, fileSize: number): RangeRequest {
  if (!header) return FULL;

  const [unit, spec] = header.split('=', 2);
  if (unit === undefined || spec === undefined) return FULL;
  if (unit.trim().toLowerCase() !== 'bytes') return FULL;

  // Multipart byteranges nao vale a complexidade num player de video:
  // fica so com a primeira faixa.
  const first = spec.split(',', 1)[0];
  if (first === undefined) return FULL;

  const dash = first.indexOf('-');
  if (dash === -1) return FULL;

  const rawStart = first.slice(0, dash).trim();
  const rawEnd = first.slice(dash + 1).trim();

  // `bytes=-N`: os ultimos N bytes.
  if (rawStart === '') {
    const suffix = parseCount(rawEnd);
    if (suffix === null) return FULL;
    if (suffix === 0 || fileSize === 0) return UNSATISFIABLE;
    const start = Math.max(0, fileSize - suffix);
    return { kind: 'partial', start, end: fileSize - 1 };
  }

  const start = parseCount(rawStart);
  if (start === null) return FULL;
  if (fileSize === 0 || start >= fileSize) return UNSATISFIABLE;

  // `bytes=N-`: do byte N ate o fim.
  if (rawEnd === '') {
    return { kind: 'partial', start, end: fileSize - 1 };
  }

  const requestedEnd = parseCount(rawEnd);
  if (requestedEnd === null) return FULL;
  if (requestedEnd < start) return UNSATISFIABLE;

  return { kind: 'partial', start, end: Math.min(requestedEnd, fileSize - 1) };
}
