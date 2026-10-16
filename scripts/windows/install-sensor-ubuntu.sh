#!/usr/bin/env bash
# Run on a dedicated Ubuntu 24.04 VM or host, never in Git Bash or a Docker container.
set -euo pipefail
umask 077
if [ "$(id -u)" != 0 ]; then echo 'Run with sudo on the Ubuntu sensor VM.'; exit 1; fi
if [ "$#" != 4 ]; then echo 'Usage: sudo bash install-sensor-ubuntu.sh https://asset-sync.test:18443 SENSOR_IP /path/management-ca.crt WINDOWS_IP'; exit 1; fi
if grep -qi microsoft /proc/sys/kernel/osrelease || [ -e /.dockerenv ]; then
  echo 'Use a dedicated Ubuntu VM. WSL/Docker Desktop containers do not share the sensor host network/firewall boundary.'; exit 1
fi
. /etc/os-release
[ "$ID" = ubuntu ] && [ "$VERSION_ID" = 24.04 ] || { echo 'Ubuntu 24.04 is required.'; exit 1; }
[ "$(cat /proc/1/comm)" = systemd ] || { echo 'systemd must be PID 1.'; exit 1; }
hf_source=$(cd "$(dirname "$0")/../.." && pwd)
hf_api=$1
hf_address=$2
hf_ca=$(realpath "$3")
hf_management_ip=$4
[ -f "$hf_ca" ] || { echo 'Public management CA file is missing.'; exit 1; }
python3 - "$hf_api" "$hf_address" "$hf_management_ip" <<'PY'
import ipaddress
import subprocess
import sys
from urllib.parse import urlsplit
url = urlsplit(sys.argv[1])
assert url.scheme == 'https' and url.hostname and not url.username and not url.password
assert url.path in ('', '/') and not url.query and not url.fragment
assert url.hostname == 'asset-sync.test', 'Use the Windows local management hostname'
management = ipaddress.IPv4Address(sys.argv[3])
assert not management.is_loopback and not management.is_unspecified
address = ipaddress.IPv4Address(sys.argv[2])
assert not address.is_unspecified and not address.is_loopback
output = subprocess.check_output(['ip', '-4', '-o', 'addr', 'show'], text=True)
assert str(address) in [line.split()[3].split('/')[0] for line in output.splitlines()], 'Sensor IP is not assigned to this VM'
from pathlib import Path
hosts = Path('/etc/hosts')
lines = hosts.read_text().splitlines()
for line in lines:
    parts = line.split('#', 1)[0].split()
    if 'asset-sync.test' in parts[1:]:
        assert parts[0] == str(management), 'Existing management hostname mapping differs; review migration'
        break
else:
    with hosts.open('a') as output:
        output.write(f'\n{management} asset-sync.test # HoneyForge local management\n')
PY
install -d -m 700 /etc/asset-sync /var/lib/asset-sync
if [ -f /etc/asset-sync/management-ca.crt ]; then
  cmp -s "$hf_ca" /etc/asset-sync/management-ca.crt || { echo 'Different CA already installed; use the documented CA migration procedure.'; exit 1; }
else
  install -m 644 "$hf_ca" /etc/asset-sync/management-ca.crt
fi
# Copy only the agent and its build inputs; no Windows/operator state enters the VM.
if [ "$hf_source" != /opt/asset-sync ]; then
  [ ! -e /opt/asset-sync ] || { echo '/opt/asset-sync already exists. Re-run the installer from that directory to update without discarding state.'; exit 1; }
  install -d -m 755 /opt/asset-sync
  for item in src infra scripts pyproject.toml uv.lock alembic.ini .dockerignore; do
    cp -a "$hf_source/$item" /opt/asset-sync/
  done
fi
if [ ! -f /etc/asset-sync/agent.env ]; then
  python3 /opt/asset-sync/scripts/sensor-env.py --api "$hf_api" --address "$hf_address" --ca-file /etc/asset-sync/management-ca.crt --output /etc/asset-sync/agent.env
else
  python3 - "$hf_api" "$hf_address" <<'CHECK'
import sys
from pathlib import Path
values = dict(line.split('=', 1) for line in Path('/etc/asset-sync/agent.env').read_text().splitlines() if '=' in line)
assert values['HF_AGENT_API'] == sys.argv[1].rstrip('/') and values['HF_AGENT_ADDRESS'] == sys.argv[2], 'Existing sensor settings differ. Do not overwrite identity; see README_WINDOWS.md'
assert values['HF_AGENT_CA_FILE'] == '/etc/asset-sync/management-ca.crt'
CHECK
fi
bash /opt/asset-sync/scripts/install-sensor.sh "$hf_api" "$hf_address"
# Verify the restricted management path AND the gateway certificate before asking for a token.
/opt/asset-sync/.venv/bin/python - <<'PY'
from honeyforge.infrastructure.settings import Settings
from honeyforge.agent.main import Agent
config = Settings(_env_file='/etc/asset-sync/agent.env')
agent = Agent(config)
with agent.http as client:
    response = client.get('/')
    response.raise_for_status()
print('Verified management HTTPS reachable from the sensor transport.')
PY
/opt/asset-sync/.venv/bin/python /opt/asset-sync/scripts/pin-sensor-server.py
if [ ! -f /var/lib/asset-sync/credentials.json ]; then
  echo 'In HoneyForge > Hosts, create a one-time enrollment token. Paste it here (hidden):'
  IFS= read -r -s hf_token
  printf '\n'
  [ -n "$hf_token" ] || { echo 'Empty token; installation kept. Re-run after generating a token.'; exit 1; }
  printf '%s' "$hf_token" > /etc/asset-sync/enrollment.token
  unset hf_token
  chmod 600 /etc/asset-sync/enrollment.token
  /opt/asset-sync/.venv/bin/python /opt/asset-sync/scripts/enroll-sensor.py --token-file /etc/asset-sync/enrollment.token
fi
systemctl enable --now asset-sync.service
systemctl is-active --quiet asset-sync.service
printf 'Sensor service active. Confirm an Online heartbeat and mTLS certificate in HoneyForge before deployment.\n'
