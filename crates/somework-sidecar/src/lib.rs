//! SomeWork sidecar: an MCP server over the REST SDK. The agent runtime talks to the sidecar
//! (stdio/localhost); the sidecar talks to the domain over outbound HTTPS.
//! Infrastructure credentials never enter the model context.

pub mod config;
pub mod extended;
pub mod keyfile;
pub mod mcp;
pub mod tls;
