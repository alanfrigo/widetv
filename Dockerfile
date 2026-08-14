# syntax=docker/dockerfile:1.7
# Imagem do retro-tv. Tres stages: deps de producao, build, runtime.
#
# Cuidado com o modulo nativo: better-sqlite3 compila (ou baixa) um .node por
# arquitetura e por ABI do Node. O stage que instala as dependencias de
# producao usa a MESMA imagem base do runtime, entao o binario nasce na
# arquitetura em que vai rodar. Nao adicione --platform=$BUILDPLATFORM aos
# stages abaixo: em build multi-arch isso compilaria o .node na arquitetura da
# maquina de build e o container quebraria no primeiro require.

ARG NODE_VERSION=22

# ---------------------------------------------------------------- prod deps --
FROM node:${NODE_VERSION}-slim AS prod-deps
WORKDIR /app
# python3/make/g++ so existem aqui: se o prebuild do better-sqlite3 nao cobrir a
# plataforma, o node-gyp compila na hora. O runtime nao carrega esse peso.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
# Falha o build aqui, e nao em producao as 3 da manha, se o nativo nao carregar.
RUN node --input-type=module -e "import Database from 'better-sqlite3'; new Database(':memory:').close();"

# ------------------------------------------------------------------ builder --
FROM node:${NODE_VERSION}-slim AS builder
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts ./
COPY src ./src
RUN npm run build

# ------------------------------------------------------------------ runtime --
FROM node:${NODE_VERSION}-slim AS runtime

# Preenchidos pelo CI; vazios num build local, o que nao quebra nada.
ARG VERSION=dev
ARG REVISION=unknown
ARG CREATED

# `image.source` nao e decorativo: e por ele que o GHCR liga o pacote ao
# repositorio, mostra o README na pagina do pacote e herda a visibilidade.
# Sem este label o pacote nasce solto, sem vinculo com o codigo.
LABEL org.opencontainers.image.source="https://github.com/alanfrigo/retro-tv" \
      org.opencontainers.image.url="https://github.com/alanfrigo/retro-tv" \
      org.opencontainers.image.documentation="https://github.com/alanfrigo/retro-tv#readme" \
      org.opencontainers.image.title="retro-tv" \
      org.opencontainers.image.description="Transforma uma pasta de desenhos animados em canais de TV ao vivo" \
      org.opencontainers.image.licenses="NOASSERTION" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}"

# ffmpeg traz o ffprobe, unica dependencia externa do indexador.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    LIBRARY_ROOT=/media/desenhos

WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
# Necessario: dist/ e ESM e o Node so trata .js como modulo por causa do
# "type": "module" deste package.json.
COPY package.json ./

# A biblioteca entra read-only; so o indice precisa de escrita.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

# Imagem node:*-slim ja traz o usuario `node` (uid 1000). Nada roda como root.
USER node
EXPOSE 8080

# Responde antes do login: 401 tambem prova que o processo esta de pe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/api/auth/session').then((r) => process.exit(r.status < 500 ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "dist/server/index.js"]
