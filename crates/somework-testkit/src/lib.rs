//! Shared integration-test harness: in-process SomeWork stacks, enrolled principals and helpers for real
//! infrastructure processes (NATS/JetStream, MinIO) under `tools/bin`.

pub mod e2ee;
pub mod federation;
pub mod matrix;
pub mod minio;
pub mod nats;
pub mod oidc;
pub mod pki;
pub mod process;
pub mod sidecar;
pub mod stack;

pub use stack::{Agent, Human, Stack, StackBuilder, capability, card};
