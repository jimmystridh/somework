#!/usr/bin/env bash
# Adds the metrics block to this host's Alloy configuration: the host's own metrics and the kit agents' /metrics, pushed to the central Prometheus through the
# ingest proxy with the same write account, password and CA as the logs. Idempotent (the block between the markers is replaced), validates the result and
# restores the previous file when Alloy does not stay up. Run as root.
#   install-metrics.sh pi-agent=10.10.10.11:8081 reviewer=10.10.10.11:8082
# Environment for tests: SETTLE (seconds to wait before the check, default 10), ALLOY_CONFIG (the file), VALIDATE (default "alloy validate"), RESTART (default "systemctl restart alloy"), CHECK (default "systemctl is-active --quiet alloy").
set -euo pipefail
config=${ALLOY_CONFIG:-/etc/alloy/config.alloy}
validate=${VALIDATE:-alloy validate}
restart=${RESTART:-systemctl restart alloy}
check=${CHECK:-systemctl is-active --quiet alloy}
begin='// begin metrics (install-metrics.sh)'
end='// end metrics'

pick() { sed -n "s/.*$1 *= *\"\\([^\"]*\\)\".*/\\1/p" "$config" | head -n 1; }
username=$(sed -n 's/.*username = "\([^"]*\)".*/\1/p' "$config" | head -n 1)
host=$(pick host)
vm_id=$(pick vm_id)
password_file=$(sed -n 's/.*password_file *= *"\([^"]*\)".*/\1/p' "$config" | head -n 1)
ca_file=$(sed -n 's/.*ca_file *= *"\([^"]*\)".*/\1/p' "$config" | head -n 1)
for value in username host vm_id password_file ca_file; do
  [ -n "${!value}" ] || { echo "cannot read $value from $config" >&2; exit 1; }
done

targets=""
for pair in "$@"; do
  name=${pair%%=*}
  address=${pair#*=}
  [[ "$name" =~ ^[a-z0-9][a-z0-9-]{0,40}$ && "$address" =~ ^[A-Za-z0-9.-]+:[0-9]{2,5}$ ]] || { echo "bad target '$pair' (use name=address:port)" >&2; exit 1; }
  targets+="    { __address__ = \"$address\", stack = \"$name\" },"$'\n'
done

block=$(cat <<BLOCK
$begin
prometheus.remote_write "central" {
  endpoint {
    url = "https://10.10.10.13:9443/api/v1/write"
    basic_auth {
      username = "$username"
      password_file = "$password_file"
    }
    tls_config { ca_file = "$ca_file" }
  }
  external_labels = { cluster = "agent-cluster", host = "$host", vm_id = "$vm_id", os = "linux" }
}
prometheus.exporter.unix "node" { }
prometheus.scrape "node" {
  job_name = "node"
  targets = prometheus.exporter.unix.node.targets
  scrape_interval = "30s"
  forward_to = [prometheus.remote_write.central.receiver]
}
BLOCK
)
if [ -n "$targets" ]; then
  block+=$'\n'"prometheus.scrape \"agents\" {
  job_name = \"somework-agent\"
  targets = [
${targets%$'\n'}
  ]
  scrape_interval = \"30s\"
  forward_to = [prometheus.remote_write.central.receiver]
}"
fi
block+=$'\n'"$end"

backup="$config.before-metrics-$(date +%Y%m%d%H%M%S)"
cp -p "$config" "$backup"
awk -v b="$begin" -v e="$end" '$0 == b { skip = 1 } !skip { print } $0 == e { skip = 0 }' "$backup" > "$config.new"
printf '%s\n' "$block" >> "$config.new"
cat "$config.new" > "$config"
rm -f "$config.new"
if ! $validate "$config"; then
  cp -p "$backup" "$config"
  echo "the new configuration did not validate; the previous one is back" >&2
  exit 1
fi
$restart
sleep "${SETTLE:-10}"
if ! $check; then
  cp -p "$backup" "$config"
  $restart || true
  echo "Alloy did not stay up with the metrics block; the previous configuration is restored" >&2
  exit 1
fi
echo "metrics block installed for $host ($vm_id); previous configuration kept as $backup"
