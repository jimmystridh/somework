# Builds the two pilot images from one workspace checkout (context = repository root):
#   docker build -f deploy/Dockerfile --target server -t somework-server:<tag> .
#   docker build -f deploy/Dockerfile --target worker -t somework-worker:<tag> .
# Base images are pinned by index digest. Bump the digests deliberately, not implicitly.

FROM rust:1.96-slim-bookworm@sha256:e18a79fc84dfcfc3ab5ba72290398a644c135c97eaa881447fddc354ee4701a3 AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential cmake perl pkg-config \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p somework-api -p somework-sidecar \
 && mkdir /out \
 && cp target/release/somework target/release/somework-sidecar /out/

FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251 AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10001 somework \
 && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin somework \
 && mkdir -p /data /workspace \
 && chown 10001:10001 /data /workspace

# The domain: REST/gRPC API, outbox, optional NATS plane. TLS is terminated by the proxy in front of it.
FROM base AS server
COPY --from=build /out/somework /usr/local/bin/somework
COPY ui /opt/somework/ui
USER 10001:10001
WORKDIR /data
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/somework"]
CMD ["serve", "--config", "/etc/somework/somework.toml"]

# The worker: the sidecar only. Derive from this image (or mount a read-only directory) to add your executor, and name it
# in the worker config. The executor runs with the sidecar's user and filesystem; see deploy/README.md before widening it.
FROM base AS worker
COPY --from=build /out/somework-sidecar /usr/local/bin/somework-sidecar
USER 10001:10001
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/somework-sidecar"]
CMD ["run", "--mode", "worker"]

# Smoke-test worker with the example reviewer agent. Not for real work.
FROM worker AS worker-demo
USER root
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
COPY examples/reviewer-agent.py /opt/executors/reviewer-agent.py
USER 10001:10001
