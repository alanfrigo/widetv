# App nativo para Google TV

Cliente Android do mesmo servidor: ExoPlayer no lugar do `<video>`, controle
remoto no lugar do teclado. Nada muda no servidor — o app so consome a API
descrita em `docs/CONTRACTS.md`.

## Por que nativo

O navegador da TV funciona, mas exige teclado para a senha toda vez que a sessao
vence, nao entende D-pad e nao guarda o canal. O app resolve os tres.

O nucleo veio pronto do cliente web, que ja era codigo puro e testado:

| Web | Android | Papel |
| --- | --- | --- |
| `src/web/sync.ts` | `player/Sync.kt` | desvio de relogio e correcao de deriva |
| `src/web/tuner.ts` | `tuner/Tuner.kt` | teclas em "va para o canal N" |
| `src/web/osd.ts` | `ui/Osd.kt` | formatacao do display verde |
| `src/shared/api-types.ts` | `net/Models.kt` | contrato HTTP |

Os testes tambem foram portados: `SyncTest`, `TunerTest` e `OsdTest` repetem caso
a caso os arquivos de `tests/web/`. Se um dia os dois clientes discordarem, a
divergencia aparece la e nao na sala.

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
retrotv.defaultServer=https://tv.exemplo.tld
```

Sem `retrotv.defaultServer` o app abre com o campo de endereco vazio e pergunta
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

Para o build de release assinado, veja "Assinatura" abaixo.

## Assinatura

`keystore.properties` na raiz de `android/` (tambem fora do repositorio):

```properties
storeFile=retro-tv.jks
storePassword=...
keyAlias=retro-tv
keyPassword=...
```

```bash
keytool -genkey -v -keystore retro-tv.jks -alias retro-tv \
  -keyalg RSA -keysize 2048 -validity 10000
JAVA_HOME=$(/usr/libexec/java_home -v 17) ./gradlew assembleRelease
```

Sem `keystore.properties` o release ainda compila, assinado com a chave de debug.

## Emulador

O AVD "Television" do Android Studio serve para tudo menos medir decodificacao:
ele decodifica AV1 por software, e o acervo e 100% AV1.

```bash
$ANDROID_HOME/emulator/emulator -avd Television_4K &
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.retrotv.app/.MainActivity
```

## AV1: o unico risco tecnico

O acervo inteiro (14 mil arquivos) e AV1 em resolucao SD. Antes de culpar o app
por tela preta, confira se o aparelho tem decoder:

```bash
adb shell "cat /vendor/etc/media_codecs*.xml | grep -i av01"
```

- Achou (`c2.android.av1.decoder`, `c2.android.av1-dav1d.decoder` ou um do
  fabricante): nada a fazer. SD decodifica folgado ate por software.
- Nao achou: e preciso embutir o decoder do Media3, que **nao** e publicado no
  Maven — clonar `androidx/media`, compilar `dav1d` com o NDK (`build_dav1d.sh`)
  e ligar `EXTENSION_RENDERER_MODE_ON` no `DefaultRenderersFactory`. Caro; so se
  a medicao exigir.

## Controle remoto

| Tecla | Efeito |
| --- | --- |
| ↑ / ↓ | canal anterior / proximo. Segurar acelera: 1, depois 5, depois 20 canais por passo |
| 0-9 | sintonia direta, como controle antigo. Espera 1,2s ou completa a largura do maior canal |
| ← / → | volume |
| Mudo / M | corta o som |
| Play/Pause | ignorado de proposito: a grade nao tem pausa |

Segurar a seta nao sintoniza canal por canal — move um alvo no OSD e so sintoniza
quando a mao solta. Sem isso, atravessar 460 canais viraria centenas de requests.

## Fonte

O OSD usa `monospace` do sistema. Para a fonte pixel do cliente web, coloque o
arquivo em `app/src/main/res/font/` e troque o `android:fontFamily` em
`res/layout/activity_main.xml`. O repositorio nao versiona binario de fonte, pela
mesma razao do web (veja `src/web/public/fonts/README.md`).
