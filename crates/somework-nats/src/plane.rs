use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use async_nats::jetstream::{
    self,
    consumer::{AckPolicy, DeliverPolicy, pull},
    stream::{Config as StreamConfig, RetentionPolicy, StorageType},
};
use parking_lot::Mutex;
use somework_core::{Error, subjects};
use somework_domain::Domain;
use tokio_util::sync::CancellationToken;

use crate::{
    conf::{AgentGrant, CredentialSecret, NatsConfigGenerator, subscription_consumer, write_private},
    config::NatsConfig,
};

/// A durable consumer the plane maintains.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ConsumerKey {
    pub stream: &'static str,
    pub name: String,
}

#[derive(Default)]
struct PlaneState {
    consumers: HashMap<ConsumerKey, String>,
    streams_epoch: u64,
    last_verify: Option<Instant>,
    users_hash: Option<String>,
    known_users: HashSet<String>,
}

pub struct NatsPlane {
    pub cfg: NatsConfig,
    pub domain: Domain,
    pub client: async_nats::Client,
    pub js: jetstream::Context,
    pub generator: NatsConfigGenerator,
    epoch: Arc<AtomicU64>,
    state: Mutex<PlaneState>,
    reconcile_lock: tokio::sync::Mutex<()>,
}

/// The process links two rustls providers (aws-lc-rs via reqwest, ring via async-nats), so rustls cannot choose a default
/// itself and would panic at the first TLS handshake. Idempotent.
pub fn install_crypto_provider() {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
}

/// The TLS policy for every connection the domain opens to the broker.
pub fn apply_tls(mut opts: async_nats::ConnectOptions, cfg: &NatsConfig) -> async_nats::ConnectOptions {
    install_crypto_provider();
    if let Some(ca) = &cfg.tls_ca_file {
        opts = opts.add_root_certificates(ca.clone());
    }
    if cfg.tls_required {
        opts = opts.require_tls(true);
    }
    opts
}

pub async fn connect(cfg: &NatsConfig, url: &str, user: Option<(&str, &str)>, name: &str, epoch: Option<Arc<AtomicU64>>) -> Result<async_nats::Client, Error> {
    let mut opts = match (user, &cfg.creds_file) {
        (Some((u, p)), _) => async_nats::ConnectOptions::with_user_and_password(u.to_string(), p.to_string()),
        (None, Some(creds)) => async_nats::ConnectOptions::with_credentials_file(creds).await.map_err(|e| Error::internal(format!("nats credentials: {e}")))?,
        (None, None) => async_nats::ConnectOptions::new(),
    };
    opts = opts.name(name).retry_on_initial_connect().connection_timeout(Duration::from_secs(5)).max_reconnects(None);
    opts = apply_tls(opts, cfg);
    if let Some(epoch) = epoch {
        opts = opts.event_callback(move |event| {
            let epoch = epoch.clone();
            async move {
                if matches!(event, async_nats::Event::Connected) {
                    epoch.fetch_add(1, Ordering::SeqCst);
                }
            }
        });
    }
    opts.connect(url).await.map_err(|e| Error::unavailable(format!("nats connect: {e}")))
}

fn stream_config(cfg: &NatsConfig, name: &str, subjects: &[&str], days: u64) -> StreamConfig {
    StreamConfig {
        name: name.to_string(),
        subjects: subjects.iter().map(|s| s.to_string()).collect(),
        retention: RetentionPolicy::Limits,
        storage: StorageType::File,
        max_age: Duration::from_secs(days * 86_400),
        duplicate_window: Duration::from_secs(cfg.dedupe_window_secs),
        num_replicas: cfg.replicas,
        ..Default::default()
    }
}

impl NatsPlane {
    pub async fn new(domain: Domain, cfg: NatsConfig) -> Result<Arc<Self>, Error> {
        let epoch = Arc::new(AtomicU64::new(0));
        let creds = cfg.user.as_deref().zip(cfg.password.as_deref());
        let client = connect(&cfg, &cfg.url, creds, "somework-domain-service", Some(epoch.clone())).await?;
        let js = jetstream::new(client.clone());
        let generator = NatsConfigGenerator::new(CredentialSecret::from_master_key(&domain.master.to_b64()));
        Ok(Arc::new(Self { cfg, domain, client, js, generator, epoch, state: Mutex::new(PlaneState::default()), reconcile_lock: tokio::sync::Mutex::new(()) }))
    }

    pub fn is_connected(&self) -> bool {
        self.client.connection_state() == async_nats::connection::State::Connected
    }

    pub fn work_filter_for(pool: &str) -> String {
        subjects::work_pool(pool)
    }

    async fn ensure_stream(&self, desired: StreamConfig) -> Result<(), Error> {
        let mut stream = self.js.get_or_create_stream(desired.clone()).await.map_err(|e| Error::unavailable(format!("create stream {}: {e}", desired.name)))?;
        let info = stream.info().await.map_err(|e| Error::unavailable(format!("stream info: {e}")))?;
        let c = &info.config;
        if c.max_age != desired.max_age
            || c.duplicate_window != desired.duplicate_window
            || c.num_replicas != desired.num_replicas
            || c.subjects != desired.subjects
        {
            self.js.update_stream(desired.clone()).await.map_err(|e| Error::unavailable(format!("update stream {}: {e}", desired.name)))?;
        }
        Ok(())
    }

    pub async fn ensure_streams(&self) -> Result<(), Error> {
        let c = &self.cfg;
        self.ensure_stream(stream_config(c, subjects::STREAM_WORK, &[subjects::WORK_FILTER], c.work_max_age_days)).await?;
        self.ensure_stream(stream_config(c, subjects::STREAM_INBOX, &[subjects::INBOX_FILTER], c.inbox_max_age_days)).await?;
        self.ensure_stream(stream_config(c, subjects::STREAM_EVENTS, &[subjects::EVENT_FILTER], c.events_max_age_days)).await?;
        self.ensure_stream(stream_config(c, subjects::STREAM_SUBSCRIPTIONS, &[subjects::SUBSCRIPTION_FILTER], c.subscriptions_max_age_days)).await?;
        Ok(())
    }

    fn consumer_config(&self, name: &str, filters: Vec<String>) -> pull::Config {
        let mut cfg = pull::Config {
            durable_name: Some(name.to_string()),
            ack_policy: AckPolicy::Explicit,
            deliver_policy: DeliverPolicy::All,
            ack_wait: Duration::from_secs(self.cfg.ack_wait_secs),
            max_deliver: self.cfg.max_deliver,
            ..Default::default()
        };
        if filters.len() == 1 {
            cfg.filter_subject = filters[0].clone();
        } else {
            cfg.filter_subjects = filters;
        }
        cfg
    }

    async fn ensure_consumer(&self, stream: &'static str, name: &str, filters: Vec<String>, force: bool) -> Result<(), Error> {
        let key = ConsumerKey { stream, name: name.to_string() };
        let fingerprint = filters.join("|");
        if !force && self.state.lock().consumers.get(&key) == Some(&fingerprint) {
            return Ok(());
        }
        let stream_handle = self.js.get_stream(stream).await.map_err(|e| Error::unavailable(format!("get stream {stream}: {e}")))?;
        let cfg = self.consumer_config(name, filters);
        match stream_handle.get_consumer::<pull::Config>(name).await {
            Ok(mut existing) => {
                let current = existing.info().await.map_err(|e| Error::unavailable(format!("consumer info: {e}")))?;
                let mut current_filters = current.config.filter_subjects.clone();
                if !current.config.filter_subject.is_empty() {
                    current_filters.push(current.config.filter_subject.clone());
                }
                let mut wanted = cfg.filter_subjects.clone();
                if !cfg.filter_subject.is_empty() {
                    wanted.push(cfg.filter_subject.clone());
                }
                current_filters.sort();
                wanted.sort();
                if current_filters != wanted {
                    stream_handle.update_consumer(cfg).await.map_err(|e| Error::unavailable(format!("update consumer {name}: {e}")))?;
                }
            }
            Err(_) => {
                stream_handle.create_consumer(cfg).await.map_err(|e| Error::unavailable(format!("create consumer {name}: {e}")))?;
            }
        }
        self.state.lock().consumers.insert(key, fingerprint);
        Ok(())
    }

    async fn directory_grants(&self) -> Result<Vec<AgentGrant>, Error> {
        let mut pools: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for id in self.domain.agent_principals().await? {
            pools.entry(id.clone()).or_default().push(id);
        }
        for entry in self.domain.agent_directory().await? {
            let p = pools.entry(entry.agent_id.clone()).or_default();
            p.clear();
            p.push(entry.pool_id);
        }
        Ok(pools.into_iter().map(|(agent_id, pools)| AgentGrant { agent_id, pools }).collect())
    }

    async fn sync_users(&self, grants: &[AgentGrant]) -> Result<bool, Error> {
        let Some(path) = &self.cfg.users_file else { return Ok(false) };
        let admin_user = self.cfg.user.clone().unwrap_or_else(|| "somework-domain".into());
        let admin_password = self.cfg.password.clone().unwrap_or_default();
        let fragment = self.generator.users_fragment(&admin_user, &admin_password, grants);
        let hash = somework_core::canonical::sha256_hex(fragment.as_bytes());
        if self.state.lock().users_hash.as_deref() == Some(hash.as_str()) {
            return Ok(false);
        }
        write_private(path, &fragment).map_err(|e| Error::internal(format!("write nats users file: {e}")))?;
        if let Some(cmd) = &self.cfg.reload_command
            && let Some((program, args)) = cmd.split_first()
        {
            let status = tokio::process::Command::new(program).args(args).status().await.map_err(|e| Error::internal(format!("nats reload command: {e}")))?;
            if !status.success() {
                return Err(Error::internal(format!("nats reload command failed: {status}")));
            }
        }
        let mut st = self.state.lock();
        st.users_hash = Some(hash);
        st.known_users = grants.iter().map(|g| g.agent_id.clone()).collect();
        Ok(true)
    }

    /// One idempotent pass: users file (+reload), streams, per-pool / per-agent / subscription consumers.
    pub async fn reconcile_once(&self) -> Result<(), Error> {
        let _guard = self.reconcile_lock.lock().await;
        let grants = self.directory_grants().await?;
        self.sync_users(&grants).await?;
        if !self.cfg.provision || !self.is_connected() {
            return Ok(());
        }
        let epoch = self.epoch.load(Ordering::SeqCst);
        let mut force = false;
        {
            let mut st = self.state.lock();
            let stale = st.last_verify.is_none_or(|t| t.elapsed() > Duration::from_secs(15));
            if st.streams_epoch != epoch || stale {
                force = true;
                st.consumers.clear();
            }
        }
        if force {
            self.ensure_streams().await?;
            let mut st = self.state.lock();
            st.streams_epoch = epoch;
            st.last_verify = Some(Instant::now());
        }
        let subs = self.domain.agent_subscriptions().await?;
        let mut sub_filters: HashMap<String, Vec<String>> = HashMap::new();
        for s in subs {
            sub_filters.entry(s.agent_id).or_default().push(subjects::subscription(&s.subscription_id));
        }
        let mut pools = HashSet::new();
        for g in &grants {
            self.ensure_consumer(subjects::STREAM_INBOX, &subjects::inbox_consumer(&g.agent_id), vec![subjects::inbox(&g.agent_id)], false).await?;
            for p in &g.pools {
                if pools.insert(p.clone()) {
                    self.ensure_consumer(subjects::STREAM_WORK, &subjects::pool_consumer(p), vec![subjects::work_pool(p)], false).await?;
                }
            }
            let mut filters = sub_filters.remove(&g.agent_id).unwrap_or_default();
            filters.sort();
            if filters.is_empty() {
                filters.push(format!("{}.~none", subjects::SUBSCRIPTION_FILTER.trim_end_matches(".>")));
            }
            self.ensure_consumer(subjects::STREAM_SUBSCRIPTIONS, &subscription_consumer(&g.agent_id), filters, false).await?;
        }
        Ok(())
    }

    pub fn known_consumers(&self) -> Vec<ConsumerKey> {
        self.state.lock().consumers.keys().cloned().collect()
    }

    pub fn user_known(&self, agent_id: &str) -> bool {
        self.state.lock().known_users.contains(agent_id)
    }

    pub fn spawn_reconciler(self: &Arc<Self>, shutdown: CancellationToken) -> tokio::task::JoinHandle<()> {
        let plane = self.clone();
        tokio::spawn(async move {
            let interval = Duration::from_millis(plane.cfg.reconcile_interval_ms);
            loop {
                if let Err(err) = plane.reconcile_once().await {
                    tracing::debug!(error = %err, "nats reconcile pending");
                }
                tokio::select! {
                    _ = shutdown.cancelled() => break,
                    _ = tokio::time::sleep(interval) => {},
                }
            }
        })
    }
}
