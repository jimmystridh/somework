# Reviewer image (context = repository root):
#   docker build -f adapters/reviewer/Dockerfile -t somework-reviewer:<tag> .
# Only the agent (harness) is built here. The sandbox is the developer role's image, `somework-pi-sandbox`
# (docker build -f adapters/pi/Dockerfile --target sandbox): it runs the kit's role-agnostic sandbox daemon, and the reviewer's
# read-only policy lives in the harness, not in the sandbox image. Its sandbox reaches the code host only through the egress proxy (see deploy/README.md).

FROM node:22.22.1-bookworm-slim@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d AS base
ENV NODE_ENV=production NODE_OPTIONS=--disable-warning=ExperimentalWarning
WORKDIR /app

# Dependencies come from the workspace's one lockfile; `-w` installs just this role's tree (the SDK and the agent kit are linked).
# Other roles' manifests are not needed for that.
FROM base AS deps
COPY package.json package-lock.json .npmrc /app/
COPY sdk/typescript/package.json /app/sdk/typescript/
COPY packages/agent-kit/package.json /app/packages/agent-kit/
COPY adapters/reviewer/package.json /app/adapters/reviewer/
RUN npm ci --omit=dev --ignore-scripts -w @somework/reviewer

FROM deps AS app
COPY sdk/typescript/src /app/sdk/typescript/src
COPY packages/agent-kit/src /app/packages/agent-kit/src
COPY adapters/reviewer/src /app/adapters/reviewer/src
COPY adapters/reviewer/card.json /app/adapters/reviewer/card.json
WORKDIR /app/adapters/reviewer
# Everything the service imports must resolve at build time: a dependency missing from the lockfile fails here, not in production.
RUN node --input-type=module -e "for (const name of ['@somework/sdk', '@somework/agent-kit', '@somework/agent-kit/providers/faux', '@somework/agent-kit/providers/antigravity', '@somework/agent-kit/sandbox/remote-env', '@earendil-works/pi-ai', './src/profile.ts', './src/hooks.ts', './src/handler.ts']) await import(name)"

# The harness: holds the SomeWork key and the model credentials, runs Pi Durable, never runs a tool itself.
FROM app AS agent
RUN groupadd --gid 10001 reviewer && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin reviewer \
 && mkdir -p /state && chown 10001:10001 /state
USER 10001:10001
WORKDIR /app/adapters/reviewer
EXPOSE 8081
CMD ["node", "src/main.ts"]
