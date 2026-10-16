#!/usr/bin/env bash
# Dedicated Ubuntu 24.04 host only. No operator credential is copied to the sensor.
set -euo pipefail
test "$(id -u)" = 0 || { echo 'Run on the dedicated Linux sensor as root.'; exit 1; }
. /etc/os-release
test "$ID" = ubuntu && test "$VERSION_ID" = 24.04 || { echo 'This installer targets Ubuntu 24.04.'; exit 1; }
test "$#" = 2 || { echo 'Usage: install-sensor.sh https://control.example IPv4_sensor_address'; exit 1; }
sensor_api="$1"
sensor_address="$2"
sensor_root="$(cd "$(dirname "$0")/.." && pwd)"
test "$sensor_root" = /opt/asset-sync || { echo 'Extract the source into /opt/asset-sync first.'; exit 1; }
test ! -d /Users || { echo 'Use a dedicated VM without shared operator directories.'; exit 1; }
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q docker.io python3.12-venv iptables ca-certificates
systemctl enable --now docker.service
python3.12 -m venv "$sensor_root/.installer"
"$sensor_root/.installer/bin/pip" -q install uv==0.12.19
cd "$sensor_root"
.installer/bin/uv sync --frozen --no-dev --python /usr/bin/python3.12
install -d -m 700 /etc/asset-sync /var/lib/asset-sync
if test ! -f /etc/asset-sync/agent.env; then
  .venv/bin/python scripts/sensor-env.py --api "$sensor_api" --address "$sensor_address"
else
  echo 'Existing agent.env preserved. Review it privately before enrollment.'
fi
docker build -t honeyforge-http:0.1.0 -f infra/Dockerfile.http .
docker build -t honeyforge-cowrie:0.1.0 -f infra/Dockerfile.cowrie .
docker build -t honeyforge-tcp:0.1.0 -f infra/Dockerfile.tcp .
chmod 755 scripts/sensor-firewall.sh
install -m 644 infra/asset-sync.service infra/asset-network.service infra/honeyforge-firewall.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now honeyforge-firewall.service
systemctl enable --now asset-network.service
echo 'Installed. Register with scripts/enroll-sensor.py and a private token file, then start asset-sync.service.'
