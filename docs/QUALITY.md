# Validação de performance e estabilidade

Comparação com `8e09606`, em 23/09/2026. Dados sintéticos; nenhuma publicação ou alteração do acervo real.

## Resultado

- Android TV: abrir uma temporada de 500 episódios passou de **1.522 ms para 109 ms** na mediana (aproximadamente **93% menos tempo**). A lista mantém **8 linhas**, em vez de 500, e ainda permite chegar ao último episódio pelo foco.
- No mesmo cenário Android, o heap mediano caiu de **25,1 MB para 7,4 MB**; o PSS, de aproximadamente **190,6 MB para 92,3 MB**. Ao longo das dez idas e voltas, não houve crescimento contínuo do heap após GC.
- Web: dez atualizações de progresso passaram de **5.000 cards removidos/recriados para zero**. Foco, imagens e rolagem são preservados. Heap após o ciclo: aproximadamente 4,79 MB antes e 4,78 MB depois.
- Servidor: a grade de 500 séries elimina **501 consultas redundantes** de identificação, mantendo o cache de episódios. Mediana de `/api/now`: **2,51 ms → 2,00 ms**, aproximadamente **20% menor**.

## Medições

Valores apresentados como **mediana / p95**. Navegação web inclui a interação e a rolagem da interface, não apenas o tempo de JavaScript.

| Cenário | Antes | Depois |
| --- | ---: | ---: |
| Catálogo web | 140.0 / 219.5 ms | 126.9 / 142.7 ms |
| Busca web | 17.1 / 34.9 ms | 15.9 / 26.6 ms |
| Navegação web (ida e volta) | 1310.4 / 1315.2 ms | 1268.2 / 1292.8 ms |
| Primeiro quadro web | 54.7 / 204.5 ms | 59.8 / 191.4 ms |
| Troca de canal web | 40.9 / 54.0 ms | 51.3 / 62.0 ms |
| API catálogo | 2.99 / 3.74 ms | 2.98 / 4.10 ms |
| API grade | 2.51 / 4.03 ms | 2.00 / 3.50 ms |
| API episódios | 0.16 / 0.21 ms | 0.15 / 0.17 ms |
| Catálogo Android | 722.2 / 894.6 ms | 600.2 / 739.0 ms |
| Temporada com 500 episódios (Android) | 1521.9 / 2610.0 ms | 109.3 / 195.0 ms |
| Troca de canal web aquecida (50 trocas) | 44.4 / 58.2 ms | 45.5 / 51.4 ms |

A amostra inicial de sete trocas de canal variou cerca de 10 ms. Uma verificação adicional de **50 trocas consecutivas**, medida pelo quadro entregue ao navegador, encontrou mediana de **44,4 → 45,5 ms** e p95 de **58,2 → 51,4 ms**. Não houve regressão sustentada superior a 10% nessa verificação. Nenhum frame de vídeo perdido ou tarefa longa foi registrado no cenário web medido.

Os valores não são um SLA: API foi medida com Fastify.inject e SQLite em memória; browser com respostas locais controladas; Android em emulador. Não medem rede doméstica, NAS, transcodificação de arquivos reais, hardware de TV ou uso por muitas horas. A validação de decodificação e fluidez numa TV física permanece necessária antes de extrapolar esses resultados.

## Bugs e proteções verificadas

- Respostas de uma série/sintonia anterior não substituem a seleção atual, incluindo o primeiro HEAD e a espera por metadados.
- Cancelar uma tela cancela a chamada OkHttp e a leitura do corpo. Cancelamento não vira um estado falso de erro de rede.
- Timeout da web também cobre corpo incompleto, com distinção entre cancelamento e prazo esgotado.
- Listeners de metadados são removidos; tentativas antigas de autoplay não silenciam a reprodução seguinte.
- Imagens respeitam origem, versão e tamanho; pedidos iguais compartilham o download, com no máximo quatro operações simultâneas. Cancelar um leitor não interrompe outro que ainda precisa da imagem.
- Preferências são enviadas em sequência, evitando gravações fora da ordem dos comandos.
- Catálogo conserva dados durante falha transitória; erros recuperáveis oferecem nova tentativa. Polling da web para quando a página fica oculta e retoma ao voltar.
- Android TV: temporada selecionada usa texto escuro sobre o destaque âmbar; o episódio com foco recebe borda de destaque, facilitando a navegação pelo controle remoto.
- Maratona não grava o relógio do episódio anterior no próximo episódio em preparação. O teste, aplicado à versão original, produziu **duas gravações indevidas**; na versão corrigida, nenhuma.
- Reprodução com MP4 real, envio de progresso, avanço automático, busca, sessão expirada, foco e temporada longa foram exercitados no navegador. A mídia de teste inclui respostas HTTP Range para permitir seeks reais.

## Verificações

- TypeScript e build completo: aprovados.
- Vitest: **1.411 testes aprovados**; benchmark de tempo opt-in separado.
- Playwright: **12 testes funcionais aprovados**; os dois benchmarks opt-in foram executados separadamente.
- Android: **349 testes JVM aprovados**, lint e APK debug aprovados.
- Android TV API 34: **5 testes instrumentados funcionais aprovados**; benchmark separado com cinco aberturas e dez ciclos por abertura.
- CI agora verifica web e Android, incluindo emulador de TV, antes de publicar a imagem. A execução remota da nova configuração ainda depende do push/PR.

## Reprodução local

Use Node 22, FFmpeg, JDK 17 e SDK Android com plataforma 35. Os testes instrumentados precisam de um emulador Android TV conectado. O ambiente desta medição foi macOS arm64, Node 22.23.2, Android TV API 34 arm64 e ADB 35.0.2.

```sh
npm ci
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:media
npm run test:perf
cd android
./gradlew testDebugUnitTest lintDebug assembleDebug connectedDebugAndroidTest
./gradlew connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.widetv.app.ExperienceTest#performanceComparison -Pandroid.testInstrumentationRunnerArguments.benchmark=true
```

`test:media` gera um clipe curto em um diretório temporário. `test:perf` registra sete execuções do cenário web e cinquenta trocas de canal; `WIDETV_TEST_URL` permite comparar outro checkout e `WIDETV_PERF_OUTPUT` guarda o JSON. Para a API, execute `WIDETV_PERF_ENDPOINT_OUTPUT=/tmp/api.json npx vitest run tests/channels/catalog-cost.test.ts -t 'benchmark endpoints'`. O benchmark Android registra amostras na tag `WideTVBenchmark` do logcat incluído no relatório de testes.

As amostras desta rodada estão em [performance-results.json](performance-results.json). Não houve mudança de schema, migração de banco ou quebra de contrato HTTP.
