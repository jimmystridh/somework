//! SomeWork sidecar: MCP server and worker runtime over the REST SDK. The agent runtime talks to
//! the sidecar (stdio/localhost); the sidecar talks to the domain over outbound HTTPS and, optionally, NATS.
//! Infrastructure credentials never enter the model context.

pub mod backoff;
pub mod config;
pub mod extended;
pub mod keyfile;
pub mod mcp;
pub mod tls;
pub mod worker;
