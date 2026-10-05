mod admin;
mod artifacts;
mod catalog;
mod context;
mod events;
mod federation_admin;
mod messages;
mod runtimes;
mod sealed;
mod system;
mod tasks;
mod ui;

use axum::Router;

use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .merge(system::routes())
        .merge(catalog::routes())
        .merge(messages::routes())
        .merge(tasks::routes())
        .merge(context::routes())
        .merge(artifacts::routes())
        .merge(events::routes())
        .merge(runtimes::routes())
        .merge(sealed::routes())
        .merge(admin::routes())
        .merge(federation_admin::routes())
        .merge(ui::routes())
}
