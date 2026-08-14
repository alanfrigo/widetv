# Fontes auto-hospedadas

Esta pasta e o `publicDir` do vite (veja `vite.config.ts`), servida como
`/fonts/` no app. **Nada de CDN**: o app tem que subir numa maquina sem
internet de saida, entao nenhum `<link>` para Google Fonts, nenhum `@import`
remoto. O arquivo da fonte mora aqui, versionado junto com o codigo.

## O arquivo que falta

O repositorio nao traz binario de fonte. Baixe **um** arquivo e coloque aqui
com exatamente este nome:

```
src/web/public/fonts/PressStart2P-Regular.woff2
```

Fonte recomendada: **Press Start 2P**, de CodeMan38 - pixel font 8-bit,
licenca SIL Open Font License 1.1 (uso comercial e redistribuicao liberados,
basta manter o texto da licenca).

Onde pegar:

- Google Fonts: <https://fonts.google.com/specimen/Press+Start+2P> (botao
  "Get font" -> "Download all"; o zip vem com `PressStart2P-Regular.ttf`)
- Repositorio upstream: <https://github.com/google/fonts/tree/main/ofl/pressstart2p>

Se o download vier em `.ttf`, converta para `woff2` (bem menor, ~1/3 do
tamanho) com o utilitario oficial:

```sh
# macOS
brew install woff2
woff2_compress PressStart2P-Regular.ttf   # gera PressStart2P-Regular.woff2
```

Guarde tambem o `OFL.txt` do pacote nesta pasta: a licenca pede que o texto
acompanhe a fonte quando ela e redistribuida, e o app redistribui ao servir o
arquivo.

## Como o CSS acha o arquivo

O `@font-face` esta em `src/web/crt/tv.css`, com dois `src` de proposito:

```css
@font-face {
  font-family: 'CRT Pixel';
  src:
    url('/fonts/PressStart2P-Regular.woff2') format('woff2'),      /* app servido */
    url('../public/fonts/PressStart2P-Regular.woff2') format('woff2'); /* demo em file:// */
  font-display: swap;
}
```

O browser tenta na ordem e cai para o proximo quando um falha. O primeiro
caminho vale quando o app e servido (vite ou `@fastify/static`); o segundo vale
quando alguem abre `src/web/crt/demo.html` direto do disco, sem servidor.

## Sem o arquivo, nada quebra

`--tv-font-pixel` termina em `'Courier New', ui-monospace, monospace`. Faltando
o `.woff2`, o browser registra um 404 no console e usa a monoespacada do
sistema: a demo abre, a TV desenha, so a tipografia perde o charme de pixel.
E por isso que a ausencia da fonte nao trava o desenvolvimento.

## Trocar por outra fonte

Duas fontes pixel que tambem servem, ambas OFL:

- **VT323**: imita terminal de tubo, tem minusculas melhores para texto corrido.
- **Silkscreen**: mais estreita, boa quando o OSD tem muito texto.

Para trocar, ponha o `.woff2` aqui e ajuste **so** o bloco `@font-face` e a
variavel `--tv-font-pixel` em `src/web/crt/tv.css`. O resto do CSS referencia
sempre a variavel, nunca o nome da familia.
