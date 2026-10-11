# Build from the repository root: the server uses crates/somework-client (and, through it, crates/somework-core) by path.
#   docker build -f dashboard/Dockerfile -t agent-cluster-fleet:<version> .
FROM rust:1.94.0-slim-bookworm@sha256:a86cada82e36ebd7a9bffed7548792c55a952fdb20718eea9278a936bcb76e62 AS builder
WORKDIR /build
COPY Cargo.toml ./Cargo.toml
COPY crates crates
COPY dashboard dashboard
WORKDIR /build/dashboard
RUN cargo build --locked --release --package fleet-server --jobs 2

FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251
RUN apt-get update && apt-get install --no-install-recommends -y ca-certificates && apt-get clean
WORKDIR /app
COPY --from=builder /build/dashboard/target/release/fleet-server /app/fleet-server
COPY dashboard/bundle /app/public
USER 1000:1000
EXPOSE 8443
CMD ["/app/fleet-server"]
