use std::sync::Arc;

use somework_domain::Domain;

use crate::oidc::OidcVerifier;

#[derive(Clone)]
pub struct AppState {
    pub domain: Domain,
    pub oidc: Option<Arc<OidcVerifier>>,
    pub streams: Option<Arc<dyn somework_domain::streams::StreamSource>>,
    pub connection: Option<Arc<dyn somework_domain::streams::ConnectionProvider>>,
    /// Directory with the operations UI assets (served under `/ui`).
    pub ui_dir: Option<std::path::PathBuf>,
    /// Public base URL used in links handed to clients.
    pub public_url: String,
    pub allow_failpoint_admin: bool,
    pub ui: Option<Arc<crate::ui_session::UiState>>,
    /// Present when artifacts are stored on the local filesystem (presigned PUT/GET are served by this process).
    pub fs_store: Option<Arc<somework_domain::objects::FsObjectStore>>,
    /// Federation/A2A administration, present when `[gateway]` is configured.
    pub gateway: Option<Arc<somework_gateway::GatewayAdmin>>,
}

impl AppState {
    pub fn new(domain: Domain) -> Self {
        let public_url = domain.cfg.public_url.clone();
        Self {
            domain,
            oidc: None,
            streams: None,
            connection: None,
            ui_dir: None,
            public_url,
            allow_failpoint_admin: false,
            ui: None,
            fs_store: None,
            gateway: None,
        }
    }
}
