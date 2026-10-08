# Central observability (VM104): metrics next to the logs

Loki and Grafana were set up by hand on VM104 (`/opt/agent-cluster-observability`, root-owned); this directory holds the files that were added for metrics, as
they were installed, plus the live files they changed.

| File | Installed as | What |
| --- | --- | --- |
| `compose.yaml` | `/opt/agent-cluster-observability/compose.yaml` | Loki and Grafana as before, plus Prometheus 3.5 (pinned by digest, 768 MB, remote-write receiver, data in `/srv/observability/prometheus`, 365 days or 40 GB) |
| `prometheus.yml` | next to it | no scrape jobs except itself: everything is pushed |
| `nginx-ingest.conf` | `/etc/nginx/conf.d/agent-cluster-ingest.conf` | the log ingest on `10.10.10.13:9443` now also accepts `POST /api/v1/write`, with the same TLS and the same per-client write accounts |
| `nginx-grafana-read.conf` | `/etc/nginx/conf.d/agent-cluster-grafana-read.conf` | the read-only Grafana for the agents (`9444`) now also lets the Prometheus data source's `query`, `query_range`, `series`, `metadata`, `labels` and `label values` GETs through |
| `provisioning/datasources/prometheus.yaml` | `.../provisioning/datasources/` | the data source `cluster-prometheus` |
| `dashboards/llm-usage.json` | `.../dashboards/` | *LLM usage and cost*: cost and tokens by kind per agent, provider and model, plus host health |
| `alloy/install-metrics.sh`, `alloy/install-metrics.ps1` | run once per host | add the metrics block to the host's Alloy |

## How the data flows

```
agent /metrics (kit, every series has agent="<id>") ─┐
host metrics (Alloy's unix / windows exporter)       ├─ Alloy on the host ── remote write, TLS + the host's write account ──> nginx 9443 ──> Prometheus
                                                     ┘
agents ── observe tools (metrics_catalog, metrics_query, llm_usage) ── Grafana read-only endpoint 9444 (data source proxy) ──> Prometheus
```

Alloy adds `cluster`, `host`, `vm_id` and `os` to everything it pushes and `stack` to the agent targets. The agent id comes from the agent itself.

## Install on a host

Linux (as root; reads the host's identity and write account from the existing Alloy config, validates, restarts, restores on failure):

    sudo bash install-metrics.sh pi-agent=10.10.10.11:8081 reviewer=10.10.10.11:8082

Windows (as administrator; same contract, `-Target name=address:port`):

    powershell -NoProfile -ExecutionPolicy Bypass -File install-metrics.ps1 -Target 'qa=10.10.10.44:8082'

Installed 2026-10-08 on VM102 (the four kit agents and the event hub), VM104, VM105, VM103, VM111 (`windows-developer`) and VM112 (`qa`). The CI VM (VM113) and the
hypervisor have no Alloy yet. The agents' health ports are published on the VM address, so Alloy on the same VM scrapes `10.10.10.11:808x`; the Windows agents bind
their VM address (`WINDOWS_HEALTH_BIND`).

## VM104 (changing the central side)

    scp compose.yaml nginx-ingest.conf prometheus.yml VM104:/tmp/obs-new/ ; on VM104, as root: back the live files up (`*.before-prometheus-*`), `install` them,
    `install -d -o 65534 -g 65534 /srv/observability/prometheus`, `nginx -t && systemctl reload nginx`, `docker compose up -d prometheus`, then restart Grafana
    so that it reads the new data source (the Prometheus data source plugin installs itself on the first start and takes a minute).

## Reading it

* Grafana: *LLM usage and cost* (folder Agent Cluster), data source *Cluster Metrics*.
* Agents: `llm_usage`, `metrics_query` and `metrics_catalog` (kit observe tools, see `packages/agent-kit/README.md`). A role with own scope sees only its own series.
* Counters (`somework_llm_tokens_total`, `somework_llm_cost_usd_total`) restart from zero with the agent; use `increase()`/`rate()`, which handle that.

## Not done

* Alert rules over the metrics (`adapters/pi/deploy/prometheus/alerts.yaml` is written, not loaded: Prometheus has no rule files and there is no Alertmanager; Grafana-managed
  rules over the `cluster-prometheus` data source would be the way, next to the log rules from `deploy/grafana/provision.py`).
* The domain's `/metrics` (needs a credential) and the hub's rule and firing counters beyond what the hub's `/metrics` already exposes.
* Windows agents do not have the observe tools switched on.
