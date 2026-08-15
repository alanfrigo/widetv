# WideTV — app nativo para Google TV

Cliente Android do mesmo servidor: ExoPlayer no lugar do `<video>`, controle
remoto no lugar do teclado. Nada muda no servidor — o app so consome a API
descrita em `docs/CONTRACTS.md`.

## Por que nativo

O navegador da TV funciona, mas exige teclado para a senha toda vez que a sessao
vence, nao entende D-pad e nao guarda o canal. O app resolve os tres.

Sem Leanback e sem Compose: Views com ViewBinding, uma Activity so, cinco telas
trocadas por visibilidade. O acervo cabe numa grade e o player numa tecla — nao
ha o que uma biblioteca de navegacao resolveria aqui.

## Telas

| Tela | O que e |
| --- | --- |
| Acesso | endereco do servidor e senha. Aparece so quando nao ha sessao valida |
| Acervo | grade de 5 colunas de capas 2:3, com nome e "ano · N EP" |
| Serie | capa grande, sinopse, ASSISTIR AO VIVO / DO INICIO e o catalogo de episodios |
| Player | tela cheia, sem controles desenhados; OSD curto na troca de episodio |
| Trilhas | painel lateral de audio e legenda, aberto com OK durante a reproducao |
| Configuracoes | idioma de audio e legenda, agrupamento de temporadas, remux automatico, horario da varredura diaria; e os botoes de manutencao — procurar arquivos novos, reanalisar tudo, rebuscar capas e sinopses (completando o que falta ou refazendo tudo). Ao lado, o progresso da varredura enquanto ela roda: `1240 de 14320 — The Simpsons` |

O nucleo veio pronto do cliente web, que ja era codigo puro e testado, e ganhou
os reducers das telas novas:

| Arquivo | Papel |
| --- | --- |
| `player/Sync.kt` | desvio de relogio e correcao de deriva (porte de `src/web/sync.ts`) |
| `tuner/Tuner.kt` | teclas em "va para o canal N" (porte de `src/web/tuner.ts`) |
| `ui/Osd.kt` | linha da pilula e selo de resolucao |
| `ui/Catalog.kt` | texto do acervo e da serie; reducao da capa |
| `ui/Nav.kt` | para onde cada tecla leva entre as cinco telas |
| `ui/TrackPanel.kt` | cursor e marcacao do painel de audio/legenda |
| `ui/Settings.kt` | cursor e valor de cada linha das configuracoes, e o texto do estado da biblioteca (porte de `src/web/settings.ts`) |
| `net/Models.kt` | contrato HTTP (espelho de `src/shared/api-types.ts`) |

Todos sao funcoes puras e todos tem teste JVM. Nao ha teste instrumentado: o que
sobra na `MainActivity` e cola de View, que um emulador verificaria pior do que
uma pessoa olhando a tela.

## Controle remoto

No acervo e na tela de serie, quem anda e o foco nativo do Android (setas e OK).
As teclas abaixo sao as do player:

| Tecla | Efeito |
| --- | --- |
| OK / ENTER / MENU | abre o painel de trilhas |
| ↑ / ↓ | ao vivo: canal anterior / proximo. Segurar acelera: 1, 5, depois 20 canais por passo |
| 0-9 | ao vivo: sintonia direta. Espera 1,2s ou completa a largura do maior canal |
| ← / → | sob demanda: -10s / +10s |
| Play/Pause | sob demanda: pausa. Ao vivo a tecla morre — a grade nao tem pausa |
| VOLTAR | volta para a tela da serie |

No painel de trilhas: ↑/↓ escolhe (cabecalhos sao pulados), OK aplica sem
fechar, VOLTAR fecha. O volume fica com as teclas de volume do proprio aparelho.

Segurar a seta nao sintoniza canal por canal — move um alvo no OSD e so sintoniza
quando a mao solta. Sem isso, atravessar 460 canais viraria centenas de requests.

### Configuracoes

Chega-se la pelo botao CONFIGURACOES no cabecalho do acervo: uma seta para
**cima** a partir da primeira fileira de capas. E de proposito o caminho mais
chato possivel — o foco nasce num card e desce dali, entao quem so quer assistir
nunca esbarra no botao, e quem quer configurar precisa de uma tecla so. O MENU do
player continua abrindo o painel de trilhas: sequestra-lo trocaria uma coisa que
se usa toda noite por uma que se usa uma vez por mes.

| Tecla | Efeito |
| --- | --- |
| ↑ / ↓ | escolhe a LINHA. A linha do provedor de capas e pulada: ela so informa |
| ← / → | muda o VALOR da linha: idioma anterior/proximo, horario -30/+30 min, desliga/liga |
| OK | em acao dispara; em chave alterna; em idioma e horario avanca um valor |
| VOLTAR | volta ao acervo |

O cursor e do reducer, e nao do foco do Android — mesma razao do painel de
trilhas: com foco nativo, as setas laterais seriam disputadas com o RecyclerView.

Enquanto uma varredura ou uma busca de capas roda, a tela pergunta o estado de
2 em 2 segundos. O loop morre quando as duas param, ao sair da tela e no
`onStop`: um polling vivo com a tela fechada bate na API para sempre.

## Audio e legenda

O ExoPlayer le MKV com varios audios (E-AC-3) e legendas SubRip embutidas
nativamente: **a decodificacao e a escolha da faixa nao passam pelo servidor**.
O painel lista os grupos de `player.currentTracks` e a selecao acontece em duas
camadas:

- **agora**: `TrackSelectionOverride` no grupo escolhido, que resolve o caso de
  duas faixas dividirem a mesma tag de idioma;
- **daqui em diante**: `setPreferredAudioLanguage` / `setPreferredTextLanguage`.
  O override morre junto com o episodio (ele aponta para um `TrackGroup`
  concreto); o idioma atravessa a maratona e os reinicios do app.

O que mudou e de quem e a PREFERENCIA de idioma: ela mora no servidor
(`AppSettings.audioLang` / `subtitleLang`), porque a casa toda usa a mesma senha
e escolher "audio em portugues" na TV da sala tem que valer no tablet. O `Store`
virou CACHE dela: e o que faz o primeiro episodio abrir com a trilha certa antes
de `GET /api/settings` responder, e o que segura a escolha com a rota fora do ar
— por isso uma falha ali nunca segura a entrada no acervo. Escolher no painel
continua valendo na hora e ainda manda um PATCH sem esperar resposta: falhar
nele nao pode atrapalhar quem esta assistindo.

Legenda desligada e `setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)`, e e o estado
de fabrica: numa TV de sala, legenda que aparece sem ninguem ter pedido incomoda
mais do que legenda que falta. A semantica bate com a do contrato — `subtitleLang:
null` e "desativadas" nos dois lados —, e e por isso que o cache do `Store` pode
ser semeado com o valor do servidor sem traducao nenhuma.

`subtitlesAuto` da para editar aqui porque a preferencia e da casa, mas quem a
obedece hoje e o cliente web: no app, legenda so aparece quando ha idioma
preferido gravado.

## Agrupamento e o "ultimo canal"

O servidor junta pastas de release da mesma serie num canal so
(`Rick.and.Morty.S01...` + `S02...` viram "Rick and Morty"). O app so mostra o
que o servidor manda, entao isso chegou de graca — mas ligar ou desligar essa
chave **renumera o acervo** na varredura seguinte.

O numero do ultimo canal ao vivo fica no `Store`, e `readLastChannel` so o
devolve quando ele ainda existe na lista atual; sumindo, devolve null e o foco
pousa no primeiro card. O que nao da para detectar daqui e o numero que
sobreviveu apontando para OUTRA serie: depois de um agrupamento, a primeira
abertura pode pousar o foco na serie errada. E um foco, nao uma reproducao — o
preco de guardar o numero, que e o que o contrato promete estavel entre rescans.

## Capas

Sem biblioteca de imagem. `ui/PosterLoader.kt` baixa pelo MESMO OkHttp da API
(a capa esta atras do guard de sessao — um cliente novo nasceria sem cookie),
reduz com `inSampleSize` para o tamanho do card e guarda num `LruCache` de 48MB.
O `Job` fica no ViewHolder e e cancelado na reciclagem. Sem capa, o card mostra
as iniciais da serie sobre um gradiente.

## Requisitos

- JDK 17. O Gradle 8.11 **nao** roda em JDK 25.
- Android SDK com plataforma 35.

```bash
JAVA_HOME=$(/usr/libexec/java_home -v 17) ./gradlew test
JAVA_HOME=$(/usr/libexec/java_home -v 17) ./gradlew assembleDebug
```

## Configuracao local

`local.properties` nao vai para o repositorio. E la que ficam o caminho do SDK e
o endereco padrao do servidor:

```properties
sdk.dir=/Users/voce/Library/Android/sdk
widetv.defaultServer=https://tv.exemplo.tld
```

Sem `widetv.defaultServer` o app abre com o campo de endereco vazio e pergunta
na primeira vez — que e o comportamento certo para quem clonar isto sem ser o
dono do servidor. O endereco tambem pode ser trocado na propria tela de acesso,
sem recompilar: util para apontar para o IP da LAN e pular o proxy quando a TV
esta em casa.

## Instalar na TV

1. Na Google TV: Ajustes > Sistema > Sobre > toque 7 vezes em "Versao do Android"
   para liberar o modo desenvolvedor; depois Ajustes > Sistema > Desenvolvedor >
   Depuracao por rede (anote o IP e a porta).
2. No computador:

```bash
adb connect <ip-da-tv>:5555
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Aceite o pedido de autorizacao que aparece na TV.

## Assinatura

`keystore.properties` na raiz de `android/` (tambem fora do repositorio):

```properties
storeFile=widetv.jks
storePassword=...
keyAlias=widetv
keyPassword=...
```

```bash
keytool -genkey -v -keystore widetv.jks -alias widetv \
  -keyalg RSA -keysize 2048 -validity 10000
JAVA_HOME=$(/usr/libexec/java_home -v 17) ./gradlew assembleRelease
```

Sem `keystore.properties` o release ainda compila, assinado com a chave de debug.

## Emulador

O AVD "Television" do Android Studio serve para tudo menos medir decodificacao:
ele decodifica AV1 por software.

```bash
$ANDROID_HOME/emulator/emulator -avd Television_4K &
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.widetv.app/.MainActivity
```

## Codec: o unico risco tecnico

Acervo em AV1 depende de decoder no aparelho. Antes de culpar o app por tela
preta, confira:

```bash
adb shell "cat /vendor/etc/media_codecs*.xml | grep -i av01"
```

- Achou (`c2.android.av1.decoder`, `c2.android.av1-dav1d.decoder` ou um do
  fabricante): nada a fazer. SD decodifica folgado ate por software.
- Nao achou: e preciso embutir o decoder do Media3, que **nao** e publicado no
  Maven — clonar `androidx/media`, compilar `dav1d` com o NDK (`build_dav1d.sh`)
  e ligar `EXTENSION_RENDERER_MODE_ON` no `DefaultRenderersFactory`. Caro; so se
  a medicao exigir.

## Fonte

Sans-serif do sistema (Roboto), sem binario de fonte no repositorio — mesma
razao do web (veja `src/web/public/fonts/README.md`). O banner da Google TV e um
`VectorDrawable` pelo mesmo motivo.
