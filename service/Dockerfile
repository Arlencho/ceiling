# Node 22 is the floor the READMEs document and the version CI runs.
# The image carries the compiled index service: the read API (default CMD),
# the webhook receiver, the backfill runner, and the migration runner. It
# carries no database URL, no RPC endpoint, and no webhook auth header.
# Those arrive at run time as Secret Manager env vars.
#
# The build context is the repository root, not service/: the decoder imports
# the IDL and the event parser from indexer/, and tsc emits both trees under
# dist/. TypeScript is compiled in the build stage. The runtime image runs
# the JavaScript and does not contain the compiler or any other build-only
# tool.

FROM node:22-alpine AS build
WORKDIR /src
COPY indexer/package.json indexer/package-lock.json indexer/
COPY service/package.json service/package-lock.json service/
RUN npm ci --ignore-scripts --prefix indexer \
  && npm ci --ignore-scripts --prefix service
COPY indexer/idl indexer/idl
COPY indexer/src indexer/src
COPY service/tsconfig.json service/
COPY service/src service/src
RUN npm run build --prefix service

FROM node:22-alpine AS deps
WORKDIR /src
COPY service/package.json service/package-lock.json service/
ENV NODE_ENV=production
# The compiled indexer modules resolve @solana/web3.js and bs58 from the
# service dependencies through the shared /app/node_modules. Production deps
# still pull TypeScript (optional peer of @solana/*); it is build-only, drop
# it before the runtime copy.
RUN npm ci --omit=dev --ignore-scripts --prefix service \
  && rm -rf service/node_modules/typescript service/node_modules/tsx service/node_modules/@types

FROM node:22-alpine
RUN addgroup -S veto \
  && adduser -S -G veto -H veto \
  && mkdir -p /app \
  && chown -R veto:veto /app
WORKDIR /app
ENV NODE_ENV=production
# package.json sits above dist so the compiled .js files resolve as ESM.
COPY --from=deps --chown=veto:veto /src/service/package.json ./package.json
COPY --from=deps --chown=veto:veto /src/service/node_modules ./node_modules
COPY --from=build --chown=veto:veto /src/service/dist ./dist
COPY --chown=veto:veto service/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
USER veto
ENTRYPOINT ["docker-entrypoint.sh"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-8080}/v1/health" || exit 1
CMD ["node", "dist/service/src/api/cli.js"]
