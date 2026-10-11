mod api;
mod components;
mod format;
mod history;
mod live;
mod ops;
mod session;
mod shell;
mod somework;
mod widgets;

use dioxus::{history::provide_history_context, prelude::*, web::WebHistory};
use ops::{
    agent_page::{AgentPage, AgentTab},
    agents::Agents,
    audit::Audit,
    catalog::Catalog,
    library::Library,
    limits::Limits,
    users::Users,
};
use session::{Access, Session};
use shell::{HistoryPage, MachinesPage, NotFound, Shell, SomeWorkPage, UsagePage};
use std::rc::Rc;

/// Where the server serves the bundle; the same as `base_path` of `Dioxus.toml`.
const BASE_PATH: &str = "/fleet";

fn main() {
    dioxus::launch(App);
}

/// The bundle is served under `/fleet/` (the router takes that prefix from the build), so the server must answer every path below it
/// with `index.html` for a deep link to load.
#[derive(Clone, Debug, PartialEq, Routable)]
#[rustfmt::skip]
pub enum Route {
    #[layout(Shell)]
        #[route("/")]
        Agents {},
        #[redirect("/agents/:slug", |slug: String| Route::AgentPage { slug, tab: AgentTab::Overview })]
        #[route("/agents/:slug/:tab")]
        AgentPage { slug: String, tab: AgentTab },
        #[route("/catalog")]
        Catalog {},
        #[route("/library")]
        Library {},
        #[route("/limits")]
        Limits {},
        #[route("/users")]
        Users {},
        #[route("/audit")]
        Audit {},
        #[route("/somework")]
        SomeWorkPage {},
        #[route("/history")]
        HistoryPage {},
        #[route("/usage")]
        UsagePage {},
        #[route("/machines")]
        MachinesPage {},
        #[route("/:..segments")]
        NotFound { segments: Vec<String> },
}

#[component]
fn App() -> Element {
    live::use_live_provider();
    let access = use_signal(|| Access::Loading);
    use_context_provider(|| Session(access));
    use_hook(|| provide_history_context(Rc::new(WebHistory::new(Some(BASE_PATH.to_string()), true))));
    rsx! { Router::<Route> {} }
}
