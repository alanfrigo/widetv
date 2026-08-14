/**
 * Gera o hash da senha unica de acesso.
 *
 *   npm run hash-password                        # pergunta no terminal, sem eco
 *   echo 'minha-senha' | npm run hash-password   # tubo, para script
 *
 * O hash vai para stdout e nada mais: da para redirecionar sem sujeira.
 * Prompts, avisos e a linha pronta para o .env vao para stderr.
 */
import { hashPassword } from '../auth/password.js';

const MIN_LENGTH = 8;

// Teclas de controle no modo raw.
const CTRL_C = String.fromCharCode(3);
const CTRL_D = String.fromCharCode(4);
const BACKSPACE = String.fromCharCode(127);

function usage(): void {
  process.stderr.write(
    [
      'Uso: npm run hash-password',
      '',
      '  Le a senha do terminal (sem eco) ou de stdin quando houver tubo.',
      '  Imprime em stdout o hash para colar em AUTH_PASSWORD_HASH.',
      '',
    ].join('\n'),
  );
}

/** Le uma linha de stdin quando a entrada e um tubo ou arquivo. */
async function readPiped(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  const firstLine = text.split('\n', 1)[0] ?? '';
  return firstLine.replace(/\r$/, '');
}

/** Le do terminal em modo raw, sem imprimir o que foi digitado. */
function readSecret(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    // Modo raw antes do prompt: se o terminal ecoar antes de desligarmos o eco,
    // a senha aparece na tela.
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    process.stderr.write(prompt);

    let buffer = '';
    const finish = (fn: () => void): void => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write('\n');
      fn();
    };
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '\n' || ch === '\r' || ch === CTRL_D) {
          finish(() => resolve(buffer));
          return;
        }
        if (ch === CTRL_C) {
          finish(() => reject(new Error('cancelado')));
          return;
        }
        if (ch === BACKSPACE || ch === '\b') {
          buffer = buffer.slice(0, -1);
          continue;
        }
        // Ignora os demais caracteres de controle; aceita acento e emoji.
        if (ch >= ' ') buffer += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function main(): Promise<number> {
  if (process.argv.slice(2).some((arg) => arg === '-h' || arg === '--help')) {
    usage();
    return 0;
  }

  const interactive = process.stdin.isTTY === true;
  const password = interactive ? await readSecret('Senha: ') : await readPiped();

  if (password.length === 0) {
    process.stderr.write('Senha vazia. Nada foi gerado.\n');
    return 1;
  }
  if (interactive) {
    const confirmation = await readSecret('Confirme a senha: ');
    if (confirmation !== password) {
      process.stderr.write('As senhas nao conferem. Nada foi gerado.\n');
      return 1;
    }
  }
  if (password.length < MIN_LENGTH) {
    process.stderr.write(
      `Aviso: senha com ${password.length} caracteres, o minimo recomendado e ${MIN_LENGTH}.\n`,
    );
  }

  const hash = await hashPassword(password);
  process.stdout.write(`${hash}\n`);
  process.stderr.write(
    [
      '',
      'Cole no .env. As aspas simples sao obrigatorias: o hash contem "$" e o',
      'docker compose tentaria expandir cada um como variavel.',
      '',
      `AUTH_PASSWORD_HASH='${hash}'`,
      '',
    ].join('\n'),
  );
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
