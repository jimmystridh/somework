mod admin;
mod artifacts;
mod catalog;
mod events;
mod messages;
mod rules;
mod runtimes;
mod sealed;
mod system;
mod ui;

use axum::Router;

use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .merge(system::routes())
        .merge(catalog::routes())
        .merge(messages::routes())
        .merge(artifacts::routes())
        .merge(events::routes())
        .merge(rules::routes())
        .merge(runtimes::routes())
        .merge(sealed::routes())
        .merge(admin::routes())
        .merge(ui::routes())
}
