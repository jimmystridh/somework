# Hub image (context = repository root):
#   docker build -f packages/events-hub/Dockerfile -t somework-events-hub:<tag> .
# Dependencies come from the workspace's one lockfile; `-w` installs just this package's tree (the SDK is linked).
FROM node:22.22.1-bookworm-slim@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d AS base
ENV NODE_ENV=production NODE_OPTIONS=--disable-warning=ExperimentalWarning
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json .npmrc /app/
COPY sdk/typescript/package.json /app/sdk/typescript/
COPY packages/events-hub/package.json /app/packages/events-hub/
RUN npm ci --omit=dev --ignore-scripts -w @somework/events-hub

FROM deps AS app
COPY sdk/typescript/src /app/sdk/typescript/src
COPY packages/events-hub/src /app/packages/events-hub/src
COPY packages/events-hub/mappings /app/packages/events-hub/mappings
WORKDIR /app/packages/events-hub
# Everything the service imports must resolve at build time: a dependency missing from the lockfile fails here, not in production.
RUN node --input-type=module -e "for (const name of ['@somework/sdk', 'jsonata', './src/bootstrap.ts', './src/server.ts', './src/clock.ts']) await import(name)"

FROM app AS hub
RUN groupadd --gid 10021 hub && useradd --uid 10021 --gid 10021 --no-create-home --shell /usr/sbin/nologin hub \
 && mkdir -p /data && chown 10021:10021 /data
USER 10021:10021
EXPOSE 8090
CMD ["node", "src/main.ts"]
