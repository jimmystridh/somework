use std::{sync::Arc, time::Duration};

use async_trait::async_trait;
use serde_json::{Value, json};
use somework_core::{Error, contracts::ActorKind, subjects};
use somework_domain::{Ctx, streams::ConnectionProvider};

use crate::{
    conf::{agent_user_name, subscription_consumer},
    plane::NatsPlane,
};

pub struct NatsConnectionProvider {
    plane: Arc<NatsPlane>,
}

impl NatsConnectionProvider {
    pub fn new(plane: Arc<NatsPlane>) -> Self {
        Self { plane }
    }
}

impl NatsPlane {
    /// Makes sure `agent_id` can actually log in: regenerates the users file, reloads nats-server and waits until
    /// the new credentials work. Best effort; the sidecar retries its own connection.
    pub async fn ensure_agent(&self, agent_id: &str) {
        let inbox = crate::plane::ConsumerKey { stream: subjects::STREAM_INBOX, name: subjects::inbox_consumer(agent_id) };
        let users_pending = self.cfg.users_file.is_some() && !self.user_known(agent_id);
        let consumers_pending = self.cfg.provision && !self.known_consumers().contains(&inbox);
        if !users_pending && !consumers_pending {
            return;
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while !self.is_connected() && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        if let Err(err) = self.reconcile_once().await {
            tracing::warn!(error = %err, agent = agent_id, "could not provision nats resources for the agent");
            return;
        }
        if !users_pending {
            return;
        }
        let user = agent_user_name(agent_id);
        let password = self.generator.secret.password_for(agent_id);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while tokio::time::Instant::now() < deadline {
            let attempt = crate::plane::apply_tls(async_nats::ConnectOptions::with_user_and_password(user.clone(), password.clone()), &self.cfg)
                .connection_timeout(Duration::from_secs(2))
                .connect(&self.cfg.url)
                .await;
            if attempt.is_ok() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        tracing::warn!(agent = agent_id, "nats credentials were not accepted within the reload window");
    }
}

#[async_trait]
impl ConnectionProvider for NatsConnectionProvider {
    async fn connection_info(&self, ctx: &Ctx) -> Result<Value, Error> {
        if ctx.actor.kind != ActorKind::Agent {
            return Err(Error::denied("NATS connection details are only issued to agents"));
        }
        let agent = &ctx.actor.id;
        self.plane.ensure_agent(agent).await;
        let directory = self.plane.domain.agent_directory().await?;
        let pool = directory.iter().find(|e| &e.agent_id == agent).map(|e| e.pool_id.clone()).unwrap_or_else(|| agent.clone());
        Ok(json!({
            "nats": {
                "url": self.plane.cfg.agent_url(),
                "user": agent_user_name(agent),
                "password": self.plane.generator.secret.password_for(agent),
                "inboxStream": subjects::STREAM_INBOX,
                "inboxConsumer": subjects::inbox_consumer(agent),
                "workStream": subjects::STREAM_WORK,
                "poolConsumers": [{"poolId": pool, "stream": subjects::STREAM_WORK, "consumer": subjects::pool_consumer(&pool), "filter": subjects::work_pool(&pool)}],
                "subscriptionStream": subjects::STREAM_SUBSCRIPTIONS,
                "subscriptionConsumer": subscription_consumer(agent),
                "presenceSubject": subjects::presence(agent),
                "streamSubjectPrefix": "somework.stream.task",
            },
            "pollOnly": false,
        }))
    }
}
