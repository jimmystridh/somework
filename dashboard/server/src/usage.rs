//! Model usage and cost from the central Prometheus, through the read-only Grafana endpoint (the data source proxy, GET only, a Viewer token).
//!
//! Only the counters the agents export are read, `somework_llm_tokens_total` and `somework_llm_cost_usd_total`, as increases over 24 hours, 7 days and
//! 30 days, summed per agent, provider and model. Labels pass the same restricted-alphabet reader as every other name on the page.

use crate::somework::identifier;
use fleet_shared::somework::{UsageAmount, UsageRow, UsageView};
use serde_json::Value;
use std::{collections::BTreeMap, time::Duration};

const PERIODS: [&str; 3] = ["24h", "7d", "30d"];
const MAX_ROWS: usize = 200;

pub struct UsageClient {
    http: reqwest::Client,
    base: String,
    token: String,
    datasource: String,
}

impl UsageClient {
    pub fn new(base: String, token: String, ca_pem: &str, datasource: String) -> Result<Self, String> {
        if !base.starts_with("https://") {
            return Err("METRICS_URL must be https".into());
        }
        reqwest::Url::parse(&base).map_err(|_| "METRICS_URL is not a URL".to_string())?;
        if token.trim().len() < 8 {
            return Err("the metrics token file is empty".into());
        }
        if !datasource.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_')) || datasource.is_empty() {
            return Err("METRICS_DATASOURCE must be a plain data source uid".into());
        }
        if crate::certs::pem_certificates(ca_pem).is_empty() {
            return Err("the metrics CA file holds no certificate".into());
        }
        let certificate = reqwest::Certificate::from_pem(ca_pem.as_bytes()).map_err(|_| "the metrics CA is not a PEM certificate".to_string())?;
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .connect_timeout(Duration::from_secs(3))
            .redirect(reqwest::redirect::Policy::none())
            .https_only(true)
            .tls_built_in_root_certs(false)
            .add_root_certificate(certificate)
            .build()
            .map_err(|_| "cannot build the HTTP client".to_string())?;
        Ok(Self { http, base: base.trim_end_matches('/').to_string(), token: token.trim().to_string(), datasource })
    }

    async fn query(&self, expression: String) -> Option<Value> {
        let url = format!("{}/api/datasources/proxy/uid/{}/api/v1/query", self.base, self.datasource);
        let response = self.http.get(url).bearer_auth(&self.token).query(&[("query", expression)]).send().await.ok()?;
        if !response.status().is_success() {
            return None;
        }
        response.json::<Value>().await.ok()
    }

    /// The three periods of tokens and cost, read at once; `None` when nothing could be read at all.
    pub async fn read(&self, now_iso: Option<String>) -> Option<UsageView> {
        let tokens = |window: &str| self.query(format!("sum by (agent,provider,model,kind) (increase(somework_llm_tokens_total[{window}]))"));
        let cost = |window: &str| self.query(format!("sum by (agent,provider,model) (increase(somework_llm_cost_usd_total[{window}]))"));
        let (t0, t1, t2, c0, c1, c2) = tokio::join!(tokens(PERIODS[0]), tokens(PERIODS[1]), tokens(PERIODS[2]), cost(PERIODS[0]), cost(PERIODS[1]), cost(PERIODS[2]));
        let answers = [(&t0, &c0), (&t1, &c1), (&t2, &c2)];
        if answers.iter().all(|(t, c)| t.is_none() && c.is_none()) {
            return None;
        }
        Some(view(&answers.map(|(t, c)| (t.as_ref(), c.as_ref())), now_iso))
    }
}

type Key = (String, String, String);

fn key(metric: &Value) -> Option<Key> {
    Some((identifier(metric.get("agent"))?, identifier(metric.get("provider"))?, identifier(metric.get("model"))?))
}

fn sample(item: &Value) -> Option<f64> {
    item.get("value")?.get(1)?.as_str()?.parse::<f64>().ok().filter(|n| n.is_finite() && *n >= 0.0)
}

fn results(answer: Option<&Value>) -> &[Value] {
    answer.and_then(|body| body.get("data")).and_then(|data| data.get("result")).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

fn amounts(tokens: Option<&Value>, cost: Option<&Value>) -> BTreeMap<Key, UsageAmount> {
    let mut out: BTreeMap<Key, UsageAmount> = BTreeMap::new();
    for item in results(tokens) {
        let (Some(metric), Some(value)) = (item.get("metric"), sample(item)) else { continue };
        let Some(who) = key(metric) else { continue };
        let entry = out.entry(who).or_default();
        let amount = value.round() as u64;
        match metric.get("kind").and_then(Value::as_str) {
            Some("input") => entry.input += amount,
            Some("output") => entry.output += amount,
            Some("cache_read") => entry.cache_read += amount,
            Some("cache_write") => entry.cache_write += amount,
            _ => {}
        }
    }
    for item in results(cost) {
        let (Some(metric), Some(value)) = (item.get("metric"), sample(item)) else { continue };
        if let Some(who) = key(metric) {
            out.entry(who).or_default().cost_usd += value;
        }
    }
    out.retain(|_, amount| !amount.is_empty());
    out
}

/// The rows of the three periods merged per agent, provider and model, the most expensive month first.
pub fn view(periods: &[(Option<&Value>, Option<&Value>); 3], now_iso: Option<String>) -> UsageView {
    let [day, week, month] = periods.map(|(tokens, cost)| amounts(tokens, cost));
    let mut rows: BTreeMap<Key, UsageRow> = BTreeMap::new();
    for (index, period) in [day, week, month].into_iter().enumerate() {
        for ((agent, provider, model), amount) in period {
            let row = rows.entry((agent.clone(), provider.clone(), model.clone())).or_insert_with(|| UsageRow { agent, provider, model, ..Default::default() });
            match index {
                0 => row.day = amount,
                1 => row.week = amount,
                _ => row.month = amount,
            }
        }
    }
    let mut rows: Vec<UsageRow> = rows.into_values().collect();
    rows.sort_by(|a, b| b.month.cost_usd.total_cmp(&a.month.cost_usd).then_with(|| (b.month.input + b.month.output).cmp(&(a.month.input + a.month.output))).then_with(|| a.agent.cmp(&b.agent)));
    rows.truncate(MAX_ROWS);
    UsageView { observed_at: now_iso, rows }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn vector(items: Vec<Value>) -> Value {
        json!({"status": "success", "data": {"resultType": "vector", "result": items}})
    }

    fn token(agent: &str, kind: &str, value: &str) -> Value {
        json!({"metric": {"agent": agent, "provider": "openai-codex", "model": "gpt-5.5", "kind": kind}, "value": [1.0, value]})
    }

    fn cost(agent: &str, value: &str) -> Value {
        json!({"metric": {"agent": agent, "provider": "openai-codex", "model": "gpt-5.5"}, "value": [1.0, value]})
    }

    #[test]
    fn tokens_by_kind_and_cost_are_merged_per_agent_provider_and_model() {
        let tokens = vector(vec![token("agent/qa", "input", "1000.4"), token("agent/qa", "output", "200"), token("agent/qa", "cache_read", "5000"), token("agent/aikido-fixer", "input", "10")]);
        let costs = vector(vec![cost("agent/qa", "1.5"), cost("agent/aikido-fixer", "0.25")]);
        let month_tokens = vector(vec![token("agent/qa", "input", "9000")]);
        let month_costs = vector(vec![cost("agent/qa", "12.5")]);
        let none = vector(vec![]);
        let out = view(&[(Some(&tokens), Some(&costs)), (Some(&none), Some(&none)), (Some(&month_tokens), Some(&month_costs))], Some("now".into()));
        assert_eq!(out.rows.len(), 2);
        let qa = &out.rows[0];
        assert_eq!((qa.agent.as_str(), qa.provider.as_str(), qa.model.as_str()), ("agent/qa", "openai-codex", "gpt-5.5"), "most expensive month first");
        assert_eq!((qa.day.input, qa.day.output, qa.day.cache_read, qa.day.cost_usd), (1000, 200, 5000, 1.5));
        assert!(qa.week.is_empty());
        assert_eq!((qa.month.input, qa.month.cost_usd), (9000, 12.5));
        assert_eq!(out.rows[1].agent, "agent/aikido-fixer");
        assert_eq!(out.observed_at.as_deref(), Some("now"));
    }

    #[test]
    fn unsafe_labels_and_odd_samples_are_ignored() {
        let tokens = vector(vec![
            json!({"metric": {"agent": "<script>", "provider": "p", "model": "m", "kind": "input"}, "value": [1.0, "5"]}),
            json!({"metric": {"agent": "agent/x", "provider": "p", "model": "m", "kind": "input"}, "value": [1.0, "NaN"]}),
            json!({"metric": {"agent": "agent/x", "provider": "p", "model": "m", "kind": "mystery"}, "value": [1.0, "7"]}),
            json!({"metric": {"agent": "agent/x", "provider": "p", "model": "m", "kind": "output"}, "value": [1.0, "-3"]}),
        ]);
        let none = vector(vec![]);
        let out = view(&[(Some(&tokens), Some(&none)), (None, None), (None, None)], None);
        assert!(out.rows.is_empty(), "{:?}", out.rows);
    }

    #[test]
    fn the_client_refuses_plain_http_an_empty_token_and_an_odd_data_source() {
        let pem = "";
        assert!(UsageClient::new("http://10.0.0.1:9444".into(), "tokentoken".into(), pem, "cluster-prometheus".into()).is_err());
        assert!(UsageClient::new("https://10.0.0.1:9444".into(), "x".into(), pem, "cluster-prometheus".into()).is_err());
        assert!(UsageClient::new("https://10.0.0.1:9444".into(), "tokentoken".into(), pem, "a/b".into()).is_err());
        assert!(UsageClient::new("https://10.0.0.1:9444".into(), "tokentoken".into(), pem, "cluster-prometheus".into()).is_err(), "no certificate in the CA file");
    }
}
