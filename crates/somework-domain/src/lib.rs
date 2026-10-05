//! SomeWork domain service: canonical state (SQLite), policy, tasks, messages, catalog, context and artifacts.

pub mod admin;
pub mod artifacts;
pub mod audit;
pub mod auth;
pub mod backup;
pub mod catalog;
pub mod config;
pub mod context;
pub mod db;
pub mod directory;
pub mod domain;
pub mod events;
pub mod failpoints;
pub mod federation;
pub mod idempotency;
pub mod matrix_crypto;
pub mod messages;
pub mod metrics;
pub mod objects;
pub mod objects_s3;
pub mod ops;
pub mod outbox;
pub mod policy;
pub mod runtimes;
pub mod sealed;
pub mod secrets;
pub mod streams;
pub mod subscriptions;
pub mod summary;
pub mod tasks;
pub mod transport;

pub use domain::{Actor, Ctx, Domain};
