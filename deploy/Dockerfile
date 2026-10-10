# Builds the pilot server image from one workspace checkout (context = repository root):
#   docker build -f deploy/Dockerfile --target server -t somework-server:<tag> .
# Base images are pinned by index digest. Bump the digests deliberately, not implicitly.

FROM rust:1.96-slim-bookworm@sha256:e18a79fc84dfcfc3ab5ba72290398a644c135c97eaa881447fddc354ee4701a3 AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential cmake perl pkg-config \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p somework-api \
 && mkdir /out \
 && cp target/release/somework /out/

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
