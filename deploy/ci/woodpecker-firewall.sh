#!/usr/bin/env bash
# Woodpecker published ports: web/API on 9445 (gateway on the observability VM, hub on the agents VM for webhook replay),
# gRPC on 9000 (the CI runner only). Docker bypasses ufw for published ports, so the policy lives in DOCKER-USER.
set -euo pipefail
: "${SERVER_IP:?address the published ports are bound to}" "${WEB_CLIENTS:?space-separated hosts allowed to reach the web/API port}" "${RUNNER_IP:?the CI runner}"
chain_for() {
  local chain=$1 port=$2; shift 2
  iptables -N "$chain" 2>/dev/null || iptables -S "$chain" >/dev/null
  iptables -F "$chain"
  iptables -A "$chain" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  for source in "$@"; do iptables -A "$chain" -s "$source/32" -j ACCEPT; done
  iptables -A "$chain" -j DROP
  iptables -C DOCKER-USER -p tcp -m conntrack --ctorigdst ${SERVER_IP} --ctorigdstport "$port" -j "$chain" 2>/dev/null \
    || iptables -I DOCKER-USER 1 -p tcp -m conntrack --ctorigdst ${SERVER_IP} --ctorigdstport "$port" -j "$chain"
}
chain_for WOODPECKER-WEB 9445 ${WEB_CLIENTS}
chain_for WOODPECKER-GRPC 9000 ${RUNNER_IP}
