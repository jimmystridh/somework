# Pi agent images (context = repository root):
#   docker build -f adapters/pi/Dockerfile --target agent   -t somework-pi-agent:<tag>   .
#   docker build -f adapters/pi/Dockerfile --target sandbox -t somework-pi-sandbox:<tag> .
#   docker build -f adapters/pi/Dockerfile --target egress  -t somework-pi-egress:<tag>  .
# One Node base, pinned by digest. The three images run as three different users and never share a filesystem.

FROM node:22.22.1-bookworm-slim@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d AS base
ENV NODE_ENV=production NODE_OPTIONS=--disable-warning=ExperimentalWarning
WORKDIR /app

FROM base AS deps
COPY sdk/typescript /app/sdk/typescript
COPY adapters/pi/package.json adapters/pi/package-lock.json adapters/pi/.npmrc /app/adapters/pi/
WORKDIR /app/adapters/pi
RUN npm ci --omit=dev --ignore-scripts

FROM deps AS app
COPY adapters/pi/src /app/adapters/pi/src
COPY adapters/pi/card.json /app/adapters/pi/card.json

# The harness: holds the SomeWork key and the model credentials, runs Pi Durable, never runs a tool itself.
FROM app AS agent
RUN groupadd --gid 10001 pi && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin pi \
 && mkdir -p /state && chown 10001:10001 /state
USER 10001:10001
WORKDIR /app/adapters/pi
EXPOSE 8081
CMD ["node", "src/main.ts"]

# The sandbox: where the model's tools run. No credentials, no route out except the egress proxy.
FROM app AS sandbox
RUN apt-get update \
 && apt-get install -y --no-install-recommends git bash curl ca-certificates ripgrep jq make \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10002 sandbox && useradd --uid 10002 --gid 10002 --no-create-home --home-dir /workspace --shell /bin/bash sandbox \
 && mkdir -p /workspace && chown 10002:10002 /workspace
USER 10002:10002
ENV HOME=/workspace
WORKDIR /app/adapters/pi
EXPOSE 7070
CMD ["node", "src/sandbox/main.ts"]

# The egress proxy: the sandbox network's only way out, with a host allowlist.
FROM app AS egress
RUN groupadd --gid 10003 egress && useradd --uid 10003 --gid 10003 --no-create-home --shell /usr/sbin/nologin egress
USER 10003:10003
WORKDIR /app/adapters/pi
EXPOSE 8888
CMD ["node", "src/egress/main.ts"]
