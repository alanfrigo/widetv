# Deploy

Como subir o widetv em casa, no TrueNAS SCALE, atras de um reverse proxy com
HTTPS.

---

## Sem HTTPS, a senha e a sessao andam nuas

O app tem **uma senha unica** e um **cookie de sessao stateless**. Quem consegue
ler o trafego consegue entrar.

- Em HTTP puro, o `POST /api/auth/login` leva a **senha em texto claro** no
  corpo, e toda resposta seguinte carrega o cookie `rtv_session` em texto claro.
- Qualquer maquina no caminho - outro aparelho no Wi-Fi, o roteador, um
  repetidor, a rede do vizinho se o Wi-Fi for aberto - le e **copia o cookie**.
  O cookie e um bilhete completo: quem tiver o valor entra sem saber a senha,
  ate ele expirar. Nao existe lista de sessoes para revogar (por design: o
  servidor nao guarda sessao).
- Trocar a senha **nao** derruba os cookies ja emitidos. Para invalidar todos,
  troque o `SESSION_SECRET` e reinicie.

**Regra:** exponha o app apenas atras de um reverse proxy com TLS, e mantenha
`SECURE_COOKIES=true`. Se for so na LAN, deixe a porta publicada em
`127.0.0.1` (o padrao do `docker-compose.yml`) e chegue nele pelo proxy.

> Detalhe que confunde: com `SECURE_COOKIES=true` servido por **HTTP**, o
> navegador **descarta** o cookie e o login parece nao funcionar (loga, volta
> para a tela de senha). O certo e por HTTPS na frente, nao baixar a flag.

---

## 1. Pre-requisitos

- Docker e Docker Compose v2 (TrueNAS SCALE 24.10+ ja usa Docker).
- Um dataset com os desenhos, no formato `RAIZ/SERIE/*.mp4` ou
  `RAIZ/SERIE/TEMPORADA N/*.mp4`.
- Um reverse proxy com certificado (Nginx Proxy Manager, Caddy, Traefik).

O `ffmpeg` **nao** precisa estar instalado no host: ele vai dentro da imagem.

---

## 2. Gerar os segredos

### `SESSION_SECRET`

```bash
openssl rand -hex 32
```

64 caracteres hexadecimais, sem `$`, sem aspas, sem dor de cabeca. Trocar esse
valor **desloga todo mundo** - e o botao de emergencia se voce achar que um
cookie vazou.

### `AUTH_PASSWORD_HASH`

```bash
npm run hash-password
# ou, para script:
echo 'minha-senha' | npm run hash-password
```

Sai algo assim (scrypt, com os parametros embutidos):

```
scrypt$16384$8$1$ZR7eP/Po0dRx3tL29F6mQw==$qiVzxbaoOSDzgrP4XeVH391yM40f58rNO3eSgYFfk9g=
```

O comando le a senha sem eco quando roda no terminal, pede confirmacao, e
imprime **so o hash** no stdout (os avisos vao para o stderr, entao
`npm run hash-password > hash.txt` funciona).

### O `$` do hash e uma armadilha do compose

O hash tem `$` como separador, e o `docker compose` expande `$` como variavel.
Isso foi medido, nao e teoria:

| Onde | Como escrever | Resultado |
| --- | --- | --- |
| `.env` | `AUTH_PASSWORD_HASH='scrypt$16384$8$1$aGVsbG8=$bXVuZG8='` | valor intacto |
| `.env` | sem aspas | vira `scrypt$16384$8$1==` - **hash destruido** |
| YAML colado na UI | `"scrypt$$16384$$8$$1$$aGVsbG8=$$bXVuZG8="` | valor intacto |
| YAML colado na UI | com um `$` so | vira `scrypt$16384$8$1==` |
| Campo de variavel da UI do TrueNAS | valor literal, sem aspas e sem `$$` | valor intacto |

O sintoma da versao quebrada e sempre o mesmo: senha correta, login recusado,
nenhum erro no log. Se acontecer, confira o valor de dentro do container:

```bash
docker compose exec widetv node -e "console.log(process.env.AUTH_PASSWORD_HASH)"
```

Tem que sair identico ao que o `hash-password` imprimiu.

---

## 3. `.env`

Ao lado do `docker-compose.yml`, a partir do `.env.example`:

```bash
cp .env.example .env
```

```dotenv
# Caminho da biblioteca NO HOST. O compose monta isso em /media/biblioteca:ro.
LIBRARY_ROOT=/mnt/tank/midia/desenhos

# Onde a porta fica publicada no host. 127.0.0.1 = so o proxy alcanca.
HOST_BIND=127.0.0.1
HOST_PORT=8080

CHANNEL_EPOCH=2024-01-01T00:00:00Z

# Aspas simples obrigatorias por causa dos "$".
AUTH_PASSWORD_HASH='scrypt$16384$8$1$...'

SESSION_SECRET=cole-aqui-o-openssl-rand-hex-32

# true sempre que houver HTTPS na frente. E deve haver.
SECURE_COOKIES=true

TZ=America/Sao_Paulo
```

`LIBRARY_ROOT` e `DATA_DIR` aparecem duas vezes com sentidos diferentes, e isso
e de proposito: no `.env` valem para o **host**, e o `docker-compose.yml`
sobrescreve os dois dentro do container para `/media/biblioteca` e `/data`.

---

## 4. Subir com docker compose

```bash
docker compose build
docker compose up -d
docker compose logs -f widetv
```

Conferir saude:

```bash
docker compose ps          # deve mostrar (healthy) depois de ~20s
curl -i http://127.0.0.1:8080/api/auth/session   # 401 sem cookie e o esperado
```

O primeiro `up` varre a biblioteca e roda o `ffprobe` em cada arquivo. Isso
acontece **em segundo plano**: o servidor comeca a responder na hora, e a lista
de canais nasce vazia e vai se enchendo. Com acervo grande a indexacao leva
minutos; acompanhe pelo log.

```bash
docker compose logs -f widetv | grep scan
# scan 4200/14139  Pica-Pau
# scan concluido: 460 canais, 14139 episodios (0 arquivos falharam)
```

O scan em segundo plano e proposital: um servidor que so respondesse no fim da
indexacao reprovaria no healthcheck e seria reiniciado pelo orquestrador antes
de terminar, reiniciando o scan junto, para sempre.

Os resultados ficam cacheados no SQLite por `mtime`+`size`, entao o segundo boot
nao reindexa nada. Para desligar a indexacao automatica e comandar na mao, veja
`AUTO_SCAN` na secao 7.

---

## 5. TrueNAS SCALE

O painel de Apps do SCALE nao faz `build` - ele so roda imagem pronta. Duas
saidas:

**A) Construir na propria NAS (mais simples).** Por SSH:

```bash
cd /mnt/tank/apps/widetv        # clone do projeto aqui
docker compose build              # gera widetv:latest na NAS
```

**B) Construir na sua maquina e transferir:**

```bash
docker compose build
docker save widetv:latest | ssh truenas 'docker load'
```

Se a NAS for arm64 e voce estiver num Mac Apple Silicon, isso ja bate. Vindo de
um PC x86, force o alvo: `docker compose build --builder default` nao resolve -
use `docker buildx build --platform linux/arm64 -t widetv:latest --load .`.
O `better-sqlite3` e um binario nativo: imagem da arquitetura errada quebra no
primeiro acesso ao banco.

### Datasets

| Dataset | Uso | Permissao |
| --- | --- | --- |
| `/mnt/tank/midia/desenhos` | biblioteca | leitura para uid 1000 |
| volume `widetv_widetv-data` | indice SQLite | criado pelo Docker |

O container roda como o usuario `node`, **uid 1000**, nao-root. O dataset da
biblioteca precisa ser legivel por esse uid (ele e montado `:ro`, entao
escrita nao importa). Se preferir bind mount para os dados no lugar do volume
nomeado, o dataset precisa ser **do uid 1000**, senao o SQLite nao abre:

```bash
chown -R 1000:1000 /mnt/tank/apps/widetv-data
```

### Instalar como Custom App

1. **Apps → Discover Apps → Custom App → Install via YAML**.
2. Cole o conteudo do `docker-compose.yml` com dois ajustes:
   - tire o bloco `build:` (a NAS usa a imagem ja construida);
   - troque `${LIBRARY_ROOT}` pelo caminho real do dataset.
3. As variaveis de ambiente: prefira os campos da UI, onde o valor vai
   **literal** (sem aspas, sem `$$`). Se preferir deixa-las inline no YAML,
   dobre cada `$` do hash (`$$`).
4. `restart: unless-stopped` ja esta no arquivo; a app sobe sozinha depois de
   reboot.

YAML minimo para a UI, ja sem `build`:

```yaml
services:
  widetv:
    image: widetv:latest
    restart: unless-stopped
    init: true
    environment:
      PORT: "8080"
      LIBRARY_ROOT: /media/biblioteca
      # Nao deixe DATA_DIR em branco na UI: vazio vira /app/data, que nao tem
      # volume nem permissao de escrita.
      DATA_DIR: /data
      AUTO_SCAN: "true"
      CHANNEL_EPOCH: "2024-01-01T00:00:00Z"
      SECURE_COOKIES: "true"
      TZ: America/Sao_Paulo
      # um "$" vira "$$" aqui dentro
      AUTH_PASSWORD_HASH: "scrypt$$16384$$8$$1$$...$$..."
      SESSION_SECRET: "..."
    ports:
      - "127.0.0.1:8080:8080"
    volumes:
      - /mnt/tank/midia/desenhos:/media/biblioteca:ro
      - widetv-data:/data
volumes:
  widetv-data:
```

---

## 6. Reverse proxy com HTTPS

O app fala HTTP puro e nao termina TLS. O proxy faz isso.

### Nginx / Nginx Proxy Manager

```nginx
server {
  listen 443 ssl http2;
  server_name tv.exemplo.com;

  ssl_certificate     /etc/letsencrypt/live/tv.exemplo.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/tv.exemplo.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # Video usa Range; nao bufferize nem quebre o 206.
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_http_version 1.1;
    client_max_body_size 0;
    proxy_read_timeout 3600s;
  }
}

# Redireciona quem chegar em HTTP.
server {
  listen 80;
  server_name tv.exemplo.com;
  return 301 https://$host$request_uri;
}
```

No Nginx Proxy Manager: **Force SSL** ligado, **HTTP/2** ligado, e o
`X-Forwarded-Proto` ja vem por padrao.

### Caddy

```caddyfile
tv.exemplo.com {
  reverse_proxy 127.0.0.1:8080
}
```

O Caddy tira certificado sozinho e ja manda `X-Forwarded-Proto`.

### Checklist do proxy

- [ ] HTTP redireciona para HTTPS (o `301` evita o primeiro request nu).
- [ ] `SECURE_COOKIES=true` no container.
- [ ] Porta 8080 **nao** publicada na LAN (`HOST_BIND=127.0.0.1`).
- [ ] Se o proxy estiver em outro host, ligue os dois por rede Docker ou VPN, e
      nao publique 8080 em `0.0.0.0` sem TLS.
- [ ] Nada de expor direto na internet sem HTTPS. Vale repetir: uma senha so, e
      o cookie e o bilhete inteiro.

---

## 7. Operacao

**Logs e saude**

```bash
docker compose logs -f widetv
docker inspect --format '{{json .State.Health}}' widetv | jq
```

**Backup.** O que importa e o volume `widetv-data` (indice e cache de probe).
Ele e reconstrutivel a partir da biblioteca, mas reconstruir custa um novo
`ffprobe` em tudo. Alem disso, os **numeros de canal** vivem la: perder o volume
renumera os canais.

```bash
docker run --rm -v widetv_widetv-data:/data -v "$PWD:/backup" \
  node:22-slim tar czf /backup/widetv-data.tgz -C /data .
```

**Reindexar depois de mexer no acervo**

O scan automatico so dispara quando o indice esta vazio. Depois de adicionar ou
remover desenhos, chame na mao:

```bash
docker compose exec widetv node dist/server/scan.js /media/biblioteca
```

E `node dist/server/scan.js`, nao `npm run scan`: o `npm run scan` depende do
`tsx`, que e dependencia de desenvolvimento e nao existe dentro da imagem.

Rodar de novo e barato, so o que mudou de `mtime` ou tamanho volta para o
`ffprobe`. Series novas ganham numero de canal no fim da lista; as existentes
nao se mexem. Para desligar o automatico, ponha `AUTO_SCAN=false`.

O remux (MKV/Dolby para MP4, veja `AUTO_REMUX` no `.env.example`) roda sozinho
depois do scan e em todo boot. Para rodar na mao:

```bash
docker compose exec widetv node dist/server/remux.js /media/biblioteca
```

**Atualizar**

```bash
git pull
docker compose build
docker compose up -d
```

**Trocar a senha**

```bash
npm run hash-password        # gera o novo hash
# edite AUTH_PASSWORD_HASH no .env (aspas simples!)
docker compose up -d         # recria o container
```

Lembrando: trocar a senha nao derruba sessao antiga. Para derrubar, troque
tambem o `SESSION_SECRET`.

---

## 8. Quando der errado

| Sintoma | Causa provavel |
| --- | --- |
| Login recusa a senha certa | `$` do hash comido pelo compose (secao 2) |
| Loga e volta para a tela de senha | `SECURE_COOKIES=true` servido por HTTP: o navegador joga o cookie fora |
| `SESSION_SECRET vazio` no boot | variavel nao chegou no container; confira com `docker compose exec` |
| `Error: Could not locate the bindings file` | imagem de outra arquitetura; reconstrua na arquitetura da NAS |
| `SQLITE_CANTOPEN` | `/data` sem permissao para o uid 1000 |
| `nao consegui criar o diretorio de dados /app/data` | `DATA_DIR` chegou em branco e virou caminho relativo. A UI do TrueNAS manda campo vazio como string vazia: ponha `/data` explicitamente |
| `sem permissao de escrita em ...` | `DATA_DIR` aponta para fora do volume, ou o volume nao pertence ao uid 1000 |
| Sobe, loga, mas nenhum canal aparece | indexacao ainda rodando. `docker compose logs -f widetv \| grep scan` |
| `scan terminou sem nenhum canal` | `LIBRARY_ROOT` errado dentro do container, ou volume montado vazio. A raiz e a pasta que contem **uma pasta por desenho** |
| Canais renumerados do nada | volume de dados perdido ou recriado |
| Video nao busca (seek) | proxy com buffering ligado, ou arquivo sem faststart - rode `npm run survey` |
| Biblioteca vazia | `LIBRARY_ROOT` do host errado, ou dataset ilegivel para o uid 1000 |

Para inspecionar o acervo antes de culpar o app, o survey da Fase 0 roda fora
do container (precisa das devDependencies):

```bash
npm run survey -- /mnt/tank/midia/desenhos --sample 200
```

---

## 9. App nativo na Google TV

O navegador da TV continua funcionando; o app existe para nao pedir teclado toda
vez que a sessao vence e para entender o controle remoto. Ele consome a mesma
API e nao exige nenhuma mudanca no servidor.

O passo a passo de build e configuracao esta em `android/README.md`. Resumo do
sideload:

```bash
# na TV: Ajustes > Sistema > Sobre > 7 toques em "Versao do Android",
# depois Ajustes > Sistema > Desenvolvedor > Depuracao por rede
adb connect <ip-da-tv>:5555
adb install -r android/app/build/outputs/apk/release/app-release.apk
```

Dois pontos que tocam o servidor:

- **HTTPS continua obrigatorio** pelo caminho publico. O app aceita `http://`
  apenas para o atalho da LAN, e essa e a unica razao de ele permitir cleartext.
- **A sessao e a mesma coisa**: cookie `rtv_session` assinado. O app guarda o
  cookie e a senha no aparelho e refaz o login sozinho quando o cookie vence.
  Trocar o `SESSION_SECRET` derruba a TV junto com os navegadores — o app volta
  sozinho, sem pedir senha, desde que a senha nao tenha mudado tambem.
