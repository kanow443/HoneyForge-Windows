#!/usr/bin/env bash
# Install only HoneyForge-owned rules. Never flush global or Docker chains.
set -euo pipefail
test "$(id -u)" = 0 || { echo 'Run as root on the dedicated sensor Linux host'; exit 1; }
iptables -w -S DOCKER-USER >/dev/null
for chain in HF-EGRESS HF-HOST; do
  iptables -w -N "$chain" 2>/dev/null || true
  # Populate a new chain before switching the parent jump: no fail-open flush window.
  next="${chain}-NEW"
  iptables -w -N "$next" 2>/dev/null || true
  iptables -w -F "$next"
  iptables -w -A "$next" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  iptables -w -A "$next" -m limit --limit 10/min --limit-burst 10 -j LOG --log-prefix 'HF-BLOCK ' --log-level 6
  iptables -w -A "$next" -j DROP
  parent=DOCKER-USER
  test "$chain" != HF-HOST || parent=INPUT
  iptables -w -I "$parent" 1 -i hf+ -j "$next"
  iptables -w -D "$parent" -i hf+ -j "$chain" 2>/dev/null || true
  iptables -w -F "$chain"
  iptables -w -A "$chain" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  iptables -w -A "$chain" -m limit --limit 10/min --limit-burst 10 -j LOG --log-prefix 'HF-BLOCK ' --log-level 6
  iptables -w -A "$chain" -j DROP
  iptables -w -I "$parent" 1 -i hf+ -j "$chain"
  iptables -w -D "$parent" -i hf+ -j "$next"
  iptables -w -F "$next"
  iptables -w -X "$next"
done
echo 'HoneyForge firewall installed: new container connections to host and external networks are blocked.'
