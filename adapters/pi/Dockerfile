# Pi agent images (context = repository root):
#   docker build -f adapters/pi/Dockerfile --target agent   -t somework-pi-agent:<tag>   .
#   docker build -f adapters/pi/Dockerfile --target sandbox -t somework-pi-sandbox:<tag> .
#   docker build -f adapters/pi/Dockerfile --target egress  -t somework-pi-egress:<tag>  .
# One Node base, pinned by digest. The three images run as three different users and never share a filesystem.

FROM node:22.22.1-bookworm-slim@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d AS base
ENV NODE_ENV=production NODE_OPTIONS=--disable-warning=ExperimentalWarning
WORKDIR /app

# Dependencies come from the workspace's one lockfile. Only the workspaces' manifests are copied first, so this layer is cached
# until a dependency changes. `-w` installs just this role's dependency tree (the SDK and the agent kit are linked, not downloaded).
FROM base AS deps
COPY package.json package-lock.json .npmrc /app/
COPY sdk/typescript/package.json /app/sdk/typescript/
COPY packages/agent-kit/package.json /app/packages/agent-kit/
COPY adapters/pi/package.json /app/adapters/pi/
COPY adapters/manager/package.json /app/adapters/manager/
RUN npm ci --omit=dev --ignore-scripts -w @somework/pi-agent

FROM deps AS app
COPY sdk/typescript/src /app/sdk/typescript/src
COPY packages/agent-kit/src /app/packages/agent-kit/src
COPY adapters/pi/src /app/adapters/pi/src
COPY adapters/pi/card.json /app/adapters/pi/card.json
WORKDIR /app/adapters/pi
# Everything the three images run must import at build time: a dependency that is missing from the lockfile fails here, not in production.
RUN node --input-type=module -e "for (const name of ['@somework/sdk', '@somework/agent-kit', '@somework/agent-kit/sandbox/server', '@somework/agent-kit/egress/proxy', '@somework/agent-kit/providers/antigravity', '@somework/agent-kit/events', './src/profile.ts']) await import(name)"

# The harness: holds the SomeWork key and the model credentials, runs Pi Durable, never runs a tool itself.
FROM app AS agent
RUN groupadd --gid 10001 pi && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin pi \
 && mkdir -p /state && chown 10001:10001 /state
USER 10001:10001
WORKDIR /app/adapters/pi
EXPOSE 8081
CMD ["node", "src/main.ts"]

# The sandbox: where the model's tools run. No credentials, no route out except the egress proxy.
# bun, pinned like the CI image, so a role can build and test the many repositories that use it (the egress proxy decides what it may download)
FROM oven/bun@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS bun

FROM app AS sandbox
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s bun /usr/local/bin/bunx
# python3 and ps: the scripts of the repositories this role works on call them (the httpyac runners, process checks)
RUN apt-get update \
 && apt-get install -y --no-install-recommends git bash curl ca-certificates ripgrep jq make python3 procps \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10002 sandbox && useradd --uid 10002 --gid 10002 --no-create-home --home-dir /workspace --shell /bin/bash sandbox \
 && mkdir -p /workspace && chown 10002:10002 /workspace
# the GitHub CLI, pinned and checked; the wrapper below uses a read-only token when a deployment mounts one (otherwise it is unauthenticated)
ARG GH_VERSION=2.102.0
ARG GH_SHA256=bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386
RUN curl -fsSL -o /tmp/gh.tgz "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
 && echo "${GH_SHA256}  /tmp/gh.tgz" | sha256sum -c - \
 && mkdir -p /usr/local/lib/gh \
 && tar -xzf /tmp/gh.tgz -C /usr/local/lib/gh --strip-components=2 "gh_${GH_VERSION}_linux_amd64/bin/gh" \
 && rm /tmp/gh.tgz
COPY adapters/pi/sandbox/gh /usr/local/bin/gh
USER 10002:10002
ENV HOME=/workspace
WORKDIR /app/adapters/pi
EXPOSE 7070
CMD ["node", "/app/packages/agent-kit/src/sandbox/main.ts"]

# The egress proxy: the sandbox network's only way out, with a host allowlist.
FROM app AS egress
RUN groupadd --gid 10003 egress && useradd --uid 10003 --gid 10003 --no-create-home --shell /usr/sbin/nologin egress
USER 10003:10003
WORKDIR /app/adapters/pi
EXPOSE 8888
CMD ["node", "/app/packages/agent-kit/src/egress/main.ts"]
