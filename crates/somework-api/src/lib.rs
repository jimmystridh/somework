//! SomeWork REST API (axum) over the domain service.

pub mod backup;
pub mod cli;
pub mod config;
pub mod grpc;
pub mod http;
pub mod oidc;
pub mod routes;
pub mod runner;
pub mod server;
pub mod state;
pub mod ui_session;
pub mod wiring;

pub use state::AppState;
