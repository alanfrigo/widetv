# widetv

Servidor pessoal de streaming para o seu proprio acervo.

Aponte para uma pasta de series e ela vira um catalogo widescreen: cada serie
ganha capa buscada automaticamente, sinopse, lista de episodios e as trilhas de
audio e legenda que os arquivos ja carregam. O video sai do disco como esta,
sem transcode.

[English](README.md)

## O que ele faz

- **Catalogo.** Um canal por pasta, com capa, ano e sinopse.
- **Capas automaticas.** Buscadas uma vez por serie no TVMaze, no iTunes ou no
  TMDB, guardadas em disco e servidas por este servidor. Nenhum cliente fala
  com provedor externo.
- **Audio e legenda.** MKV com varios audios mantem todas as faixas; legenda de
  texto embutida vira WebVTT sob demanda, com cache em disco.
- **Modo ao vivo.** Cada serie tambem roda como um canal de 24 horas: uma funcao
  pura do relogio decide o que estaria no ar agora. Nada de posicao de
  reproducao e guardado, entao a grade sobrevive a um restart e duas pessoas no
  mesmo canal veem o mesmo quadro.
- **Sem transcode.** Range HTTP sobre o arquivo original. Isto foi feito para
  rodar num NAS sem GPU.

## Como a grade funciona

```
ciclo    = soma da duracao de todos os episodios
decorrido = (agora - epoca) mod ciclo
```

Cada canal e deslocado por um hash estavel do slug, para que os canais nao
estejam todos no episodio 1 no mesmo instante. O cliente pede a posicao atual,
mede o tempo de ida e volta para estimar o desvio de relogio, busca o ponto e
depois se corrige: abaixo de 300 ms de desvio nao faz nada, ate 2 s ajusta a
velocidade de reproducao, acima disso pula.

## Capas e metadata

O primeiro `GET /api/channels` depois de um scan dispara, em segundo plano, uma
rodada que preenche o que falta. A resposta **nunca** espera a rede: a capa
aparece na proxima carga da tela.

Os provedores sao tentados em ordem, e a cadeia para no primeiro que devolve
imagem:

| Provedor | Chave | Observacao |
| --- | --- | --- |
| TMDB | `TMDB_API_KEY` | So quando a chave existe - e ai vem primeiro: poster de cartaz e sinopse em pt-BR |
| TVMaze | nenhuma | Boa cobertura de series de TV |
| iTunes Search | nenhuma | Fallback; cobre tambem filme |

A imagem e baixada uma vez para `<DATA_DIR>/posters/<showId>.jpg` e servida em
`/api/channels/:number/poster`, atras do mesmo guard de sessao que o resto.
Serie que nenhum provedor conhece fica registrada como tal e so e reconsultada
depois de sete dias. Falha de rede nao grava nada, entao e tentada de novo na
rodada seguinte.

## API

Todas as rotas ficam atras do cookie de sessao.

| Rota | Devolve |
| --- | --- |
| `POST /api/auth/login` | emite o cookie de sessao |
| `GET /api/channels` | `ChannelSummary[]` |
| `GET /api/channels/:number/now` | `NowPlaying` - o que esta no ar agora |
| `GET /api/channels/:number/episodes` | `EpisodeRef[]` na ordem da grade |
| `GET /api/channels/:number/poster` | `image/jpeg`, ou 404 quando nao ha capa |
| `GET /api/stream/:id` | o arquivo, com suporte a Range |
| `GET /api/stream/:id/subtitle/:track` | legenda embutida em WebVTT |

```ts
interface ChannelSummary {
  number: number;
  name: string;
  episodeCount: number;
  posterUrl: string | null;  // '/api/channels/7/poster' quando ha capa
  year: number | null;
  overview: string | null;
}
```

O contrato mora em `src/shared/api-types.ts` e e espelhado em
`android/app/src/main/java/com/retrotv/app/net/Models.kt`.

## Tela de configuracoes

O app web tem uma tela de configuracoes, navegavel inteira por controle remoto
(setas / D-pad, sem precisar de mouse ou teclado), onde a casa pode:

- Disparar uma varredura da biblioteca, `incremental` (reaproveita o probe
  cacheado por data de modificacao e tamanho de cada arquivo - o mesmo que o
  rescan diario faz) ou `full` (reabre todo arquivo, para quando o indice em si
  esta torto).
- Rebuscar capa e sinopse, com a opcao de apagar o que ja esta gravado antes de
  buscar de novo.
- Definir preferencia de idioma de audio e de legenda, e se a legenda liga
  sozinha.
- Ligar ou desligar o agrupamento inteligente (veja abaixo) e o remux
  automatico, e ajustar o horario do rescan diario.

Essas preferencias sao gravadas no servidor, nao no `localStorage` do
navegador: a casa toda usa a mesma senha e as mesmas telas, entao escolher
"audio em portugues" na TV da sala tem que valer no tablet tambem.
Preferencias que tambem existem no `.env` (`SMART_GROUPING`, `AUTO_REMUX`,
`RESCAN_TIME`) usam o valor do ambiente como default - gravar no painel
sobrepoe, e apagar a escolha no painel volta a usar o que estiver no `.env`.

| Rota | Devolve |
| --- | --- |
| `GET /api/settings` | `AppSettings` |
| `PATCH /api/settings` | `AppSettings`; corpo e um `SettingsPatch` parcial - nunca substitui o objeto inteiro, entao dois aparelhos editando ao mesmo tempo nao apagam a escolha um do outro |
| `GET /api/library/status` | `LibraryStatus` - estado de scan/metadata/remux, consultado em intervalo curto enquanto uma tarefa roda |
| `POST /api/library/scan` | 202 assim que a varredura e aceita, nao quando termina (14 mil arquivos levam minutos); 409 se ja ha uma rodando |
| `POST /api/library/metadata` | 202 assim que a busca e aceita, 409 se ja ha uma rodando |

O formato completo de request/response e os codigos de status estao em
[docs/CONTRACTS.md](docs/CONTRACTS.md).

## Layout do acervo

Os dois formatos sao entendidos, e uma mesma serie pode misturar os dois:

```
BIBLIOTECA/
  Nome da Serie/
    episodio 01.mp4
    episodio 02.mp4

  Outra Serie/
    1a Temporada/
      episodio 01.mp4
    2a Temporada/
      episodio 01.mp4
```

Niveis mais fundos tambem funcionam: tudo abaixo de uma pasta de primeiro nivel
e coletado recursivamente e ordenado por natural sort. Pastas de temporada sao
reconhecidas nos formatos que aparecem de verdade (`1a Temporada`,
`Temporada 4`, `Season 5`, `S06`, `T07`, `Terceira Temporada`). Temporada e
numero de episodio sao melhor esforco: quando o nome do arquivo nao da nada
confiavel, os campos ficam null em vez de serem inventados.

Arquivos ocultos, `@eaDir`, `.AppleDouble` e `#recycle` sao ignorados. Serie
cujos arquivos falham todos no probe nao vira canal.

## Agrupamento inteligente

Pastas de release costumam nomear cada temporada separada, por exemplo:

```
Rick.and.Morty.S01.1080p.HMAX.WEB-DL.DD2.0.x264-DUAL-SiGLA/
Rick.and.Morty.S02.1080p.HMAX.WEB-DL.DD2.0.x264-DUAL-SiGLA/
```

**Antes**, sem agrupamento: cada pasta e o proprio canal, entao isso vira dois
canais, os dois com nome de release -
`Rick.and.Morty.S01.1080p.HMAX.WEB-DL.DD2.0.x264-DUAL-SiGLA` e
`Rick.and.Morty.S02.1080p.HMAX.WEB-DL.DD2.0.x264-DUAL-SiGLA` - em vez de uma
serie so.

**Depois**, com `SMART_GROUPING` ligado (o default): pastas da mesma serie sao
juntadas num canal so, "Rick and Morty", com as duas temporadas. Vale para
qualquer serie que siga esse mesmo padrao de nome por temporada, nao so para
este exemplo.

Se o seu acervo ja e uma pasta por serie, o agrupamento nao tem o que fazer -
ligue `SMART_GROUPING=false` e pule essa parte.

**Ligar o agrupamento num acervo ja indexado renomeia series e renumera
canais.** O numero de um canal e atribuido uma unica vez, na primeira vez que
o slug dele aparece, e o slug vem do nome da serie. Quando o agrupamento junta
duas pastas de release numa serie com nome diferente, essa serie ganha um slug
novo e um numero de canal novo; os numeros antigos nao voltam a ser usados. Se
alguem da casa tem um numero de canal decorado, vai precisar decorar de novo
depois de ligar o agrupamento.

## Codecs

Nao ha transcode, entao o cliente precisa decodificar a fonte direto. AV1 em MP4
decodifica em tudo que e atual; H.265 so toca onde o sistema expoe decoder por
hardware. Confira o seu acervo antes de supor:

```bash
npm run survey -- "/caminho/da/biblioteca"
```

O relatorio traz distribuicao de codec e container, quantos arquivos tem o atomo
`moov` na frente e um veredito direto sobre direct play.

## Requisitos

- Node 22 ou mais novo
- `ffmpeg`/`ffprobe` no PATH - indexacao e extracao de legenda
- Um acervo de arquivos de video

## Comeco rapido

```bash
npm install
cp .env.example .env

openssl rand -hex 32        # SESSION_SECRET
npm run hash-password       # AUTH_PASSWORD_HASH
```

A indexacao e o unico passo caro, porque roda `ffprobe` uma vez por arquivo. A
segunda rodada e quase instantanea: o resultado fica em cache por data de
modificacao e tamanho.

```bash
npm run scan -- "/caminho/da/biblioteca"
```

Da para pular: com o indice vazio o servidor indexa sozinho, em segundo plano,
sem atrasar o boot - que e o caminho normal num container. Dentro do container o
scan e o arquivo compilado, ja que o `tsx` nao vai na imagem:

```bash
docker compose exec widetv node dist/server/scan.js /media/biblioteca
```

Depois:

```bash
npm run dev      # Vite na 5173, API na 8080
npm run build && npm start
```

## Configuracao

| Variavel | Significado |
| --- | --- |
| `LIBRARY_ROOT` | Pasta raiz do acervo |
| `DATA_DIR` | Indice SQLite, capas e cache de legenda. Precisa ser gravavel. Nao deixe em branco: em branco vira caminho relativo, que dentro do container e `/app/data`, sem volume e sem permissao de escrita |
| `AUTO_SCAN` | Indexa sozinho quando o indice esta vazio. So a string exata `false` desliga |
| `RESCAN_TIME` | Rescan diario da biblioteca no horario LOCAL (`HH:MM`, padrao `04:00`): adiciona series/episodios novos e remove os apagados. `off` desliga |
| `AUTO_REMUX` | Converte episodios MKV/Dolby para MP4 em segundo plano (copia de bytes, sem transcode). As copias vivem em `DATA_DIR/remux` e ocupam mais ou menos o tamanho dos proprios MKV. So a string exata `false` desliga |
| `SMART_GROUPING` | Junta pastas de release da mesma serie (ex.: `Serie.S01...` + `Serie.S02...`) num canal so - veja [Agrupamento inteligente](#agrupamento-inteligente). Ligado por padrao; so a string exata `false` desliga. O painel de configuracoes pode sobrepor isso em tempo de execucao; apagar essa sobreposicao volta a usar este valor |
| `TMDB_API_KEY` | Opcional. Poe o TMDB na frente da busca de capa, com sinopse em pt-BR. Sem ela, usa TVMaze e iTunes |
| `PORT` | Porta HTTP, padrao 8080 |
| `CHANNEL_EPOCH` | Instante zero da grade ao vivo. Mudar reposiciona todos os canais de uma vez |
| `AUTH_PASSWORD_HASH` | Saida de `npm run hash-password` |
| `SESSION_SECRET` | 32 bytes ou mais de aleatoriedade, assina o cookie de sessao |
| `SECURE_COOKIES` | `false` so para HTTP local. Qualquer outra coisa mantem a flag `Secure` |

O `.env` e lido uma vez, no boot. O `npm run dev` observa o arquivo; um container
de producao precisa de `docker compose up -d --force-recreate`.

`AUTH_PASSWORD_HASH` guarda o HASH, nao a senha. Colar a senha em texto claro ali
faz o servidor recusar o boot - e dizer o motivo.

## Deploy

`docker compose up` sobe com o acervo montado read-only e o indice num volume
nomeado. Veja [docs/DEPLOY.md](docs/DEPLOY.md) para o passo a passo no TrueNAS
SCALE e a configuracao do reverse proxy.

Se expuser isto fora da LAN, ponha HTTPS na frente. Sem TLS a senha e o cookie de
sessao andam em texto claro pela rede; e por isso que o compose publica em
`127.0.0.1` por padrao.

## Seguranca

O acesso e uma senha unica, com hash scrypt e comparacao em tempo constante. O
cookie de sessao e stateless, assinado com HMAC-SHA256, `HttpOnly` e
`SameSite=Lax`, e carrega o proprio instante de emissao dentro da assinatura -
o cliente nao consegue empurrar a expiracao. Erros repetidos de um mesmo
endereco ficam bloqueados por quinze minutos.

Isto e uma tranca de porta, nao uma fortaleza. Serve para um servidor de midia
pessoal atras de um reverse proxy; nao e um sistema de autenticacao multiusuario.

## Layout do projeto

```
src/
  shared/     tipos do contrato HTTP, usados pelo servidor e pelos clientes
  server/
    library/  scanner, wrapper do ffprobe, indice SQLite, job de scan
    schedule/ clock.ts, a funcao pura por tras da grade ao vivo
    channels/ traduz o indice em canais, rotas HTTP
    metadata/ provedores de capa e sinopse, enriquecimento em segundo plano
    stream/   Range, entrega do arquivo, extracao de legenda
    auth/     hash de senha, cookie de sessao, rotas
    cli/      scan, survey, hash-password
  web/        cliente de navegador
```

A logica interessante e proposital e pura, longe do I/O: `clock.ts`, `range.ts`
e os parsers dos provedores nao tocam em filesystem nem em `Date.now()`.

## Testes

```bash
npm test
npm run typecheck
```

## Licenca

Ainda sem arquivo de licenca. Adicione um antes de publicar, se importar como os
outros podem usar isto.
