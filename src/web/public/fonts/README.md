# Fontes auto-hospedadas

Esta pasta e o `publicDir` do vite (veja `vite.config.ts`), servida como
`/fonts/` no app. **Nada de CDN**: o app tem que subir numa maquina sem
internet de saida, entao nenhum `<link>` para Google Fonts, nenhum `@import`
remoto. Todo arquivo de fonte mora aqui, versionado junto com o codigo.

## O que esta aqui

**Manrope**, a familia do redesign (veja `docs/redesign-spec.md` §1). Sao seis
arquivos, um por subset Unicode, todos **variaveis** no eixo de peso
(`font-weight: 400 800` num `@font-face` so por subset):

| Arquivo | Subset |
|---|---|
| `manrope-latin.woff2` | latin |
| `manrope-latin-ext.woff2` | latin-ext |
| `manrope-cyrillic.woff2` | cyrillic |
| `manrope-cyrillic-ext.woff2` | cyrillic-ext |
| `manrope-greek.woff2` | greek |
| `manrope-vietnamese.woff2` | vietnamese |

Os subsets nao-latinos existem porque o painel de trilhas mostra o **nome do
idioma na propria lingua** (`Ελληνικά`, `Русский`, `Tiếng Việt`), e sem eles
essas linhas cairiam na fonte do sistema no meio de uma lista. O que Manrope nao
cobre (CJK, arabe, hebraico, tailandes, devanagari) continua caindo no fallback
do sistema, que e o certo: nenhuma familia latina tem esses glifos.

Licenca: `OFL.txt`, redistribuida junto porque o app serve os arquivos.

## Como o CSS usa

Seis `@font-face` na secao de tokens do `app.css`, cada um com o `unicode-range`
do seu subset e `font-display: swap`, apontando para `/fonts/<arquivo>.woff2`. A
familia entra **na frente** de `--font`, sem tirar o resto: a lista do sistema
continua sendo o plano B enquanto o arquivo nao carrega.

## Para atualizar a fonte

Os `unicode-range` de cada subset saem da propria folha do Google Fonts:

```sh
curl -s -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) \
AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36" \
  "https://fonts.googleapis.com/css2?family=Manrope:wght@400..800&display=swap"
```

Baixe os `.woff2` de la, renomeie para o padrao acima e confira que os
`unicode-range` no `app.css` continuam batendo. O app Android tem a mesma
familia em `android/app/src/main/res/font/`, mas em TTF estatico (um arquivo por
peso): `minSdk 23` nao suporta fonte variavel.
