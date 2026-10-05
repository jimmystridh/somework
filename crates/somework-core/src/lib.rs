//! SomeWork core: contracts, task state machine, schema validation and shared primitives.
//! Everything here is pure (no I/O) so it can be shared by the domain service, SDK, sidecar and gateway.

pub mod canonical;
pub mod classification;
pub mod clock;
pub mod contracts;
pub mod error;
pub mod fsm;
pub mod ids;
pub mod jws;
pub mod schema;
pub mod subjects;
pub mod taxonomy;
pub mod trace;

pub use error::{Error, ErrorCode, Result};
