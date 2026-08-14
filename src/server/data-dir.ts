import { accessSync, constants, mkdirSync } from 'node:fs';

/**
 * Garantia de que o diretorio do indice existe e aceita escrita.
 *
 * Isso e checado no boot de proposito. O SQLite so tenta gravar quando alguem
 * escreve nele, entao um DATA_DIR errado passava despercebido ate o meio do
 * scan - ou pior, ate o container reiniciar em loop. O caso classico e o
 * DATA_DIR chegar vazio pela UI do TrueNAS: o caminho cai para ./data, que
 * dentro do container e /app/data, um diretorio do root sem volume montado
 * enquanto o processo roda como `node`.
 */

export class DataDirError extends Error {
  override readonly name = 'DataDirError';
}

function detalhe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ensureDataDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    throw new DataDirError(
      `nao consegui criar o diretorio de dados ${dir} (${detalhe(error)}). ` +
        'Aponte DATA_DIR para um volume com permissao de escrita.',
    );
  }

  try {
    accessSync(dir, constants.W_OK);
  } catch {
    throw new DataDirError(
      `sem permissao de escrita em ${dir}. O indice precisa gravar ali. ` +
        'Ajuste DATA_DIR ou monte um volume que pertenca ao uid 1000.',
    );
  }
}
