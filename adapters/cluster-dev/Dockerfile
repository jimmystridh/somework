# Cluster development agent image (context = repository root):
#   docker build -f adapters/cluster-dev/Dockerfile --target agent -t somework-cluster-dev:<tag> .
# Only the agent (harness) is built here. The sandbox and the egress proxy are the developer role's images, `somework-pi-sandbox` and
# `somework-pi-egress` (docker build -f adapters/pi/Dockerfile --target sandbox|egress): the sandbox daemon is role-agnostic and the
# classifier that decides what needs the owner runs in this harness, not in the sandbox.

FROM node:22.22.1-bookworm-slim@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d AS base
ENV NODE_ENV=production NODE_OPTIONS=--disable-warning=ExperimentalWarning
WORKDIR /app

# Dependencies come from the workspace's one lockfile; `-w` installs just this role's tree (the SDK and the agent kit are linked).
FROM base AS deps
COPY package.json package-lock.json .npmrc /app/
COPY sdk/typescript/package.json /app/sdk/typescript/
COPY packages/agent-kit/package.json /app/packages/agent-kit/
COPY adapters/cluster-dev/package.json /app/adapters/cluster-dev/
RUN npm ci --omit=dev --ignore-scripts -w @somework/cluster-dev

FROM deps AS app
COPY sdk/typescript/src /app/sdk/typescript/src
COPY packages/agent-kit/src /app/packages/agent-kit/src
COPY adapters/cluster-dev/src /app/adapters/cluster-dev/src
COPY adapters/cluster-dev/card.json /app/adapters/cluster-dev/card.json
WORKDIR /app/adapters/cluster-dev
# Everything the service imports must resolve at build time: a dependency missing from the lockfile fails here, not in production.
RUN node --input-type=module -e "for (const name of ['@somework/sdk', '@somework/agent-kit', '@somework/agent-kit/providers/faux', '@somework/agent-kit/providers/antigravity', '@somework/agent-kit/events', '@somework/agent-kit/sandbox/remote-env', '@earendil-works/pi-ai', '@earendil-works/pi-durable', './src/profile.ts', './src/hooks.ts', './src/classifier/index.ts']) await import(name)"

# The harness: holds the SomeWork key, the model credentials, the ssh keys of the hosts and the tokens; runs Pi Durable; never runs a tool of
# the model itself. It needs an ssh client for host_exec (the keys, the known hosts and the options all come from the settings).
FROM app AS agent
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-client \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10001 cluster-dev && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin cluster-dev \
 && mkdir -p /state && chown 10001:10001 /state
USER 10001:10001
WORKDIR /app/adapters/cluster-dev
EXPOSE 8081
CMD ["node", "src/main.ts"]
