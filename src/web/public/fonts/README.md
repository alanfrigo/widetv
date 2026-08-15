# Fontes auto-hospedadas

Esta pasta e o `publicDir` do vite (veja `vite.config.ts`), servida como
`/fonts/` no app. **Nada de CDN**: o app tem que subir numa maquina sem
internet de saida, entao nenhum `<link>` para Google Fonts, nenhum `@import`
remoto. Se um dia entrar arquivo de fonte, ele mora aqui, versionado junto com
o codigo.

## Hoje esta vazia de proposito

O app usa a fonte do sistema, declarada uma unica vez em `--font`, no
`app.css`:

```css
--font: system-ui, -apple-system, 'Segoe UI', Roboto, 'Inter', 'Helvetica Neue',
  Arial, sans-serif;
```

Isso resolve o mesmo problema sem baixar nada: cada sistema entrega a fonte de
interface que ja tem instalada (San Francisco no macOS e iOS, Segoe UI no
Windows, Roboto no Android e na maioria das TVs), e a pagina nao espera nenhum
byte extra para desenhar o primeiro texto.

## Para trocar por uma fonte propria

1. Ponha o `.woff2` nesta pasta (e o `OFL.txt`, se a licenca pedir que o texto
   acompanhe a redistribuicao - o app redistribui ao servir o arquivo).
2. Declare o `@font-face` na secao de tokens do `app.css`, apontando para
   `/fonts/<arquivo>.woff2`.
3. Ponha o nome da familia **na frente** de `--font`, sem tirar o resto: a
   lista continua sendo o plano B enquanto o arquivo nao carrega, e o CSS
   inteiro referencia sempre a variavel, nunca o nome da familia.
