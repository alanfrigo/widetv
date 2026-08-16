/**
 * Orcamento de disco das copias geradas (remux e variantes de dublagem).
 *
 * O remux nao transcodifica video: ele COPIA o arquivo inteiro para trocar o
 * container. Isso significa que cada episodio convertido custa praticamente o
 * tamanho do original em DATA_DIR, e cada variante de dublagem custa outro
 * tanto. Sem teto, um acervo de 168 GB pede 168 GB de copias - mais, com
 * dublagens. Este modulo decide o que sai quando o total passa do orcamento.
 *
 * Puro de proposito: nao le disco, nao apaga nada, nao conhece o Store. Quem
 * executa o plano e `cache-evictor.ts`. A separacao e a mesma de
 * `remux-plan.ts` (decide) x `remux-job.ts` (executa), e serve ao mesmo fim -
 * a regra de negocio fica testavel sem ffmpeg, sem SQLite e sem arquivos.
 */

export interface CacheEntry {
  /**
   * Identificador estavel da LINHA, nao do arquivo: o executor usa isto para
   * saber qual registro apagar. Para o remux principal e o id do episodio;
   * para uma variante, o par episodio+faixa.
   */
  key: string;
  /** Nome do arquivo em `<DATA_DIR>/remux`, ex. "ab12...ef.mp4". */
  file: string;
  bytes: number;
  /** Epoch ms do ultimo uso. E o criterio de evicção - veja `planEvictions`. */
  lastAccessAt: number;
}

/**
 * Bytes que nao entram na soma, para uma linha com tamanho ilegivel nao
 * envenenar a comparacao: `NaN > cap` e sempre `false`, entao um unico registro
 * corrompido desligaria a evicção inteira e o cache voltaria a crescer sem
 * limite - exatamente a falha que este modulo existe para evitar.
 */
function usableBytes(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * O que apagar para o total voltar ao orcamento.
 *
 * Criterio: menos-recentemente-USADO, e nao mais-antigo-em-disco. A diferenca
 * importa porque o canal linear reproduz um episodio por vez durante horas - a
 * copia mais antiga do diretorio pode ser justamente a que esta tocando agora.
 *
 * `pinned` e uma garantia dura, nao uma preferencia: uma evicção no meio de uma
 * reproducao faz o `stat()` da proxima requisicao Range falhar, a cadeia de
 * candidatos da rota de stream cai no arquivo original, e o navegador que nao
 * demuxa MKV morre no meio do episodio. Por isso o que esta tocando (e o
 * proximo, ja em preload) nunca entra no plano.
 *
 * Consequencia deliberada: se o conjunto pinado sozinho estourar o orcamento,
 * a funcao evicta tudo o que pode e PARA acima do teto. Ficar acima do
 * orcamento por alguns minutos e melhor que derrubar quem esta assistindo, e o
 * excedente sai sozinho na proxima rodada, quando os pins expirarem.
 *
 * @returns entradas a remover, da mais fria para a mais quente. Lista vazia
 *          quando o cache ja cabe.
 */
export function planEvictions(
  entries: readonly CacheEntry[],
  capBytes: number,
  pinned: ReadonlySet<string>,
): CacheEntry[] {
  const cap = Math.max(0, capBytes);

  let total = 0;
  for (const item of entries) total += usableBytes(item.bytes);
  if (total <= cap) return [];

  // Copia antes de ordenar: o chamador costuma passar direto o resultado de uma
  // consulta e nao espera que ela mude de ordem.
  //
  // Desempate pela chave para o plano ser deterministico: sem ele, duas linhas
  // com o mesmo carimbo (comum, porque o touch e arredondado) sairiam em ordem
  // arbitraria e o teste de um lote inteiro ficaria instavel.
  const coldestFirst = [...entries].sort(
    (a, b) => a.lastAccessAt - b.lastAccessAt || a.key.localeCompare(b.key),
  );

  const evictions: CacheEntry[] = [];
  for (const item of coldestFirst) {
    if (total <= cap) break;
    if (pinned.has(item.key)) continue;
    evictions.push(item);
    total -= usableBytes(item.bytes);
  }

  return evictions;
}
