# Build from the repository root: the server uses crates/somework-client (and, through it, crates/somework-core) by path.
#   docker build -f dashboard/Dockerfile -t agent-cluster-fleet:<version> .
# The third-party dependencies are compiled in their own layer, from the manifests and the lockfile alone: a change to a source file recompiles
# only the workspace crates. Cargo decides what is stale by modification time, and COPY keeps the times of the build context, so the real sources are
# touched before the final build; without that cargo would keep the stub it compiled for the dependency layer.
FROM rust:1.94.0-slim-bookworm@sha256:a86cada82e36ebd7a9bffed7548792c55a952fdb20718eea9278a936bcb76e62 AS builder
WORKDIR /build
COPY Cargo.toml ./Cargo.toml
COPY crates/somework-core/Cargo.toml crates/somework-core/Cargo.toml
COPY crates/somework-client/Cargo.toml crates/somework-client/Cargo.toml
COPY dashboard/Cargo.toml dashboard/Cargo.lock dashboard/
COPY dashboard/shared/Cargo.toml dashboard/shared/Cargo.toml
COPY dashboard/server/Cargo.toml dashboard/server/Cargo.toml
COPY dashboard/ui/Cargo.toml dashboard/ui/Cargo.toml
RUN mkdir -p crates/somework-core/src crates/somework-client/src dashboard/shared/src dashboard/server/src dashboard/ui/src \
    && touch crates/somework-core/src/lib.rs crates/somework-client/src/lib.rs dashboard/shared/src/lib.rs \
    && echo 'fn main() {}' | tee dashboard/server/src/main.rs > dashboard/ui/src/main.rs
WORKDIR /build/dashboard
RUN cargo build --locked --release --package fleet-server --jobs 2

WORKDIR /build
COPY crates/somework-core crates/somework-core
COPY crates/somework-client crates/somework-client
COPY dashboard/shared dashboard/shared
COPY dashboard/server dashboard/server
WORKDIR /build/dashboard
RUN find ../crates/somework-core ../crates/somework-client shared server -name '*.rs' -exec touch {} + \
    && cargo build --locked --release --package fleet-server --jobs 2

FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251
RUN apt-get update && apt-get install --no-install-recommends -y ca-certificates && apt-get clean
WORKDIR /app
COPY --from=builder /build/dashboard/target/release/fleet-server /app/fleet-server
COPY dashboard/bundle /app/public
USER 1000:1000
EXPOSE 8443
CMD ["/app/fleet-server"]
