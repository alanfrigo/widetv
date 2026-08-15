import { accessSync, constants, statSync } from 'node:fs';

/**
 * Checagem de boot da raiz da biblioteca.
 *
 * O scan ja falha com mensagem boa quando a raiz nao presta, mas ele e
 * assincrono e condicional (AUTO_SCAN=false fica em silencio ate alguem rodar
 * na mao). Num NAS o defeito tipico e o dataset montado sem leitura para o uid
 * do container, e a pessoa so olha o log UMA vez, logo depois do deploy - o
 * aviso precisa estar la nesse momento, nao no proximo rescan da madrugada.
 *
 * Aviso, e nao erro fatal: derrubar o processo aqui poria o container em
 * restart-loop, e a UI de apps do NAS esconde o log de um container que nao
 * fica de pe. Servidor no ar + aviso no log e o estado que se conserta.
 */
export function libraryRootWarning(root: string): string | null {
  const uid = process.getuid?.();
  const quem = uid === undefined ? 'o usuario do container' : `o usuario do container (uid ${uid})`;

  let stats;
  try {
    stats = statSync(root);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      return (
        `sem permissao para ler LIBRARY_ROOT (${root}): a biblioteca precisa de ` +
        `leitura para ${quem}. No TrueNAS, ajuste a ACL do dataset.`
      );
    }
    return (
      `LIBRARY_ROOT (${root}) nao existe: confira o caminho e se o volume da ` +
      'biblioteca esta montado no container.'
    );
  }

  if (!stats.isDirectory()) {
    return `LIBRARY_ROOT (${root}) nao e um diretorio.`;
  }

  try {
    // R_OK: listar as pastas das series. X_OK: entrar nelas.
    accessSync(root, constants.R_OK | constants.X_OK);
  } catch {
    return (
      `sem permissao para ler LIBRARY_ROOT (${root}): a biblioteca precisa de ` +
      `leitura para ${quem}. No TrueNAS, ajuste a ACL do dataset.`
    );
  }

  return null;
}
