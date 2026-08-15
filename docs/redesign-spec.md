# WideTV — especificação do redesign (fonte da verdade)

Extraída literalmente de `WideTV Redesign.dc.html` (projeto Claude Design
`52b0b972-6461-476e-bc3c-a912b1fff4b0`). **Todo valor abaixo é do design.** Quando
web e Android divergirem de um número daqui, o design ganha.

O quadro de referência do design é **1440 px de largura**. Em 1440 px o app web
tem que bater pixel a pixel. Fora disso, as regras de adaptação estão na seção
"Responsivo".

---

## 1. Tokens

### Cores

| Token | Valor | Onde aparece |
|---|---|---|
| `--bg` | `#080807` | fundo da página/documento |
| `--surface` | `#0b0a0a` | fundo das telas (catálogo, série, configurações) |
| `--surface-row` | `#131111` | linha de configuração em repouso |
| `--surface-row-hover` | `#151313` | linha de configuração/episódio em hover |
| `--line` | `#262425` | borda das telas, divisórias, trilho de progresso |
| `--line-strong` | `#33302f` | borda de botão pílula, selo pequeno |
| `--line-2` | `#3a3634` | borda de selo de resolução, radio inativo |
| `--text` | `#f6f5f3` | texto principal |
| `--text-2` | `#c8c4bd` | metadados, aba inativa de temporada |
| `--muted` | `#9d9a95` | texto secundário |
| `--muted-2` | `#a9a5a0` | sinopse / parágrafo longo |
| `--dim` | `#807c76` | rótulos micro, dicas de teclado |
| `--dim-2` | `#6f6a63` | rótulo mono de seção, número de episódio |
| `--ghost` | `#4a443f` | texto do placeholder listrado (cards) |
| `--ghost-2` | `#3d3833` | texto do placeholder listrado (player) |
| `--accent` | `#f2a93b` | destaque, foco, progresso, botão primário |
| `--accent-hover` | `#ffbe5c` | hover do botão primário e de links |
| `--accent-ink` | `#171208` | texto/ícone sobre `--accent` |
| `--accent-soft-text` | `#c9a878` | detalhe dentro de linha selecionada |
| `--live` | `#ef4444` | ponto e selo "ao vivo" |
| `--live-ink` | `#ffffff` | texto sobre `--live` |

Camadas com alpha (usar exatamente estas):

```
rgb(246 245 243 / 4%)    linha de trilha em repouso
rgb(246 245 243 / 6%)    trilho do segmented control, aba inativa de temporada
rgb(246 245 243 / 7%)    botão secundário
rgb(246 245 243 / 8%)    item de nav ativo, hover de aba do segmented
rgb(246 245 243 / 9%)    hover de linha de trilha
rgb(246 245 243 / 12%)   hover de aba de temporada
rgb(246 245 243 / 13%)   hover do botão secundário
rgb(246 245 243 / 14%)   borda de pílula no player, hover de botão do player
rgb(246 245 243 / 18%)   borda dos botões redondos do player
rgb(246 245 243 / 20%)   trilho da barra do episódio (lista) e do scrub
rgb(246 245 243 / 22%)   trilho da barra de progresso do card, trilho do volume
rgb(246 245 243 / 30%)   buffer do scrub
rgb(8 8 7 / 55%)         fundo dos botões do player
rgb(8 8 7 / 62%)         véu do modal de trilhas, botão circular de play
rgb(8 8 7 / 78%)         selo sobre capa
rgb(8 8 7 / 80%)         selo de tempo restante
rgb(21 19 19 / 80%)      campo de busca e botão do topo
rgb(15 13 12 / 96%)      painel lateral de trilhas
rgb(242 169 59 / 12%)    fundo da linha de trilha selecionada
rgb(242 169 59 / 14%)    fundo da pílula de canal
rgb(242 169 59 / 20%)    outline da linha de configuração focada
rgb(242 169 59 / 35%)    borda da pílula de canal
rgb(242 169 59 / 45%)    borda da linha de trilha selecionada
rgb(242 169 59 / 55%)    borda da linha de configuração focada
rgb(239 68 68 / 88%)     selo "ao vivo" no card
rgb(239 68 68 / 92%)     selo "ao vivo" no player
rgb(0 0 0 / 45%)         sombra dos cards
rgb(0 0 0 / 60%)         sombra do card focado, sombra do knob do scrub
rgb(0 0 0 / 62%)         sombra da capa da série
rgb(0 0 0 / 55%)         sombra do painel de trilhas
```

### Placeholders listrados (quando não há imagem)

Todos são `repeating-linear-gradient(115deg, #191614 0 Npx, #141110 Npx 2Npx)`:

| Onde | N |
|---|---|
| hero do catálogo / hero da série | 14 px |
| card 16:9, card 2:3, capa da série | 12 px |
| miniatura da lista de episódios | 10 px |
| quadro de vídeo do player | 16 px (com `#141110`/`#0f0d0c`) |

Texto centralizado do placeholder: mono, `letter-spacing:0.12em`, `text-transform:uppercase`,
cor `#4a443f` (`#3d3833` no player). Tamanhos: `10px` (capa 2:3), `10.5px` (card 16:9),
`9.5px` (miniatura), `12px` (hero e player).

### Tipografia

- Família principal: `Manrope` (auto-hospedada em `/fonts/manrope-*.woff2`,
  pesos 400/500/600/700/800), fallback
  `system-ui, -apple-system, 'Segoe UI', sans-serif`.
- Mono: `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`.
- Android: `res/font/manrope_{regular,medium,semibold,bold,extrabold}.ttf`
  (peso 400/500/600/700/800), family `res/font/manrope.xml`.

Escala usada no design (px, `letter-spacing`, peso):

| Uso | tamanho | peso | tracking |
|---|---|---|---|
| Título hero do catálogo | 64 | 800 | −0.035em, line-height 1.02 |
| Título hero da série | 52 | 800 | −0.035em, line-height 1.05 |
| Título de configurações | 40 | 800 | −0.03em |
| Título do episódio no player | 34 | 800 | −0.03em |
| Título de painel de trilhas | 24 | 800 | −0.02em |
| Wordmark | 19 | 800 | 0.18em, uppercase |
| Cabeçalho de carrossel (`h3`) | 19 | 800 | −0.01em |
| Nome da linha de configuração | 16.5 | 700 | — |
| Botão primário do hero | 16.5 | 800 | — |
| Botão do hero da série | 16 | 800/700 | — |
| Valor da linha de configuração | 16 | 800 (focada) / 700 | — |
| Título de episódio na lista | 16 | 700 | −0.01em |
| Rótulo de trilha | 16 | 700 | — |
| Sinopse da série | 15.5 | 400 | line-height 1.65 |
| Sinopse do hero | 16 | 400 | line-height 1.6 |
| Nome do card 16:9 | 15 | 700 | −0.01em |
| Título "a seguir" no player | 15 | 700 | — |
| Aba de temporada | 15 | 800/700 | — |
| Nome do card 2:3 | 14.5 | 700 | line-height 1.25 |
| Aba do segmented control | 14.5 | 800/700 | — |
| Meta do hero | 14.5 | 600 | — |
| Item de nav / botões do topo | 14 | 700/600 | — |
| Contagem à direita do carrossel | 13.5 | 700 | — |
| Tempo do scrub | 13.5 | 700 | tabular-nums |
| Legenda do card | 13 | 400 | — |
| Dica da linha de configuração | 13 | 600 | — |
| Meta do episódio | 13 | 600 | — |
| Tempo restante do card | 12.5 | 700 | cor `--accent` |
| Meta do card 2:3 | 12.5 | 400 | — |
| Detalhe da trilha | 12.5 | 600 | — |
| Dica de teclado | 12.5 | 600 | `letter-spacing:0.02em` |
| Rótulo mono de seção | 11–12 | 400 | 0.16em, uppercase, mono |
| Rótulo micro uppercase | 11–11.5 | 800 | 0.16em–0.18em, uppercase |
| Selo de resolução | 11 | 700 | 0.06em |
| Selo "ao vivo" no card | 10.5 | 800 | 0.12em, uppercase |
| Selo de tempo/faixa | 10.5–11.5 | 700/800 | 0.06em |

### Raios, sombras, alturas

```
raio 6px    selo de resolução, selo pequeno
raio 7px    selo de canal no card 2:3, selo de tempo restante
raio 8px    selo do card 16:9
raio 10px   aba do segmented control
raio 12px   botão quadrado do player, miniatura do episódio, botão ✕
raio 14px   aba de temporada, linha de trilha, botão do player, trilho do segmented
raio 16px   card 16:9, card 2:3, botão do hero, linha de episódio, linha de configuração
raio 18px   capa da série, bloco de varredura
raio 20px   moldura da tela
raio 999px  pílulas, barras de progresso, knob

sombra card            0 10px 30px rgb(0 0 0 / 45%)
sombra card focado     0 18px 44px rgb(0 0 0 / 60%)
sombra capa da série   0 22px 50px rgb(0 0 0 / 62%)
sombra painel trilhas  -30px 0 70px rgb(0 0 0 / 55%)
sombra knob do scrub   0 2px 8px rgb(0 0 0 / 60%)

altura topbar          76px
altura hero catálogo   620px
altura hero série      430px
altura player          810px (16:9 aproximado do quadro de 1440)
padding lateral        48px
```

### Foco (D-pad / teclado)

O design mostra **duas** linguagens de foco, ambas obrigatórias:

1. **Card do acervo (2:3) focado**: `outline: 3px solid #f2a93b; outline-offset: 3px;`
   `transform: scale(1.03);` e sombra `0 18px 44px rgb(0 0 0 / 60%)`.
2. **Linha de configuração focada**: `background:#151313; border:1px solid rgb(242 169 59 / 55%); outline:2px solid rgb(242 169 59 / 20%)`.

Demais alvos focáveis (botões, abas, cards 16:9, linhas de episódio, linhas de
trilha) usam `outline: 3px solid #f2a93b; outline-offset: 3px` no card e
`outline: 2px solid #f2a93b; outline-offset: 2px` nos controles em pílula.

### Animação

```css
@keyframes livepulse { 50% { opacity: 0.35; } }
/* aplicada no ponto vermelho: animation: livepulse 2s ease-in-out infinite */
```

Hover do card 16:9: `transform: translateY(-4px)`.

---

## 2. Tela 01 — Catálogo

Moldura: `border:1px solid #262425; border-radius:20px; background:#0b0a0a`.

### Topbar (76 px, sobreposta ao hero)

`position:absolute; inset:0 0 auto 0; z-index:20; padding:0 48px;`
`background: linear-gradient(to bottom, rgb(11 10 10 / 92%), rgb(11 10 10 / 0%))`

Esquerda (`gap:36px`):
- Wordmark `wide` + `<span style="color:#f2a93b">tv</span>`, 19px/800/0.18em/uppercase.
- Nav (`gap:6px`), cada item: `height:36px; padding:0 14px; border-radius:999px; font-size:14px`.
  Ativo: `background: rgb(246 245 243 / 8%); font-weight:700`. Inativo: `font-weight:600; color:#9d9a95`.
  Itens: **Início**, **Ao vivo**, **Séries**.

Direita (`gap:10px`):
- Campo de busca: `height:40px; padding:0 16px; border:1px solid #33302f; border-radius:999px;`
  `background:rgb(21 19 19 / 80%); backdrop-filter:blur(8px); width:260px; gap:10px`.
  Ícone: círculo `13×13`, `border:2px solid #9d9a95`, `border-radius:50%`.
  Placeholder "Buscar no acervo", 14px, `#9d9a95`.
- Botão **Configurações**: mesma pílula, `padding:0 16px`, 14px/600, hover `background:#1d1c1b`.

> No app real a topbar ganha também o botão **Sair** (existe hoje), com o mesmo
> estilo de pílula do botão Configurações, imediatamente à direita dele.

### Hero (620 px)

Camadas, de baixo para cima:
1. Arte 16:9 (`object-fit:cover`) ou o placeholder listrado de 14 px.
2. `linear-gradient(to top, #0b0a0a 4%, rgb(11 10 10 / 72%) 38%, rgb(11 10 10 / 10%) 78%)`
   **e** `linear-gradient(to right, rgb(11 10 10 / 88%) 12%, transparent 62%)`.
3. Bloco de texto em `left:48px; bottom:72px; width:620px; gap:18px`.

Bloco de texto, na ordem:
- Pílula de canal: `height:30px; padding:0 13px; border-radius:999px;`
  `background:rgb(242 169 59 / 14%); border:1px solid rgb(242 169 59 / 35%); color:#f2a93b;`
  `font-size:11.5px; font-weight:800; letter-spacing:0.16em; uppercase; gap:9px`.
  Ponto: `7×7`, `#ef4444`, `livepulse`. Texto: `Canal NN · no ar agora`.
- `h2` 64px/800/−0.035em/lh 1.02 — nome da série.
- Linha de meta (`gap:12px`, 14.5px/600, `#c8c4bd`): ano · N episódios ·
  selo de resolução · selo de idiomas. Separador `·` com `opacity:0.4`.
  Selo: `height:22px; padding:0 8px; border:1px solid #3a3634; border-radius:6px;`
  `font-size:11px; font-weight:700; letter-spacing:0.06em`.
- Parágrafo 16px/lh 1.6/`#a9a5a0`/`max-width:56ch`.
- Botões (`gap:12px; margin-top:6px`):
  - **Entrar no canal** — `height:56px; padding:0 30px; border-radius:16px;`
    `background:#f2a93b; color:#171208; font-size:16.5px; font-weight:800; gap:10px`,
    hover `#ffbe5c`. Triângulo CSS: `border-left:12px solid #171208; border-top:8px solid transparent; border-bottom:8px solid transparent`.
  - **Ver episódios** — `height:56px; padding:0 26px; border:1px solid #3a3634;`
    `border-radius:16px; background:rgb(246 245 243 / 7%); font-size:16.5px; font-weight:700`,
    hover `rgb(246 245 243 / 13%)`.
  - **Do início** — mesma altura, `padding:0 26px`, `border:1px solid transparent`,
    `background:transparent`, `color:#a9a5a0`, hover `color:#f6f5f3`.

Conteúdo do hero: o canal que o usuário assistiu por último (`last-channel`), ou o
canal 1 quando não há histórico. A frase é gerada: `Está tocando o episódio N há M
minutos. …`

### Corpo (`padding: 8px 0 56px; gap:44px`)

Cada seção: `gap:16px`. Cabeçalho da seção: `padding:0 48px`,
`display:flex; align-items:baseline; justify-content:space-between`.
`h3` 19px/800/−0.01em; à direita 13.5px/700/`#9d9a95`.

**Seção "No ar agora"** — o `h3` leva um ponto `8×8` `#ef4444` com `livepulse`
(`gap:10px`). À direita: `N canais`. Faixa: `display:flex; gap:16px; padding:0 48px`,
rolagem horizontal.

Card 16:9 (`flex:0 0 306px; gap:11px`, hover `translateY(-4px)`):
- Moldura `aspect-ratio:16/9; border-radius:16px; box-shadow:0 10px 30px rgb(0 0 0 / 45%)`.
- Selo do canal (topo-esquerda `10px`): `height:24px; padding:0 9px; border-radius:8px;`
  `background:rgb(8 8 7 / 78%); backdrop-filter:blur(6px); font-size:12px; font-weight:800;`
  `letter-spacing:0.08em; tabular-nums`.
- Selo **AO VIVO** (topo-direita `10px`): `height:24px; padding:0 9px; border-radius:8px;`
  `background:rgb(239 68 68 / 88%); font-size:10.5px; font-weight:800; letter-spacing:0.12em; uppercase; color:#fff`.
- Barra inferior `height:3px; background:rgb(246 245 243 / 22%)` com preenchimento `#f2a93b`.
- Texto (`gap:3px`): nome 15px/700/−0.01em; episódio 13px/`#9d9a95` com ellipsis;
  restante 12.5px/700/`#f2a93b` (`faltam N min`).

**Seção "Continuar assistindo"** — só existe quando há histórico. À direita:
`do histórico do servidor`. Card igual ao 16:9, mas:
- sem selo de canal e sem selo AO VIVO;
- botão circular central `52×52; border-radius:50%; background:rgb(8 8 7 / 62%);`
  `backdrop-filter:blur(6px); border:1px solid rgb(246 245 243 / 22%)` com triângulo
  `border-left:13px solid #f6f5f3; border-top:8px solid transparent; border-bottom:8px solid transparent; margin-left:4px`;
- selo de tempo restante em `bottom:12px; right:10px`: `height:22px; padding:0 8px;`
  `border-radius:7px; background:rgb(8 8 7 / 80%); font-size:11.5px; font-weight:700; tabular-nums`;
- texto: nome + episódio (sem terceira linha).

**Seção "Todo o acervo"** — à direita `A → Z`. Faixa `gap:18px; padding:0 48px`.

Card 2:3 (`flex:0 0 184px; gap:11px`):
- Moldura `aspect-ratio:2/3; border-radius:16px; box-shadow:0 10px 30px rgb(0 0 0 / 45%)`.
- Selo do canal (topo-esquerda `10px`): `height:22px; padding:0 8px; border-radius:7px;`
  `background:rgb(8 8 7 / 78%); font-size:11.5px; font-weight:800; tabular-nums`.
- Selo de resolução (baixo-direita `10px`): `height:20px; padding:0 7px; border-radius:6px;`
  `background:rgb(8 8 7 / 78%); font-size:10.5px; font-weight:700; letter-spacing:0.06em`.
- Texto (`gap:2px`): nome 14.5px/700/lh 1.25; meta 12.5px/`#9d9a95` (`1989 · 142 EP`).
- **Focado**: `outline:3px solid #f2a93b; outline-offset:3px; transform:scale(1.03);`
  `box-shadow:0 18px 44px rgb(0 0 0 / 60%)`; o selo de resolução some enquanto focado
  (é o que o design mostra) e a legenda vira o texto do contexto.

---

## 3. Tela 02 — Série

Hero de 430 px: placeholder/arte listrada + `linear-gradient(to top, #0b0a0a 6%, rgb(11 10 10 / 78%) 46%, rgb(11 10 10 / 30%) 100%)`.

Header sobreposto (76 px, `padding:0 48px; gap:20px`):
- Botão **← Voltar**: `height:40px; padding:0 16px; border:1px solid #33302f; border-radius:999px;`
  `background:rgb(8 8 7 / 60%); backdrop-filter:blur(8px); font-size:14px; font-weight:700; gap:10px`.
- Wordmark 19px/800/0.18em.

Bloco principal: `padding:0 48px 56px; margin-top:-190px; display:flex; gap:40px; align-items:flex-start`.
- Capa: `width:232px; aspect-ratio:2/3; border-radius:18px; box-shadow:0 22px 50px rgb(0 0 0 / 62%)`.
- Coluna direita: `flex:1; padding-top:96px`.
  - Pílula `Canal NN`: `height:28px; padding:0 12px; border-radius:999px;`
    `background:rgb(242 169 59 / 14%); border:1px solid rgb(242 169 59 / 35%); color:#f2a93b;`
    `font-size:11px; font-weight:800; letter-spacing:0.16em; uppercase; margin-bottom:10px`.
  - `h2` 52px/800/−0.035em/lh 1.05, `margin-bottom:12px`.
  - Meta (`gap:12px`, 14.5px/600, `#c8c4bd`, `margin-bottom:16px`): ano · N temporadas ·
    N episódios · selo de resolução · selo de idiomas.
  - Sinopse: `max-width:70ch; font-size:15.5px; line-height:1.65; color:#a9a5a0; margin-bottom:24px`.
  - Botões (`gap:12px`, altura **54px**, raio 16px):
    - **Continuar SxxExx** (ou **Do início** quando não há retomada) — primário
      `#f2a93b`/`#171208`, 16px/800, `padding:0 28px`, triângulo idêntico ao do hero.
    - **Entrar no canal** — secundário `rgb(246 245 243 / 7%)`, borda `#3a3634`,
      `padding:0 24px`, 16px/700, com ponto `8×8` `#ef4444` (`gap:9px`).
    - **Do início** — fantasma, `padding:0 24px`, `color:#a9a5a0`.

Lista de episódios: `padding:0 48px 56px`.

Barra de temporadas: `display:flex; justify-content:space-between; padding-bottom:18px;`
`border-bottom:1px solid #262425; margin-bottom:8px`.
- Abas (`gap:8px`): `height:44px; padding:0 22px; border-radius:14px; font-size:15px`.
  Ativa: `background:#f2a93b; color:#171208; font-weight:800`.
  Inativa: `background:rgb(246 245 243 / 6%); color:#c8c4bd; font-weight:700`,
  hover `rgb(246 245 243 / 12%)`.
  Rótulos: `Temporada N` e, para episódios sem temporada, `Sem temporada · N`.
- À direita: `N episódios · Xh Ymin`, 13.5px/700/`#9d9a95`.

Linha de episódio (`<li>`, `gap:20px; padding:14px 16px; border-radius:16px;`
`border:1px solid transparent`, hover `background:#151313; border-color:#262425`):
1. Número: `flex:0 0 34px; font-size:20px; font-weight:800; color:#6f6a63; tabular-nums; text-align:right`.
2. Miniatura: `flex:0 0 172px; aspect-ratio:16/9; border-radius:12px` com barra de
   progresso `height:3px; background:rgb(246 245 243 / 20%)` e preenchimento `#f2a93b`.
3. Coluna de texto (`gap:5px`): título 16px/700/−0.01em com ellipsis; meta
   (`gap:10px`, 13px/600/`#9d9a95`): duração · selo de resolução · selo `N áudios`
   · estado em `#f2a93b`/700 (`assistido`, `faltam N min`, ou vazio).
   Selos: `height:20px; padding:0 7px; border:1px solid #33302f; border-radius:6px; font-size:10.5px; font-weight:700; letter-spacing:0.06em`.
4. Botão de play: `44×44; border-radius:50%; border:1px solid #33302f`, triângulo
   `border-left:11px solid #f6f5f3; border-top:7px solid transparent; border-bottom:7px solid transparent; margin-left:3px`.

---

## 4. Tela 03 — Player

Fundo `#000`, quadro de vídeo cobrindo tudo.

**Faixa superior**: `padding:28px 48px 64px; background:linear-gradient(to bottom, rgb(0 0 0 / 78%), transparent)`.
- Esquerda (`gap:14px`):
  - Selo **AO VIVO**: `height:34px; padding:0 14px; border-radius:999px;`
    `background:rgb(239 68 68 / 92%); font-size:12px; font-weight:800; letter-spacing:0.14em;`
    `uppercase; color:#fff; gap:9px`, ponto `8×8` branco com `livepulse`.
    (Só no ao vivo.)
  - Selo **Canal NN**: `height:34px; padding:0 14px; border-radius:999px;`
    `background:rgb(8 8 7 / 62%); backdrop-filter:blur(8px); border:1px solid rgb(246 245 243 / 14%);`
    `font-size:13px; font-weight:800; letter-spacing:0.06em; tabular-nums`.
- Direita, alinhada à direita (`gap:4px`):
  - `A seguir` — 11.5px/800/0.16em/uppercase/`#9d9a95`.
  - Título do próximo — 15px/700.
  - `em N min` — 13px/600/`#9d9a95`.

**Faixa inferior**: `padding:110px 48px 34px;`
`background:linear-gradient(to top, rgb(0 0 0 / 92%) 22%, rgb(0 0 0 / 45%) 62%, transparent)`.

Cabeçalho (`margin-bottom:22px`, `align-items:flex-end`):
- Esquerda: nome da série 13px/800/0.16em/uppercase/`#f2a93b` (`margin-bottom:6px`);
  título 34px/800/−0.03em (`S01E08 · O roubo do século`).
- Direita (`gap:10px`):
  - Botão **Áudio e legendas**: `height:48px; padding:0 20px; border-radius:14px;`
    `border:1px solid rgb(246 245 243 / 18%); background:rgb(8 8 7 / 55%); backdrop-filter:blur(10px);`
    `font-size:15px; font-weight:700; gap:10px`, hover `rgb(246 245 243 / 14%)`.
    Ícone **CC**: `height:20px; padding:0 5px; border:1.5px solid #f6f5f3; border-radius:4px; font-size:10px; font-weight:800; letter-spacing:0.04em`.
  - Botão de tela cheia `⤢`: `48×48`, mesmo estilo, `border-radius:14px`.

Linha de transporte (`gap:20px`):
- Play/pause: `60×60; border-radius:50%; background:#f2a93b`, hover `#ffbe5c`.
  Ícone de pausa: duas barras `6×22`, `#171208`, `border-radius:2px`, `gap:5px`.
  Ícone de play: triângulo `border-left:18px solid #171208; border-top:11px solid transparent; border-bottom:11px solid transparent; margin-left:4px`.
- Trilho (`flex:1; gap:10px`):
  - Barra `height:6px; border-radius:999px; background:rgb(246 245 243 / 20%)`,
    buffer `rgb(246 245 243 / 30%)`, preenchimento `#f2a93b`,
    knob `16×16; border-radius:50%; background:#f6f5f3; box-shadow:0 2px 8px rgb(0 0 0 / 60%)`
    posicionado em `left:<pct>; margin:-8px 0 0 -8px`.
  - Linha de tempos: 13.5px/700/tabular-nums/`#c8c4bd`, três colunas
    (esquerda: `M:SS no episódio`; centro: recado em `#9d9a95`; direita: duração).
- Controles à direita (`gap:10px`):
  - `−10` e `+10`: `44×44; border-radius:12px; border:1px solid rgb(246 245 243 / 18%); font-size:12px; font-weight:800`.
  - Volume: `height:44px; padding:0 16px; border-radius:12px; border:1px solid rgb(246 245 243 / 18%); gap:10px`,
    `♪` 14px/800 e trilho `72×4; border-radius:999px; background:rgb(246 245 243 / 22%)` com
    preenchimento `#f6f5f3`.

Dica de teclado: `margin-top:18px; font-size:12.5px; font-weight:600; color:#807c76; letter-spacing:0.02em`
— `Espaço pausar · ← → 10 s · S áudio e legendas · M mudo · Esc voltar`.
No ao vivo: `↑ ↓ trocar de canal · S áudio e legendas · M mudo · Esc voltar`.

---

## 5. Tela 04 — Áudio e legendas

Véu sobre o player: `background:rgb(8 8 7 / 62%); backdrop-filter:blur(6px)`.

Painel: `top:0; right:0; height:100%; width:520px; padding:36px 36px 28px;`
`background:rgb(15 13 12 / 96%); border-left:1px solid #262425;`
`box-shadow:-30px 0 70px rgb(0 0 0 / 55%); display:flex; flex-direction:column; gap:24px`.

1. Cabeçalho: título `Áudio e legendas` 24px/800/−0.02em (`margin-bottom:4px`),
   subtítulo com o episódio 13.5px/600/`#9d9a95`. Botão `✕` `40×40; border-radius:12px;`
   `border:1px solid #33302f; background:transparent; color:#c8c4bd; font-size:16px`.
2. Segmented control: `display:grid; grid-template-columns:1fr 1fr; gap:6px; padding:5px;`
   `border-radius:14px; background:rgb(246 245 243 / 6%)`. Aba: `height:44px; border-radius:10px; font-size:14.5px`.
   Ativa `background:#f2a93b; color:#171208; font-weight:800`; inativa `color:#c8c4bd; font-weight:700`,
   hover `rgb(246 245 243 / 8%)`. Rótulos: **Áudio** e **Legendas**.
3. Lista (`gap:8px`). Linha em repouso: `padding:15px 16px; border-radius:14px;`
   `border:1px solid transparent; background:rgb(246 245 243 / 4%); gap:14px`, hover `rgb(246 245 243 / 9%)`.
   - Radio: `22×22; border-radius:50%; border:2px solid #3a3634`.
   - Texto (`gap:3px`): rótulo 16px/700; detalhe 12.5px/600/`#9d9a95` (ex. `eac3 · 5.1 · faixa 1`).
   - Tag à direita: 11px/800/0.1em/uppercase/`#807c76` (ex. `padrão`).
   - **Selecionada**: `border:1px solid rgb(242 169 59 / 45%); background:rgb(242 169 59 / 12%)`,
     radio `border:2px solid #f2a93b` com miolo `10×10` `#f2a93b`, detalhe em `#c9a878`,
     tag `Tocando` em `#f2a93b`.
4. Divisória `height:1px; background:#262425`.
5. Bloco de legendas: rótulo `Legendas neste episódio` 11.5px/800/0.16em/uppercase/`#807c76`
   (`margin-bottom:2px`), seguido das mesmas linhas (sem tag).
6. Rodapé (`margin-top:auto; gap:12px`):
   - Linha `Lembrar este idioma` 14.5px/700 com switch: `52×30; border-radius:999px;`
     ligado `background:#f2a93b; justify-content:flex-end`, desligado
     `background:rgb(246 245 243 / 22%); justify-content:flex-start`; `padding:3px`;
     knob `24×24; border-radius:50%; background:#171208` (ligado) / `#f6f5f3` (desligado).
     Envolvida em `padding:14px 16px; border-radius:14px; background:rgb(246 245 243 / 4%)`.
   - Nota 12.5px/600/lh 1.5/`#807c76`: `A escolha vale para toda a casa: fica gravada no
     servidor, não no navegador. ↑ ↓ escolhem · Enter confirma · Esc fecha.`

> O design mostra as duas listas (áudio e legendas) empilhadas no mesmo painel **e**
> um segmented control. O comportamento correto: o segmented control rola/foca a seção
> correspondente; as duas seções ficam sempre visíveis, como no design.

---

## 6. Tela 05 — Configurações

Tela: `padding:40px 48px 56px`. Header (`gap:20px; margin-bottom:34px`): botão
**← Voltar** em pílula (`border:1px solid #33302f; background:transparent`) + wordmark.

Coluna central: `max-width:980px; margin:0 auto; gap:40px`.

1. Bloco de título: `h2` `Configurações` 40px/800/−0.03em (`margin-bottom:6px`);
   parágrafo 14.5px/600/`#9d9a95`:
   `Valem para a casa toda — ficam gravadas no servidor. ↑ ↓ escolhem a linha · ← → mudam o valor · Enter confirma · Esc volta.`
2. Seção **Reprodução** (`gap:10px`): `h3` 11.5px/800/0.18em/uppercase/`#807c76` (`margin-bottom:4px`).
   Linhas: `Idioma do áudio`, `Idioma da legenda`, `Ligar legenda sozinha`.
3. Seção **Biblioteca**: `Agrupar temporadas da mesma série`, `Converter arquivos em
   segundo plano`, `Varredura diária`, `Procurar arquivos novos`,
   `Reanalisar a biblioteca inteira`, `Rebuscar capas e sinopses`.

Linha de configuração: `display:flex; align-items:center; gap:24px; padding:18px 20px;`
`border-radius:16px; background:#131111; border:1px solid transparent`,
hover `background:#151313; border-color:#262425`.
- Esquerda (`gap:4px`): nome 16.5px/700; dica 13px/600/`#9d9a95`.
- Direita: valor `min-width:160px; text-align:center; font-size:16px; font-weight:700; color:#c8c4bd`.
- **Focada**: `background:#151313; border:1px solid rgb(242 169 59 / 55%);`
  `outline:2px solid rgb(242 169 59 / 20%)`; o valor vira `font-weight:800; color:#f2a93b`
  e ganha as setas laterais `←` / `→` (`color:#807c76; font-size:16px; gap:14px`).

Bloco de varredura: `padding:24px; border-radius:18px; background:#131111;`
`border:1px solid #262425; gap:14px`.
- Cabeçalho: `h3` `Varredura em andamento` 16.5px/800/−0.01em + percentual
  14px/800/`#f2a93b`/tabular-nums.
- Barra: `height:8px; border-radius:999px; background:#262425` com preenchimento `#f2a93b`.
- Linha de estado 14.5px/700/tabular-nums (`1240 de 2140 — Os Simpsons`).
- Duas linhas de resumo 13px/600/lh 1.55/`#9d9a95` (varredura e capas).

---

## 7. Responsivo (fora de 1440 px)

- `--page-x` continua **48 px** acima de 1200 px; abaixo disso vira
  `clamp(20px, 4vw, 48px)`.
- Hero do catálogo: altura `clamp(420px, 43vw, 620px)`; título
  `clamp(34px, 4.4vw, 64px)`; bloco de texto `width: min(620px, 82vw)`.
- Hero da série: altura `clamp(300px, 30vw, 430px)`; `margin-top` negativo
  proporcional; título `clamp(30px, 3.6vw, 52px)`; abaixo de 760 px a capa vai
  para cima do texto (coluna) e o `padding-top:96px` some.
- Carrosséis: largura do card 16:9 `clamp(240px, 21vw, 306px)`; card 2:3
  `clamp(140px, 12.8vw, 184px)`. `gap` mantém 16/18 px.
- Painel de trilhas: `width: min(520px, 92vw)`.
- Player: os controles à direita (`−10`, `+10`, volume) somem abaixo de 900 px;
  a linha de tempos vira duas colunas (o recado central some).
- Lista de episódios: abaixo de 720 px a miniatura some e o número encolhe para 26 px.

---

## 8. O que muda no contrato da API

1. **`GET /api/now`** (novo) — `NowPlaying[]` para todos os canais, na ordem do
   catálogo. É o que alimenta a faixa "No ar agora" sem 84 requests.
2. **`GET /api/history/resume`** (novo) — `ResumeEntry[]`, cada uma com
   `channelNumber`, `channelName`, `posterUrl`, `episode` (`EpisodeRef`),
   `positionMs`, `durationMs`, ordenadas por `updatedAt` desc. É o que alimenta
   "Continuar assistindo" sem buscar os episódios de cada canal.
3. **`ChannelSummary.seasons`** (novo campo, `number[]`) — temporadas presentes no
   canal, em ordem; `[]` quando a série não usa pastas de temporada. Evita ter de
   deduzir as abas antes de a lista de episódios chegar.
4. **`ChannelSummary.backdropUrl`** (`string | null`) — arte 16:9 quando o provedor
   tem; `null` cai no placeholder listrado.

Qualquer cliente antigo continua funcionando: são adições.
