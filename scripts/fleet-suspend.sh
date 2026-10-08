#!/bin/bash
# The machines' kill switch, for the owner's workstation (the manager's /suspend stops what the platform starts; this stops the processes).
#
#   scripts/fleet-suspend.sh            stop every agent, the event hub and the Windows agents; the domain, the broker, the receiver (it keeps queuing
#                                       webhooks) and the manager stay up so that Telegram can bring everything back
#   scripts/fleet-suspend.sh --resume   start them again: the hub first, then the agents, then the Windows agents
#
# ssh aliases (override with the variables): AGENTS_HOST runs the agent stacks under ~/somework-pilot, WINDOWS_HOSTS are the Windows agent machines.
# While suspended the file ~/somework-pilot/SUSPENDED exists on the agents VM and the CI deploy wrapper refuses to deploy (it would start the Linux agents
# again); the Windows tasks are disabled, so their deployment cannot start the agents either.
set -u
AGENTS_HOST=${AGENTS_HOST:-admin-cloud-agents}
WINDOWS_HOSTS=${WINDOWS_HOSTS:-"admin-cloud-windows-2 admin-cloud-windows-3"}
STACKS_FIRST=${STACKS_FIRST:-events-hub}
STACKS=${STACKS:-"pi-agent reviewer aikido-fixer datadog-triage"}
here=$(cd "$(dirname "$0")" && pwd)

if [ "${1:-}" = "--resume" ]; then
  action=up; flag=-Resume
  ssh "$AGENTS_HOST" "rm -f ~/somework-pilot/SUSPENDED; cd ~/somework-pilot && for d in $STACKS_FIRST $STACKS; do [ -f \$d/compose.yaml ] && (cd \$d && echo \"== start \$d\" && docker compose up -d 2>&1 | tail -2); done"
else
  action=stop; flag=
  ssh "$AGENTS_HOST" "date -u +%FT%TZ > ~/somework-pilot/SUSPENDED; cd ~/somework-pilot && for d in $STACKS $STACKS_FIRST; do [ -f \$d/compose.yaml ] && (cd \$d && echo \"== stop \$d\" && docker compose stop 2>&1 | tail -2); done; docker ps --format '{{.Names}} {{.Status}}'"
fi
for host in $WINDOWS_HOSTS; do
  echo "### $host"
  scp -q "$here/fleet-suspend.ps1" "$host:C:/somework/fleet-suspend.ps1" && ssh "$host" "powershell -NoProfile -ExecutionPolicy Bypass -File C:\\somework\\fleet-suspend.ps1 $flag"
done
echo "done: $action"
