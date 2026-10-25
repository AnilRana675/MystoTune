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

FROM ${BASE_IMAGE} AS proddeps
WORKDIR /app
COPY package.json package-lock.json ./
# M7.14.1: the deps npm cache carries the better-sqlite3 prebuild tarball, so
# prebuild-install resolves from cache — no second network download, no
# node-gyp, no host Python. Runtime never runs install scripts again.
COPY --from=deps /root/.npm /root/.npm
RUN npm ci --omit=dev

FROM ${BASE_IMAGE} AS runtime
ENV NODE_ENV=production \
    TZ=UTC
WORKDIR /app
COPY --from=proddeps /app/node_modules ./node_modules
# package.json rides along: startup walks ../../package.json for the addon
# manifest version (FR-24/packageVersion) — without it the manifest falls
# back to "0.0.0" (M7.14.2: the dockerfix2 image dropped this copy).
COPY --from=proddeps /app/package.json ./package.json
COPY --from=build /app/dist ./dist
# /data is the WAL index home (§4.11); pre-own it so named/bind volumes and the
# non-root USER both work (compose mounts initialize from the image layer).
RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 8080
VOLUME ["/data"]
# rootDir "." compiles to dist/src/server.js (also see package.json start)
CMD ["node", "--disable-warning=ExperimentalWarning", "--disable-warning=TimeoutNegativeWarning", "dist/src/server.js"]
