# BitChord Telegram Addon — multi-stage, non-root, read-only root filesystem (4.1, 4.12)
# syntax=docker/dockerfile:1
#
# M3: BASE_IMAGE is parametric — the mandated slim benchmark (§4.13) is
#   docker build --build-arg BASE_IMAGE=node:22-slim -t bitchord:slim .
#   docker build --build-arg BASE_IMAGE=node:22-alpine -t bitchord:alpine .
# musl caveat (alpine): MALLOC_ARENA_MAX and other glibc malloc knobs are ignored.

ARG BASE_IMAGE=node:22-slim

FROM ${BASE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM ${BASE_IMAGE} AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

FROM ${BASE_IMAGE} AS runtime
ENV NODE_ENV=production \
    TZ=UTC
WORKDIR /app
COPY package.json package-lock.json ./
COPY --from=build /app/dist ./dist
RUN npm prune --omit=dev && npm cache clean --force
# /data is the WAL index home (§4.11); pre-own it so named/bind volumes and the
# non-root USER both work (compose mounts initialize from the image layer).
RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 8080
VOLUME ["/data"]
# rootDir "." compiles to dist/src/server.js (also see package.json start)
CMD ["node", "dist/src/server.js"]
