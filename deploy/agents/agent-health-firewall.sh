#!/usr/bin/env bash
# Health/status ports of the kit agents (developer 8081, reviewer 8082, Aikido fixer 8083, Datadog triage 8084, Jira triage 8085, product manager 8086) are published on the VM address so the dashboard can read the handler and
# token pool status. Docker bypasses ufw for published ports, so the policy lives in DOCKER-USER: only the listed hosts and this VM itself.
#   HEALTH_IP=10.10.10.11 HEALTH_PORTS="8081 8082 8083 8084 8085 8086" CLIENTS="10.10.10.14" ./agent-health-firewall
set -euo pipefail
: "${HEALTH_IP:?address the ports are bound to}" "${HEALTH_PORTS:?ports}" "${CLIENTS:?hosts allowed}"
LOCAL_CIDRS=${LOCAL_CIDRS:-"$HEALTH_IP/32 127.0.0.0/8 172.16.0.0/12"}
iptables -N AGENT-HEALTH 2>/dev/null || true
iptables -F AGENT-HEALTH
iptables -A AGENT-HEALTH -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
for source in $CLIENTS $LOCAL_CIDRS; do
  case "$source" in */*) iptables -A AGENT-HEALTH -s "$source" -j ACCEPT ;; *) iptables -A AGENT-HEALTH -s "$source/32" -j ACCEPT ;; esac
done
iptables -A AGENT-HEALTH -j DROP
for port in $HEALTH_PORTS; do
  iptables -C DOCKER-USER -p tcp -m conntrack --ctorigdst "$HEALTH_IP" --ctorigdstport "$port" -j AGENT-HEALTH 2>/dev/null \
    || iptables -I DOCKER-USER 1 -p tcp -m conntrack --ctorigdst "$HEALTH_IP" --ctorigdstport "$port" -j AGENT-HEALTH
done
