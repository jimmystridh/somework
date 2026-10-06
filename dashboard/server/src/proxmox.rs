use fleet_shared::{Fleet, Machine, Sample, Storage};
use reqwest::{Certificate, Client};
use serde_json::Value;
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

pub struct Proxmox {
    client: Client,
    url: String,
    token: String,
    histories: HashMap<String, Vec<Sample>>,
    history_at: Option<Instant>,
}

impl Proxmox {
    pub fn new(url: String, token: String, ca: &[u8]) -> Result<Self, Box<dyn std::error::Error>> {
        let client = Client::builder()
            .add_root_certificate(Certificate::from_pem(ca)?)
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(8))
            .build()?;
        Ok(Self {
            client,
            url,
            token,
            histories: HashMap::new(),
            history_at: None,
        })
    }
    async fn get(&self, path: &str) -> Result<Value, ()> {
        let response = self
            .client
            .get(format!("{}/api2/json{path}", self.url))
            .header("Authorization", &self.token)
            .send()
            .await
            .map_err(|_| ())?;
        if !response.status().is_success() {
            return Err(());
        }
        if response
            .content_length()
            .is_some_and(|length| length > 2 * 1024 * 1024)
        {
            return Err(());
        }
        let mut response = response;
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| ())? {
            if body.len() + chunk.len() > 2 * 1024 * 1024 {
                return Err(());
            }
            body.extend_from_slice(&chunk);
        }
        serde_json::from_slice::<Value>(&body)
            .map(|value| value["data"].clone())
            .map_err(|_| ())
    }
    pub async fn sample(&mut self) -> Result<Fleet, ()> {
        let resources = self.get("/cluster/resources").await?;
        let resources = resources.as_array().ok_or(())?;
        let mut fleet = Fleet::default();
        let history_due = self
            .history_at
            .is_none_or(|time| time.elapsed() > Duration::from_secs(60));
        for resource in resources {
            let kind = text(resource, "type");
            if kind == "storage" {
                fleet.storage.push(Storage {
                    name: text(resource, "storage"),
                    used: number(resource, "disk"),
                    total: number(resource, "maxdisk"),
                    status: text(resource, "status"),
                });
                continue;
            }
            if kind != "qemu" && kind != "node" {
                continue;
            }
            let node = text(resource, "node");
            if !node
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                || node.is_empty()
            {
                return Err(());
            }
            let path = if kind == "qemu" {
                format!(
                    "/nodes/{node}/qemu/{}",
                    resource["vmid"].as_u64().ok_or(())?
                )
            } else {
                format!("/nodes/{node}")
            };
            let current = self
                .get(&format!(
                    "{path}/status{}",
                    if kind == "qemu" { "/current" } else { "" }
                ))
                .await?;
            let id = text(resource, "id");
            if history_due
                && let Ok(history) = self
                    .get(&format!("{path}/rrddata?timeframe=hour&cf=AVERAGE"))
                    .await
            {
                let samples: Vec<_> = history
                    .as_array()
                    .ok_or(())?
                    .iter()
                    .filter_map(|sample| {
                        Some(Sample {
                            time: number(sample, "time")?,
                            cpu_percent: number(sample, "cpu").map(|cpu| cpu * 100.0),
                            memory_bytes: number(sample, "memused"),
                            network_in: number(sample, "netin"),
                            network_out: number(sample, "netout"),
                        })
                    })
                    .collect();
                self.histories.insert(
                    id.clone(),
                    samples
                        .into_iter()
                        .rev()
                        .take(60)
                        .collect::<Vec<_>>()
                        .into_iter()
                        .rev()
                        .collect(),
                );
            }
            fleet.machines.push(machine(
                resource,
                &current,
                self.histories.get(&id).cloned().unwrap_or_default(),
            ));
        }
        fleet
            .machines
            .sort_by_key(|machine| (machine.kind.clone(), machine.vm_id.unwrap_or(0)));
        if history_due {
            self.history_at = Some(Instant::now());
        }
        fleet.observed_at = Some(chrono::Utc::now().to_rfc3339());
        Ok(fleet)
    }
}

fn number(value: &Value, key: &str) -> Option<f64> {
    value[key]
        .as_f64()
        .filter(|number| number.is_finite() && *number >= 0.0)
}
fn text(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or("").to_owned()
}
fn machine(resource: &Value, current: &Value, history: Vec<Sample>) -> Machine {
    let vm_id = resource["vmid"].as_u64();
    let memory_bytes = number(current, "mem")
        .or_else(|| current["memory"]["used"].as_f64())
        .or_else(|| number(resource, "mem"));
    let memory_limit = number(current, "maxmem")
        .or_else(|| current["memory"]["total"].as_f64())
        .or_else(|| number(resource, "maxmem"));
    let latest = history
        .iter()
        .rev()
        .find(|sample| sample.network_in.is_some() || sample.network_out.is_some());
    Machine {
        id: text(resource, "id"),
        vm_id,
        name: resource["name"]
            .as_str()
            .unwrap_or(resource["node"].as_str().unwrap_or("Unknown"))
            .into(),
        kind: text(resource, "type"),
        node: text(resource, "node"),
        role: match vm_id {
            Some(101) => "Development",
            Some(102) => "Agents",
            Some(103) => "Windows build",
            Some(104) => "Observability",
            Some(105) => "Docker services",
            Some(106) => "External services",
            Some(_) => "Virtual machine",
            None => "Hypervisor",
        }
        .into(),
        status: current["status"]
            .as_str()
            .unwrap_or(resource["status"].as_str().unwrap_or("unknown"))
            .into(),
        cpu_percent: number(current, "cpu")
            .or_else(|| number(resource, "cpu"))
            .map(|cpu| cpu * 100.0),
        cores: current["cpus"]
            .as_u64()
            .or_else(|| resource["maxcpu"].as_u64()),
        memory_bytes,
        memory_limit,
        memory_percent: memory_bytes
            .zip(memory_limit)
            .filter(|(_, total)| *total > 0.0)
            .map(|(used, total)| used / total * 100.0),
        disk_provisioned: number(resource, "maxdisk"),
        uptime_seconds: number(current, "uptime").or_else(|| number(resource, "uptime")),
        network_in: latest.and_then(|sample| sample.network_in),
        network_out: latest.and_then(|sample| sample.network_out),
        history,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn maps_metrics_and_distinguishes_missing_from_zero() {
        let value = machine(
            &json!({"id":"qemu/105","vmid":105,"type":"qemu","node":"host","name":"services","maxcpu":2,"maxmem":4096,"maxdisk":100}),
            &json!({"cpu":0.25,"mem":1024,"status":"running"}),
            vec![],
        );
        assert_eq!(value.cpu_percent, Some(25.0));
        assert_eq!(value.memory_percent, Some(25.0));
        assert_eq!(value.network_in, None);
        assert_eq!(value.role, "Docker services");
        assert_eq!(number(&json!({"disk":null}), "disk"), None);
    }

    #[test]
    fn distinguishes_external_services_and_unknown_guests_from_hypervisor() {
        for (id, role) in [(106, "External services"), (107, "Virtual machine")] {
            let value = machine(
                &json!({"id":format!("qemu/{id}"),"vmid":id,"type":"qemu","node":"host"}),
                &json!({"status":"running"}),
                vec![],
            );
            assert_eq!(value.role, role);
        }
    }
}
