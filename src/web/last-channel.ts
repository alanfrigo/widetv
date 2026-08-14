/**
 * Memoria do ultimo canal sintonizado.
 *
 * E a unica coisa que este app lembra entre sessoes: todo o resto e derivado do
 * relogio. Fica em `localStorage` e nao em cookie de proposito, porque e estado
 * do cliente e nao tem por que viajar em todo request para o servidor.
 *
 * Toda leitura e validada contra a lista de canais que existe AGORA. O acervo
 * muda: uma serie removida nao pode deixar o usuario preso numa tela morta.
 */

export const LAST_CHANNEL_KEY = 'retro-tv:last-channel';

/** Recorte de `Storage` que este modulo usa, para poder ser testado sem DOM. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * `localStorage` lanca em vez de devolver null quando o navegador bloqueia
 * armazenamento (modo restrito, cookies de terceiros desligados, cota cheia).
 * Lembrar um canal nunca vale derrubar o app.
 */
export function readLastChannel(
  storage: StorageLike | null,
  available: readonly number[],
): number | null {
  if (storage === null) return null;

  let raw: string | null;
  try {
    raw = storage.getItem(LAST_CHANNEL_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;

  const trimmed = raw.trim();
  // So digitos: barra 'abc', '1.5', '-1', 'NaN' e 'Infinity' de uma vez, sem
  // depender das esquisitices de coercao de Number.
  if (!/^\d+$/.test(trimmed)) return null;

  const channel = Number(trimmed);
  return available.includes(channel) ? channel : null;
}

export function writeLastChannel(storage: StorageLike | null, channel: number): void {
  if (storage === null) return;
  try {
    storage.setItem(LAST_CHANNEL_KEY, String(channel));
  } catch {
    // Sem memoria de canal o app continua inteiro; so volta no canal 1.
  }
}

/** `localStorage` quando existe e esta acessivel; null quando o browser nega. */
export function browserStorage(): StorageLike | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
