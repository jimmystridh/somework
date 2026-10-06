# Aikido fixer image (context = repository root):
#   docker build -f adapters/aikido-fixer/Dockerfile -t somework-aikido-fixer:<tag> .
# Only the agent (harness) is built here. The sandbox and the egress proxy are the developer role's images (`somework-pi-sandbox`,
# `somework-pi-egress`, built from adapters/pi/Dockerfile with --target sandbox and --target egress): the sandbox daemon is role-agnostic,
# and what this role may do lives in the harness (its profile and hooks), not in the sandbox image.

FROM node:22.22.1-bookworm-slim@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d AS base
ENV NODE_ENV=production NODE_OPTIONS=--disable-warning=ExperimentalWarning
WORKDIR /app

# Dependencies come from the workspace's one lockfile; `-w` installs just this role's tree (the SDK and the agent kit are linked).
FROM base AS deps
COPY package.json package-lock.json .npmrc /app/
COPY sdk/typescript/package.json /app/sdk/typescript/
COPY packages/agent-kit/package.json /app/packages/agent-kit/
COPY adapters/aikido-fixer/package.json /app/adapters/aikido-fixer/
RUN npm ci --omit=dev --ignore-scripts -w @somework/aikido-fixer

FROM deps AS app
COPY sdk/typescript/src /app/sdk/typescript/src
COPY packages/agent-kit/src /app/packages/agent-kit/src
COPY adapters/aikido-fixer/src /app/adapters/aikido-fixer/src
COPY adapters/aikido-fixer/handlers /app/adapters/aikido-fixer/handlers
COPY adapters/aikido-fixer/card.json /app/adapters/aikido-fixer/card.json
WORKDIR /app/adapters/aikido-fixer
# Everything the service imports must resolve at build time: a dependency missing from the lockfile, or a template file that was not copied,
# fails here, not in production. The handler template is rendered once with sample settings and syntax-checked.
RUN node --input-type=module -e "for (const name of ['@somework/sdk', '@somework/agent-kit', '@somework/agent-kit/events', '@somework/agent-kit/providers/antigravity', '@somework/agent-kit/sandbox/remote-env', '@earendil-works/pi-ai', '@earendil-works/pi-durable', '@earendil-works/chord/context', './src/profile.ts', './src/hooks.ts', './src/settings.ts', './src/seed.ts']) await import(name); const { loadSettings } = await import('./src/settings.ts'); const { renderHandler } = await import('./src/seed.ts'); (await import('node:fs')).writeFileSync('/tmp/handler-check.mjs', renderHandler(loadSettings({ AIKIDO_REPOSITORY_URL: 'https://github.com/example/example.git' })))" \
 && node --check /tmp/handler-check.mjs && rm /tmp/handler-check.mjs

# The harness: holds the SomeWork key, the model credentials, the code-host token and the Aikido client file; runs Pi Durable; never runs a tool itself.
FROM app AS agent
RUN groupadd --gid 10001 fixer && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin fixer \
 && mkdir -p /state && chown 10001:10001 /state
USER 10001:10001
WORKDIR /app/adapters/aikido-fixer
EXPOSE 8081
CMD ["node", "src/main.ts"]
