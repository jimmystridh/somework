# Datadog triage images (context = repository root):
#   docker build -f adapters/datadog-triage/Dockerfile --target agent   -t somework-datadog-triage:<tag> .
#   docker build -f adapters/datadog-triage/Dockerfile --target sandbox -t somework-datadog-triage-sandbox:<tag> \
#          --build-arg SANDBOX_BASE=somework-pi-sandbox:<developer sandbox tag> .
# The harness (`agent`) holds the credentials and runs the Datadog tools. The sandbox is where the model runs python3 and jq over saved
# results; it is the developer role's sandbox image (`somework-pi-sandbox`, built from adapters/pi/Dockerfile and not changed by this role)
# plus python3. There is no egress image: this role's sandbox has no route out at all.

FROM node:22.22.1-bookworm-slim@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d AS base
ENV NODE_ENV=production NODE_OPTIONS=--disable-warning=ExperimentalWarning
WORKDIR /app

# Dependencies come from the workspace's one lockfile; `-w` installs just this role's tree (the SDK and the agent kit are linked).
FROM base AS deps
COPY package.json package-lock.json .npmrc /app/
COPY sdk/typescript/package.json /app/sdk/typescript/
COPY packages/agent-kit/package.json /app/packages/agent-kit/
COPY adapters/datadog-triage/package.json /app/adapters/datadog-triage/
RUN npm ci --omit=dev --ignore-scripts -w @somework/datadog-triage

FROM deps AS app
COPY sdk/typescript/src /app/sdk/typescript/src
COPY packages/agent-kit/src /app/packages/agent-kit/src
COPY adapters/datadog-triage/src /app/adapters/datadog-triage/src
COPY adapters/datadog-triage/handlers /app/adapters/datadog-triage/handlers
COPY adapters/datadog-triage/card.json /app/adapters/datadog-triage/card.json
WORKDIR /app/adapters/datadog-triage
# Everything the service imports must resolve at build time: a dependency missing from the lockfile, or a template file that was not copied,
# fails here, not in production. The handler template is rendered once with the default settings and syntax-checked.
RUN node --input-type=module -e "for (const name of ['@somework/sdk', '@somework/agent-kit', '@somework/agent-kit/events', '@somework/agent-kit/providers/antigravity', '@somework/agent-kit/sandbox/remote-env', '@earendil-works/pi-ai', '@earendil-works/pi-durable', '@earendil-works/chord/context', './src/profile.ts', './src/hooks.ts', './src/settings.ts', './src/seed.ts', './src/commands.ts']) await import(name); const { loadSettings } = await import('./src/settings.ts'); const { renderHandler } = await import('./src/seed.ts'); (await import('node:fs')).writeFileSync('/tmp/handler-check.mjs', renderHandler(loadSettings({})))" \
 && node --check /tmp/handler-check.mjs && rm /tmp/handler-check.mjs

# The harness: holds the SomeWork key, the model credentials and the Datadog key file; runs Pi Durable; never runs a tool of the model itself.
FROM app AS agent
RUN groupadd --gid 10001 triage && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin triage \
 && mkdir -p /state && chown 10001:10001 /state
USER 10001:10001
WORKDIR /app/adapters/datadog-triage
EXPOSE 8081
CMD ["node", "src/main.ts"]

# The sandbox: where the model's bash, python3 and jq run. No credentials and no network. The developer sandbox image is the base (its daemon,
# its user, its jq); this adds python3 (standard library only: there is no pip and no route to a package index) and checks it works.
ARG SANDBOX_BASE=somework-pi-sandbox:latest
FROM ${SANDBOX_BASE} AS sandbox
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 jq \
 && rm -rf /var/lib/apt/lists/* \
 && python3 -c "import json, csv, statistics, datetime, collections, re, math, itertools" \
 && jq --version
USER 10002:10002
