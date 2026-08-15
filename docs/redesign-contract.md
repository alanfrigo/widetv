# Contrato do redesign

Companheiro de `docs/redesign-spec.md` (que tem os números). Este arquivo tem os
**nomes**: rotas, classes CSS, ids de view do Android, nomes de recurso. É o que
permite mexer no CSS, no TypeScript, nos layouts e no Kotlin em paralelo sem que
um lado invente um nome que o outro não conhece.

**Regra:** nada aqui muda sem mudar dos dois lados.

---

## 1. API — o que passa a existir

Já declarado em `src/shared/api-types.ts`. O servidor implementa; web e Android
consomem.

### 1.1 `ChannelSummary` ganha dois campos

```ts
backdropUrl: string | null;   // '/api/channels/:number/backdrop' ou null
seasons: number[];            // temporadas presentes, crescente; [] quando não há
```

`seasons` sai de `SELECT DISTINCT season FROM episodes WHERE show_id = ? AND season IS NOT NULL ORDER BY season`.
Episódios com `season = null` **não** entram na lista — a aba "Sem temporada" é
deduzida pelo cliente quando a lista de episódios chega.

### 1.2 `GET /api/now` → `NowPlaying[]`

- Um item por canal, **na mesma ordem de `GET /api/channels`**.
- Canal sem episódio é omitido (não vira `null` no array).
- `cache-control: no-store`.
- Reusa `resolveNowPlaying` de `src/server/channels/service.ts` — incluindo o
  `channelPhaseOffsetMs`, senão a faixa mostra um episódio e o player outro.
- Precisa de cache de timeline por canal (invalidado por rescan), senão são N
  `listEpisodes` + N `buildTimeline` por request.

### 1.3 `GET /api/history/resume` → `ResumeEntry[]`

```ts
interface ResumeEntry {
  channelNumber: number;
  channelName: string;
  posterUrl: string | null;
  backdropUrl: string | null;
  episode: EpisodeRef;
  positionMs: number;
  durationMs: number;
  updatedAt: number;
}
```

- Ordenado por `updatedAt` desc, no máximo 20 itens.
- Entrada cujo episódio ou canal sumiu num rescan é **omitida**, não devolvida
  com campos nulos.
- `cache-control: no-store`.

### 1.4 `GET /api/channels/:number/backdrop` → `image/jpeg`

- Mesmo desenho da rota de capa (`channels/routes.ts:69`): stream do arquivo em
  `<DATA_DIR>/backdrops/<showId>.jpg`, `cache-control: private, max-age=86400`,
  404 `{error:'canal sem arte'}` quando não há.
- Coluna nova `backdrop_file TEXT` em `show_metadata` (migração de schema v8).
- Só o TMDB tem arte 16:9: `backdrop_path` da mesma resposta de `search/tv`,
  montada como `https://image.tmdb.org/t/p/w1280${backdropPath}`. TVMaze e iTunes
  continuam sem — `backdropUrl` fica `null` e a tela usa o padrão listrado.
- `ShowMetadata` (em `metadata/providers.ts`) ganha `backdropUrl: string | null`.

---

## 2. Web — markup que o `main.ts` monta

O esqueleto fixo está em `src/web/index.html`. O que o TypeScript cria em tempo
de execução está aqui, e é o que o `app.css` estiliza.

### 2.1 Card 16:9 (faixas "No ar agora" e "Continuar assistindo")

```html
<button class="card card--wide" type="button">
  <span class="card__art">                     <!-- 16/9, listrado quando vazio -->
    <img class="card__img" alt="" />           <!-- só quando há backdrop -->
    <span class="card__ghost">frame do episódio</span>  <!-- só quando não há -->
    <span class="card__chan">07</span>         <!-- só na faixa "No ar agora" -->
    <span class="card__live">ao vivo</span>    <!-- só na faixa "No ar agora" -->
    <span class="card__play"><span class="tri"></span></span>   <!-- só em "Continuar" -->
    <span class="card__left">12 min</span>     <!-- só em "Continuar" -->
    <span class="card__bar"><span class="card__bar-fill"></span></span>
  </span>
  <span class="card__text">
    <span class="card__name">A Formiga Atômica</span>
    <span class="card__sub">S01E08 · O roubo do século</span>
    <span class="card__time">faltam 4 min</span>   <!-- só na faixa "No ar agora" -->
  </span>
</button>
```

### 2.2 Card 2:3 (faixa "Todo o acervo")

```html
<button class="card card--tall" type="button">
  <span class="card__art">
    <img class="card__img" alt="" />
    <span class="card__ghost">capa 2:3</span>
    <span class="card__initials">FA</span>     <!-- fallback quando não há capa -->
    <span class="card__chan">07</span>
    <span class="card__badge">1080p</span>
    <span class="card__bar"><span class="card__bar-fill"></span></span>  <!-- só se houver progresso -->
  </span>
  <span class="card__text">
    <span class="card__name">A Formiga Atômica</span>
    <span class="card__sub">1965 · 26 EP</span>
  </span>
</button>
```

`card--tall:focus` esconde `.card__badge` (o design mostra o card focado sem ele).

### 2.3 Aba de temporada

```html
<button class="season" type="button">Temporada 1</button>
<button class="season is-active" type="button">Temporada 2</button>
```

### 2.4 Linha de episódio

```html
<li>
  <button class="ep" type="button">
    <span class="ep__n">09</span>
    <span class="ep__art">
      <img class="ep__img" alt="" />          <!-- só quando há arte -->
      <span class="ep__ghost">frame</span>
      <span class="ep__bar"><span class="ep__bar-fill"></span></span>
    </span>
    <span class="ep__text">
      <span class="ep__title">Jamming with Edward</span>
      <span class="ep__meta">
        <span>24 min</span>
        <span class="ep__dot">·</span>
        <span class="tag">1080p</span>
        <span class="tag">3 áudios</span>
        <span class="ep__state">faltam 12 min</span>
      </span>
    </span>
    <span class="ep__play"><span class="tri"></span></span>
  </button>
</li>
```

`.ep__empty` (um `<li>` solto) para "Carregando episódios…" e afins.

### 2.5 Linha de configuração

```html
<li>
  <button class="set" type="button">
    <span class="set__text">
      <span class="set__name">Idioma do áudio</span>
      <span class="set__hint">A dublagem escolhida sozinha quando…</span>
    </span>
    <span class="set__control">
      <span class="set__arrow set__arrow--left">←</span>
      <span class="set__value">Português</span>
      <span class="set__arrow set__arrow--right">→</span>
    </span>
  </button>
</li>
```

As setas existem sempre no DOM; o CSS só as mostra em `:focus`/`:hover`, e o
`main.ts` marca `set--action` nas linhas de ação. `is-busy` na linha esperando a
rede.

**Ação não implica "sem setas".** `scanIncremental` e `scanFull` disparam no
Enter e não têm valor anterior para voltar — nelas a seta esquerda some. Mas
`refreshMetadata` é ação **e** escolhe o modo com ← →, e o hint dela manda usar
as setas. Linhas assim levam `set--stepper` junto de `set--action`, e o CSS
esconde a seta esquerda só em `.set--action:not(.set--stepper)`. Quem sabe se a
seta faz algo é o reducer, não a folha.

### 2.6 Linha de trilha

```html
<li>
  <button class="trk" type="button">
    <span class="trk__radio"></span>
    <span class="trk__text">
      <span class="trk__label">Português</span>
      <span class="trk__detail">eac3 · 5.1 · faixa 1</span>
    </span>
    <span class="trk__tag">padrão</span>
  </button>
</li>
```

`is-active` na faixa tocando (a tag vira "Tocando"), `is-cursor` na linha do
cursor do controle remoto, `disabled` quando o áudio não pode ser trocado.

### 2.7 Estados globais

| Classe | Onde | Significado |
|---|---|---|
| `is-active` | `.topnav__item`, `.season`, `.segmented__tab`, `.trk` | selecionado |
| `is-cursor` | `.trk`, `.set` | linha do cursor do controle remoto |
| `is-busy` | `.set` | esperando resposta da rede |
| `is-idle` | `.screen--player` | overlay sumiu, cursor escondido |
| `is-live` | `.video` | elemento de vídeo visível |
| `is-on` | `.switch` | interruptor ligado |
| `skeleton` | `.card` | placeholder de carregamento |

---

## 3. Android — nomes de recurso

### 3.1 `res/values/colors.xml`

Um por token do spec. Nomes exatos:

```
bg              #FF080807
surface         #FF0B0A0A
surface_row     #FF131111
surface_row_hi  #FF151313
line            #FF262425
line_strong     #FF33302F
line_2          #FF3A3634
text            #FFF6F5F3
text_2          #FFC8C4BD
muted           #FF9D9A95
muted_2         #FFA9A5A0
dim             #FF807C76
dim_2           #FF6F6A63
ghost           #FF4A443F
ghost_2         #FF3D3833
accent          #FFF2A93B
accent_hover    #FFFFBE5C
accent_ink      #FF171208
accent_soft     #FFC9A878
live            #FFEF4444
live_ink        #FFFFFFFF
stripe_a        #FF191614
stripe_b        #FF141110
scrim_top       #EB0B0A0A   (92% de surface)
scrim_panel     #F50F0D0C   (96%)
overlay_veil    #9E080807   (62%)
badge_bg        #C7080807   (78%)
ctl_bg          #8C080807   (55%)
white_04        #0AF6F5F3
white_06        #0FF6F5F3
white_07        #12F6F5F3
white_08        #14F6F5F3
white_09        #17F6F5F3
white_12        #1FF6F5F3
white_14        #24F6F5F3
white_18        #2EF6F5F3
white_20        #33F6F5F3
white_22        #38F6F5F3
white_30        #4DF6F5F3
accent_12       #1FF2A93B
accent_14       #24F2A93B
accent_20       #33F2A93B
accent_35       #59F2A93B
accent_45       #73F2A93B
accent_55       #8CF2A93B
live_88         #E0EF4444
live_92         #EBEF4444
```

### 3.2 `res/values/dimens.xml`

Nomes preservados quando o papel não muda; valores novos vêm do spec. A TV é
1080p e o design é de 1440 px de largura → **1 px do design = 0.75 dp** numa TV
1080p (960 dp de largura). Os `dp` abaixo já estão convertidos.

```
page_x            36dp    (48px)
row_gap           33dp    (44px)
rail_gap          12dp    (16px)
rail_gap_tall     13.5dp -> 14dp (18px)
card_wide_width   230dp   (306px)
card_tall_width   138dp   (184px)
topbar_h          57dp    (76px)
hero_h            465dp   (620px)
shero_h           322dp   (322px ~ 430px)
series_cover_w    174dp   (232px)
panel_w           390dp   (520px)
ep_thumb_w        129dp   (172px)

radius_6          4.5dp -> 5dp
radius_8          6dp
radius_10         7.5dp -> 8dp
radius_12         9dp
radius_14         10.5dp -> 11dp
radius_16         12dp
radius_18         13.5dp -> 14dp
radius_20         15dp

stroke_focus      2.25dp -> 2dp
stroke_focus_card 3dp

text_hero         48sp    (64px)
text_shero        39sp    (52px)
text_settings     30sp    (40px)
text_player       26sp    (34px)
text_panel        18sp    (24px)
text_wordmark     14sp    (19px)
text_row          14sp    (19px)
text_button       12.5sp -> 13sp
text_body         12sp    (16px)
text_card         11sp    (15px)
text_meta         10sp    (13px)
text_micro        9sp     (11.5px)
text_tag          8sp     (11px)
```

> Se alguma medida ficar visivelmente errada na TV, o valor em `dp` é que se
> ajusta — nunca o número do design.

### 3.3 `res/font/`

`manrope.xml` declara a família apontando para os cinco `.ttf` já baixados:

```xml
<font-family xmlns:android="http://schemas.android.com/apk/res/android">
  <font android:fontStyle="normal" android:fontWeight="400" android:font="@font/manrope_regular" />
  <font android:fontStyle="normal" android:fontWeight="500" android:font="@font/manrope_medium" />
  <font android:fontStyle="normal" android:fontWeight="600" android:font="@font/manrope_semibold" />
  <font android:fontStyle="normal" android:fontWeight="700" android:font="@font/manrope_bold" />
  <font android:fontStyle="normal" android:fontWeight="800" android:font="@font/manrope_extrabold" />
</font-family>
```

`Theme.WideTv` ganha `<item name="android:fontFamily">@font/manrope</item>`.
Onde o design pede 800 e o `textStyle="bold"` não basta, usar
`android:fontFamily="@font/manrope_extrabold"` na própria view (minSdk 23 não tem
`fontVariationSettings`).

### 3.4 `res/drawable/` — o que passa a existir

| Arquivo | O que é |
|---|---|
| `stripes.xml` · `stripes_hero.xml` · `stripes_thumb.xml` | padrão listrado, fundo de toda arte ausente. Ver nota abaixo. |
| `card_frame.xml` | selector: `state_focused` → stroke `accent` de `stroke_focus_card`, raio `radius_16` |
| `pill.xml` | `radius 999`, fill `ctl_bg`, stroke 1dp `line_strong` |
| `pill_accent.xml` | `radius 999`, fill `accent_14`, stroke 1dp `accent_35` |
| `btn_primary.xml` | raio `radius_16`, fill `accent`; `state_focused`/`state_pressed` → `accent_hover` |
| `btn_soft.xml` | raio `radius_16`, fill `white_07`, stroke 1dp `line_2`; focado → `white_13` |
| `btn_ghost.xml` | raio `radius_16`, transparente; focado → stroke `accent` |
| `season_tab.xml` | selector: selecionado → fill `accent`; senão `white_06` |
| `row_setting.xml` | selector: focado/selecionado → fill `surface_row_hi` + stroke `accent_55`; senão fill `surface_row` + stroke transparente; raio `radius_16` |
| `row_track.xml` | selector: selecionado → fill `accent_12` + stroke `accent_45`; senão `white_04`; raio `radius_14` |
| `radio_track.xml` | selector: selecionado → anel `accent` 2dp + miolo; senão anel `line_2` 2dp |
| `badge_dark.xml` | fill `badge_bg`, raio `radius_8` |
| `badge_live.xml` | fill `live_88`, raio `radius_8` |
| `badge_outline.xml` | stroke 1dp `line_2`, raio `radius_6` |
| `tag_outline.xml` | stroke 1dp `line_strong`, raio `radius_6` |
| `ctl_bg.xml` | fill `ctl_bg`, stroke 1dp `white_18`, raio `radius_14` |
| `progress_track.xml` | `<layer-list>` de progresso: fundo `white_20`, `id/progress` `accent`, raio 999 |
| `scrim_top.xml` | gradiente vertical `scrim_top` → transparente |
| `scrim_bottom.xml` | gradiente vertical transparente → preto 92% |
| `hero_scrim.xml` | `<layer-list>` com o gradiente de baixo e o da esquerda |
| `panel_bg.xml` | fill `scrim_panel` |
| `switch_track.xml` / `switch_knob.xml` | interruptor de "Lembrar este idioma" |
| `play_circle.xml` | círculo `accent` |
| `play_circle_dark.xml` | círculo `overlay_veil` + stroke `white_22` |

#### Nota: o listrado no Android

`GradientDrawable` não repete e só aceita ângulos múltiplos de 45° — não há como
escrever `repeating-linear-gradient(115deg, …)` em XML de shape, em nenhuma API.
A saída é um **ladrilho PNG** em `res/drawable-xhdpi/`, repetido por
`<bitmap android:tileMode="repeat">`:

| drawable | ladrilho | período | onde |
|---|---|---|---|
| `stripes_hero` | `stripes_tile_hero.png` 47×94 | 21 dp (N=14) | `hero_art`, `series_backdrop` |
| `stripes` | `stripes_tile.png` 40×80 | 18 dp (N=12) | cards 16:9 e 2:3, capa da série |
| `stripes_thumb` | `stripes_tile_thumb.png` 34×68 | 15 dp (N=10) | miniatura do episódio |

As faixas são perpendiculares a `(2, 1)` — 116,57° em vez dos 115° do design.
A diferença de 1,6° é invisível; em troca o padrão fecha exato nas duas bordas
(largura = metade do período em unidades de `2x + y`, altura = o período
inteiro), sem costura na emenda do ladrilho. Para regerar, veja o comentário em
`stripes.xml`: as três imagens saem de um gerador de PNG de ~15 linhas, sem
dependência de biblioteca de imagem.

### 3.5 Ids de view — `activity_main.xml`

Os ids que **já existem continuam existindo** (o Kotlin depende deles). O que é
novo está marcado com ➕.

**Topbar (nova, dentro de `home`)**
```
➕ topbar, topbar_nav_home, topbar_nav_live, topbar_nav_shelf,
➕ topbar_search, topbar_search_input, home_settings (existente), ➕ home_logout
```

**Home**
```
home (existente)
➕ hero, hero_art, hero_scrim, hero_chip, hero_chip_text, hero_title,
➕ hero_meta, hero_text, hero_play, hero_episodes, hero_first
➕ rows_scroll (NestedScrollView vertical)
➕ row_live, row_live_aside, rail_live (RecyclerView horizontal)
➕ row_resume, rail_resume (RecyclerView horizontal)
➕ row_shelf, row_shelf_aside, rail_shelf (RecyclerView horizontal)
home_status (existente)
home_grid — REMOVIDO, substituído por rail_shelf
```

**Series**
```
series, series_art (PosterFrame → agora a capa 2:3), series_poster,
series_initials, series_title, series_meta, series_overview,
series_live, series_start, series_episodes  (todos existentes)
➕ series_back, series_backdrop, series_backdrop_scrim, series_channel,
➕ series_resume, series_resume_text, season_tabs (RecyclerView horizontal),
➕ season_aside
```

**Settings**
```
settings, settings_list, settings_progress, settings_progress_text,
settings_scan_summary, settings_metadata, settings_message  (existentes)
➕ settings_back, settings_playback (RecyclerView), settings_library (RecyclerView),
➕ scan_card, scan_pct, scan_state
settings_list — mantido como id do RecyclerView de Reprodução? NÃO:
   passa a existir settings_playback e settings_library; `settings_list` sai.
```

**Player**
```
player_screen, stage, osd, tracks, track_list  (existentes)
➕ overlay, overlay_top, live_badge, channel_badge,
➕ upnext, upnext_title, upnext_time,
➕ overlay_show, overlay_title, tracks_open, fullscreen,
➕ play_toggle, scrub_bar, scrub_left, scrub_note, scrub_right,
➕ seek_back, seek_fwd, volume, volume_fill, overlay_hint,
➕ tracks_veil, tracks_sub, tracks_close, tab_audio, tab_subs,
➕ track_remember, track_remember_switch, panel_note
```

**Gate** — ids inalterados, só o visual muda.

### 3.6 Layouts de item

| Arquivo | Ids |
|---|---|
| `item_card_wide.xml` ➕ | `card`, `card_art`, `card_img`, `card_ghost`, `card_chan`, `card_live`, `card_play`, `card_left`, `card_bar`, `card_name`, `card_sub`, `card_time` |
| `item_card_tall.xml` ➕ (substitui `item_poster.xml`) | `card`, `card_art`, `card_poster`, `card_initials`, `card_chan`, `card_badge`, `card_bar`, `card_name`, `card_meta` |
| `item_episode.xml` | `episode_row`, `episode_n`, `episode_art`, `episode_bar`, `episode_title`, `episode_meta_duration`, `episode_badge`, `episode_tracks`, `episode_state`, `episode_play` |
| `item_season.xml` ➕ | `season_tab` |
| `item_setting.xml` | `setting_row`, `setting_label`, `setting_hint`, `setting_arrow_left`, `setting_value`, `setting_arrow_right` |
| `item_track.xml` | `track_row`, `track_radio`, `track_label`, `track_detail`, `track_tag` |
| `item_track_header.xml` | `track_section` |

---

## 4. Divisão de trabalho

| Pacote | Arquivos que ele possui (e só ele) |
|---|---|
| **SERVER** | `src/server/**`, `tests/**` (exceto `tests/web`) |
| **WEB-CSS** | `src/web/app.css` |
| **WEB-TS** | `src/web/*.ts` (menos `app.css`), `src/web/index.html` já está pronto |
| **AND-RES** | `android/app/src/main/res/values/**`, `res/drawable/**`, `res/font/manrope.xml` |
| **AND-LAYOUT** | `android/app/src/main/res/layout/**` |
| **AND-KT** | `android/app/src/main/java/**`, `android/app/src/test/java/**` |

`src/shared/api-types.ts` e `src/web/index.html` já estão fechados — ninguém mexe.

---

## 5. Quadros de episódio e arte 16:9 gerada

Nenhum provedor de metadata tem imagem por episódio de acervo caseiro, e o
design é feito delas: a lista de episódios tem miniatura 16:9, e as faixas "No
ar agora" e "Continuar assistindo" mostram literalmente "frame do episódio". A
saída é tirar do próprio vídeo, com ffmpeg, em segundo plano.

O mesmo mecanismo resolve o hero: sem `TMDB_API_KEY` nenhuma série ganha
`backdrop_path`, então a arte 16:9 do hero também sai de um quadro.

### 5.1 Onde os arquivos moram

| O quê | Caminho | Tamanho |
|---|---|---|
| Quadro do episódio | `<DATA_DIR>/thumbs/<episodeRowId>.jpg` | 480×270 |
| Arte 16:9 do canal | `<DATA_DIR>/backdrops/<showId>.jpg` | 1280×720 |

`episodeRowId` é o `id` INTEGER da tabela `episodes`, não o `EpisodeRef.id`
(que é caminho relativo e não serve de nome de arquivo). Mesma escolha que as
capas já fazem com `showId`.

### 5.2 Colunas novas

- `episodes.thumb_file TEXT` — basename, ou `NULL` enquanto não há quadro.
- `episodes.thumb_checked_at INTEGER` — carimbo da tentativa. Distingue "ainda
  não tentei" de "tentei e o arquivo não deu quadro", que é o que evita a fila
  reoferecer o mesmo episódio para sempre. Mesma lição de `backdrop_checked_at`.
- `show_metadata.backdrop_source TEXT` — `'tmdb'` ou `'frame'`. Sem isso, uma
  arte tirada de quadro seria indistinguível de uma do provedor, e a busca de
  metadata nunca a substituiria quando a chave do TMDB aparecesse.

### 5.3 Qual quadro

- **Episódio**: seek em **30%** da duração. Se o JPEG sair com menos de 3 KB, o
  quadro era chapado (tela preta, fade, cartela) — tenta **55%** e fica com o
  segundo resultado. Heurística barata: um seek a mais só acontece nos poucos
  arquivos que caem em preto, e não custa decodificação nenhuma a mais no caso
  bom.
- **Canal**: o episódio do **meio da primeira temporada** (ordem do índice),
  seek em 35%. Determinístico: a mesma série dá sempre a mesma arte, então uma
  rodada repetida não muda a cara do catálogo.

### 5.4 A fila

Molde de `variant-queue.ts`/`remux-job.ts`: **concorrência 1**. O servidor é o
mesmo que está entregando vídeo, e dois ffmpeg competindo com o streaming
aparecem como travada na TV de quem está assistindo. `-threads 1` pelo mesmo
motivo.

Disparo:
- ao fim de uma varredura, quando `AppSettings.autoThumbs` está ligado;
- por `POST /api/library/thumbs` (`{ reset?: boolean }`), que é o botão da tela.

Invalidação: episódio cuja linha é substituída num rescan perde o quadro
(arquivo e colunas), porque o arquivo do disco pode ter mudado.

### 5.5 Contrato HTTP

Já declarado em `src/shared/api-types.ts`:

- `EpisodeRef.thumbUrl: string | null` → `/api/stream/:id/thumb`
- `GET /api/stream/:id/thumb` → `image/jpeg`, `private, max-age=86400`, 404
  enquanto não existe (a tela cai no listrado, nunca em imagem quebrada)
- `AppSettings.autoThumbs: boolean`
- `LibraryStatus.thumbs: { state, progress, last: ThumbSummary | null }`
- `POST /api/library/thumbs` → `TaskAccepted` (202 / 409)

### 5.6 O que os clientes passam a desenhar

| Onde | Fonte da imagem |
|---|---|
| Linha de episódio | `episode.thumbUrl` |
| Card "No ar agora" | `nowPlaying.episode.thumbUrl` |
| Card "Continuar assistindo" | `entry.episode.thumbUrl` |
| Hero do catálogo | `channel.backdropUrl` |
| Fundo da tela de série | `channel.backdropUrl` |

Em todos, `null` cai no padrão listrado que o CSS e os drawables já desenham.
