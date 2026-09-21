# Node 22 is the floor the READMEs document and the version CI runs.
# The image carries the compiled watcher and the bundled IDL. It carries no
# key, no RPC endpoint, no program id, no mint, and no account. Those arrive
# at run time as env and a Secret Manager mount.
# TypeScript is compiled in the build stage. The runtime image runs the
# JavaScript and does not contain the compiler or any other build-only tool.

FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
# ws optional addons (utf-8-validate, bufferutil) run node-gyp on install.
# Alpine has no compiler here; the JS fallback is enough for this job.
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY idl ./idl
RUN npm run build

FROM node:22-alpine AS deps
WORKDIR /src
COPY package.json package-lock.json ./
ENV NODE_ENV=production
# Production deps still pull TypeScript (optional peer of @solana/*) and
# @types (jayson lists them as dependencies). The job runs compiled JS.
# Those packages are build-only; drop them before the runtime copy.
RUN npm ci --omit=dev --ignore-scripts \
  && rm -rf node_modules/typescript node_modules/@types node_modules/tsx

FROM node:22-alpine
RUN addgroup -S veto \
  && adduser -S -G veto -H veto \
  && mkdir -p /app /tmp/veto \
  && chown -R veto:veto /app /tmp/veto
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps --chown=veto:veto /src/package.json ./
COPY --from=deps --chown=veto:veto /src/node_modules ./node_modules
COPY --from=build --chown=veto:veto /src/dist ./dist
COPY --from=build --chown=veto:veto /src/idl ./idl
USER veto
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=2 \
  CMD node -e "require('node:fs').accessSync('/app/dist/index.js')"
CMD ["node", "dist/index.js", "once"]
