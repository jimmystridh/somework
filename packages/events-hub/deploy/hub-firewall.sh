#!/usr/bin/env bash
# Published ports of the hub: plain HTTP (8090) only for senders that cannot speak TLS, TLS (8091) for Grafana (the webhook contact point) and
# for the readers of /admin and /metrics (the dashboard on the services VM, the manager on this VM). Docker bypasses ufw for published ports, so the policy lives in DOCKER-USER.
#   HUB_IP=10.10.10.11 PLAIN_CLIENTS="10.10.10.13" TLS_CLIENTS="10.10.10.14 10.10.10.13" LOCAL_CIDRS="10.10.10.11/32 172.16.0.0/12" ./hub-firewall.sh
set -euo pipefail
: "${HUB_IP:?address the ports are bound to}" "${PLAIN_CLIENTS:?hosts allowed on the plain port}" "${TLS_CLIENTS:?hosts allowed on the TLS port}"
LOCAL_CIDRS=${LOCAL_CIDRS:-"$HUB_IP/32 172.16.0.0/12"}
chain_for() {
  local chain=$1 port=$2; shift 2
  iptables -N "$chain" 2>/dev/null || true
  iptables -F "$chain"
  iptables -A "$chain" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  for source in "$@"; do
    case "$source" in */*) iptables -A "$chain" -s "$source" -j ACCEPT ;; *) iptables -A "$chain" -s "$source/32" -j ACCEPT ;; esac
  done
  iptables -A "$chain" -j DROP
  iptables -C DOCKER-USER -p tcp -m conntrack --ctorigdst "$HUB_IP" --ctorigdstport "$port" -j "$chain" 2>/dev/null \
    || iptables -I DOCKER-USER 1 -p tcp -m conntrack --ctorigdst "$HUB_IP" --ctorigdstport "$port" -j "$chain"
}
# shellcheck disable=SC2086
chain_for EVENTS-HUB-PLAIN "${HUB_PORT:-8090}" $PLAIN_CLIENTS $LOCAL_CIDRS
# shellcheck disable=SC2086
chain_for EVENTS-HUB-TLS "${HUB_TLS_PORT:-8091}" $TLS_CLIENTS $LOCAL_CIDRS
