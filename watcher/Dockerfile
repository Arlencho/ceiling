# Node 22 is the floor the READMEs document and the version CI runs.
# The image carries the watcher and the bundled IDL. It carries no key,
# no RPC endpoint, and no account. Those arrive at run time as env and
# a Secret Manager mount.

FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
# ws optional addons (utf-8-validate, bufferutil) run node-gyp on install.
# Alpine has no compiler here; the JS fallback is enough for this job.
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY idl ./idl
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
RUN addgroup -S veto \
  && adduser -S -G veto -H veto \
  && mkdir -p /app /tmp/veto \
  && chown -R veto:veto /app /tmp/veto
WORKDIR /app
COPY --from=build --chown=veto:veto /src/package.json /src/package-lock.json ./
COPY --from=build --chown=veto:veto /src/node_modules ./node_modules
COPY --from=build --chown=veto:veto /src/dist ./dist
COPY --from=build --chown=veto:veto /src/idl ./idl
USER veto
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=2 \
  CMD node -e "require('node:fs').accessSync('/app/dist/index.js')"
CMD ["node", "dist/index.js", "once"]
