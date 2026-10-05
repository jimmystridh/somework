# Receiver image (context = repository root):
#   docker build -f packages/events-receiver/Dockerfile -t somework-events-receiver:<tag> .
# No dependencies: only Node's own modules are used, so there is nothing to install.
FROM node:22.22.1-bookworm-slim@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d
ENV NODE_ENV=production NODE_OPTIONS=--disable-warning=ExperimentalWarning
RUN groupadd --gid 10020 receiver && useradd --uid 10020 --gid 10020 --no-create-home --shell /usr/sbin/nologin receiver \
 && mkdir -p /data && chown 10020:10020 /data
WORKDIR /app
COPY packages/events-receiver/package.json /app/package.json
COPY packages/events-receiver/src /app/src
RUN node --input-type=module -e "for (const name of ['./src/config.ts', './src/derive.ts', './src/limits.ts', './src/log.ts', './src/queue.ts', './src/receiver.ts']) await import(name)"
USER 10020:10020
EXPOSE 8080 8443
CMD ["node", "src/main.ts"]
