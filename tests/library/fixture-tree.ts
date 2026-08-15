import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Arvore de fixtures do scanner, montada em disco na hora do teste.
 *
 * Ficava versionada como 60 arquivos .mp4 de zero byte. Num repositorio publico
 * de um app de desenhos, uma pasta cheia de "Pica-Pau Ep 01.mp4" parece acervo
 * commitado por engano, mesmo estando vazia. Gerar aqui resolve a leitura e nao
 * enfraquece nada: o scanner continua sendo testado contra filesystem de
 * verdade, com os mesmos nomes, acentos, symlinks e armadilhas.
 */

/** Arquivos vazios. O scanner olha nome e extensao, nunca o conteudo. */
const FILES = [
  "empty-show/Com Video/Com Video Ep 01.mp4",
  "empty-show/Sem Video/leiame.txt",
  "ext/Serie/a.mp4",
  "ext/Serie/b.mkv",
  "ext/Serie/c.webm",
  "ext/Serie/d.m4v",
  "ext/Serie/e.avi",
  "flat/Pica-Pau/Pica-Pau Ep 01.mp4",
  "flat/Pica-Pau/Pica-Pau Ep 02.mp4",
  "ignored/.oculta/Lixo Ep 02.mp4",
  "ignored/@eaDir/Lixo Ep 01.mp4",
  "ignored/Serie/#recycle/Serie Ep 97.mp4",
  "ignored/Serie/.AppleDouble/Serie Ep 98.mp4",
  "ignored/Serie/.oculto.mp4",
  "ignored/Serie/@eaDir/Serie Ep 99.mp4",
  "ignored/Serie/Serie Ep 01.mp4",
  "ignored/Serie/capa.jpg",
  "ignored/Serie/notas.txt",
  // Temporada SOLTA na raiz, irma da pasta da serie: o titulo so existe no
  // nome dos arquivos. Sem derivacao, viraria um segundo canal "Temporada 37".
  "loose/Temporada 37/The.Simpsons.S37E01.1080p.DSNP.WEB-DL-DUAL.mkv",
  "loose/Temporada 37/The.Simpsons.S37E02.1080p.DSNP.WEB-DL-DUAL.mkv",
  "loose/The Simpsons/The.Simpsons.S36E01.mkv",
  "loose/The Simpsons/The.Simpsons.S36E02.mkv",
  // Temporada solta cujos arquivos nao carregam serie nenhuma: nao ha de onde
  // derivar titulo, e a pasta continua canal proprio (comportamento antigo).
  "loose-orfa/S05/01.mp4",
  "many/Serie 1/Serie 1 Ep 01.mp4",
  "many/Serie 10/Serie 10 Ep 01.mp4",
  "many/Serie 11/Serie 11 Ep 01.mp4",
  "many/Serie 12/Serie 12 Ep 01.mp4",
  "many/Serie 2/Serie 2 Ep 01.mp4",
  "many/Serie 3/Serie 3 Ep 01.mp4",
  "many/Serie 4/Serie 4 Ep 01.mp4",
  "many/Serie 5/Serie 5 Ep 01.mp4",
  "many/Serie 6/Serie 6 Ep 01.mp4",
  "many/Serie 7/Serie 7 Ep 01.mp4",
  "many/Serie 8/Serie 8 Ep 01.mp4",
  "many/Serie 9/Serie 9 Ep 01.mp4",
  "mixed/He-Man/He-Man Especial.mp4",
  "mixed/He-Man/Temporada 10/He-Man S10E01.mp4",
  "mixed/He-Man/Temporada 2/He-Man S02E01.mp4",
  "naming/Formatos/Formatos - 04 - Titulo.mp4",
  "naming/Formatos/Formatos 1x03.mp4",
  "naming/Formatos/Formatos Ep 05.mp4",
  "naming/Formatos/Formatos S01E02.mp4",
  "naming/Formatos/Formatos [06].mp4",
  "naming/Formatos/Formatos sem numero.mp4",
  "natural/Ursinhos/Ursinhos EP1.mp4",
  "natural/Ursinhos/Ursinhos ep10.mp4",
  "natural/Ursinhos/Ursinhos ep2.mp4",
  "outside/Fora Ep 99.mp4",
  // Prefixo em comum, series diferentes: nunca podem virar um canal so.
  "prefixo/The.Office.UK.S01.720p.WEBRip/The.Office.UK.S01E01.mkv",
  "prefixo/The.Office.US.S03.720p.WEBRip/The.Office.US.S03E01.mkv",
  "prefixo/The.Office.US.S04.720p.WEBRip/The.Office.US.S04E01.mkv",
  // Acervo de release: a mesma serie espalhada em uma pasta por temporada, com
  // o cabecalho de release inteiro no nome. Sem agrupar, viram quatro canais.
  "release/Rick.and.Morty.S01.1080p.HMAX.WEB-DL.DD2.0.x264-DUAL-SiGLA/Rick.and.Morty.S01E01.mkv",
  "release/Rick.and.Morty.S01.1080p.HMAX.WEB-DL.DD2.0.x264-DUAL-SiGLA/Rick.and.Morty.S01E02.mkv",
  "release/Rick.and.Morty.S02.1080p.HMAX.WEB-DL.DD2.0.x264-DUAL-SiGLA/Rick.and.Morty.S02E01.mkv",
  "release/Rick.and.Morty.S03.2160p.NF.WEB-DL.DDP5.1.x265-DUAL-SiGLA/sem numeracao.mkv",
  "release/The.Simpsons.S37.1080p.DSNP.WEB-DL.DDP5.1.H.264-DUAL/The.Simpsons.S37E01.mkv",
  "seasonfolders/Serie/S01/a.mp4",
  "seasonfolders/Serie/Season 3/c.mp4",
  "seasonfolders/Serie/T02/b.mp4",
  "seasonfolders/Serie/temporada 04/d.mp4",
  "seasons/Thundercats/Extras/Making Of.mp4",
  "seasons/Thundercats/Temporada 1/Thundercats S01E01.mp4",
  "seasons/Thundercats/Temporada 1/Thundercats S01E02.mp4",
  "seasons/Thundercats/Temporada 2/Bonus/Bastidores.mp4",
  "seasons/Thundercats/Temporada 2/Thundercats S02E01.mp4",
  "showsort/Serie 10/Serie 10 Ep 01.mp4",
  "showsort/Serie 2/Serie 2 Ep 01.mp4",
  "slug/As Aventuras do Barão/Barão Ep 01.mp4",
  "slug/Ação & Aventura!/Ação Ep 01.mp4",
  "slug/ドラえもん/Ep 01.mp4",
  "symlink/Serie/Serie Ep 01.mp4",
  "symlink/Serie/Serie Ep 02.mp4",
  "symlink/Serie/Temporada 1/Serie S01E03.mp4",
];

/** Symlinks, incluindo os que apontam para fora da raiz e o auto-referente. */
const LINKS: [link: string, target: string][] = [
  ["symlink/Serie/Temporada 2", "Temporada 1"],
  ["symlink/Serie/link-dentro.mp4", "Serie Ep 02.mp4"],
  ["symlink/Serie/link-fora.mp4", "../../outside/Fora Ep 99.mp4"],
  ["symlink/Serie/loop", "."],
  ["symlink/Serie/pasta-fora", "../../outside"],
];

/** Monta a arvore num diretorio temporario e devolve a raiz. */
export async function buildFixtureTree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "widetv-fixtures-"));

  for (const relative of FILES) {
    const target = join(root, relative);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, "");
  }

  // Depois dos arquivos: parte dos links aponta para eles.
  for (const [relative, target] of LINKS) {
    await symlink(target, join(root, relative));
  }

  return root;
}

export async function removeFixtureTree(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}
