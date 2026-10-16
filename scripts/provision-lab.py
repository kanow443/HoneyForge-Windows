"""Provision the dedicated, isolated OrbStack lab VM. Never copy operator secrets to the sensor."""
import argparse
import io
import re
import subprocess
import tarfile
import time
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import httpx

from honeyforge.infrastructure.settings import settings

ROOT = Path(__file__).resolve().parents[1]
ORB = "/Applications/OrbStack.app/Contents/MacOS/bin/orbctl"
VM = "honeyforge-sensor"


def remote(command, data=None):
    return subprocess.run([ORB, "run", "-m", VM, "-u", "root", "bash", "-c", command],
        input=data, check=True, capture_output=True).stdout.decode()


def main():
    global VM
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reenroll", action="store_true", help="Archive revoked sensor credentials/outbox and enroll a new identity")
    parser.add_argument("--vm", default=VM)
    parser.add_argument("--ca-file", default=".runtime/tls/management-ca.crt")
    parser.add_argument("--install", action="store_true", help="Run the clean Ubuntu installer before registration")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z0-9-]+", args.vm):
        parser.error("Invalid VM name")
    VM = args.vm
    ca = Path(args.ca_file).read_bytes()
    address = subprocess.check_output([ORB, "info", VM], text=True)
    ip = re.search(r"\b192\.168\.\d+\.\d+\b", address).group(0)
    # The VM must be created with `orbctl create --isolated ubuntu:noble honeyforge-sensor`.
    remote("test ! -d /Users; systemctl stop asset-sync.service honeyforge-agent.service 2>/dev/null || true; "
        "test ! -d /var/lib/honeyforge || test -d /var/lib/asset-sync || mv /var/lib/honeyforge /var/lib/asset-sync; "
        "mkdir -p /opt/asset-sync /etc/asset-sync /var/lib/asset-sync; chmod 700 /etc/asset-sync /var/lib/asset-sync")
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for entry in ("src", "scripts", "infra", "pyproject.toml", "uv.lock", ".dockerignore"):
            archive.add(ROOT / entry, arcname=entry, filter=lambda member: None if "__pycache__" in member.name else member)
    remote("tar -xz -C /opt/asset-sync", buffer.getvalue())
    print("Source copied; no .env, operator credentials, or host directories shared.")
    if args.install:
        print(remote(f"chmod +x /opt/asset-sync/scripts/install-sensor.sh; /opt/asset-sync/scripts/install-sensor.sh https://host.orb.internal:18443 {ip}")[-1500:])
    print(remote("python3 -m venv /opt/asset-sync/.installer; /opt/asset-sync/.installer/bin/pip -q install uv==0.12.19; "
        "cd /opt/asset-sync; .installer/bin/uv sync --frozen --no-dev --python /usr/bin/python3", None)[-1000:])
    for image in (settings.http_image, settings.cowrie_image, settings.tcp_image):
        save = subprocess.Popen(["docker", "save", image], stdout=subprocess.PIPE)
        load = subprocess.Popen([ORB, "run", "-m", VM, "-u", "root", "docker", "load"], stdin=save.stdout,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        save.stdout.close()
        stdout, stderr = load.communicate()
        if load.returncode or save.wait():
            raise RuntimeError("Image transfer failed: " + stderr.decode()[-500:])
        print(stdout.decode().strip())
    environment = (f"HF_AGENT_API=https://host.orb.internal:18443\nHF_AGENT_NAME=asset-sync-{VM}\n"
        f"HF_AGENT_ADDRESS={ip}\nHF_AGENT_BIND={ip}\nHF_AGENT_STATE_DIR=/var/lib/asset-sync\n"
        f"HF_ALLOW_INSECURE_AGENT=false\nHF_AGENT_CA_FILE=/etc/asset-sync/management-ca.crt\n"
        f"HF_AGENT_MANAGEMENT_ADDRESS=10.88.0.1\n"
        f"HF_AGENT_ROUTE_PREFIX=/assets/sync/v1\nHF_HTTP_IMAGE={settings.http_image}\nHF_COWRIE_IMAGE={settings.cowrie_image}\nHF_TCP_IMAGE={settings.tcp_image}\n")
    remote("cat > /etc/asset-sync/management-ca.crt; chmod 644 /etc/asset-sync/management-ca.crt", ca)
    # Hypervisor paths and acceleration are host-local operator settings, not re-enrolment defaults.
    remote("cat > /etc/asset-sync/agent.env; chmod 600 /etc/asset-sync/agent.env", environment.encode())
    remote("chmod +x /opt/asset-sync/scripts/sensor-firewall.sh; "
        "cp /opt/asset-sync/infra/asset-sync.service /opt/asset-sync/infra/asset-network.service /opt/asset-sync/infra/honeyforge-firewall.service /etc/systemd/system/; systemctl daemon-reload; "
        "systemctl enable --now honeyforge-firewall.service; systemctl enable --now asset-network.service; systemctl restart asset-network.service")
    if args.reenroll:
        archive = "/var/lib/asset-sync/archive-" + uuid4().hex
        remote(f"systemctl stop asset-sync.service; install -d -m 700 {archive}; "
            f"for name in credentials.json runtimes.json outbox.sqlite3 outbox.sqlite3-wal outbox.sqlite3-shm source-policies.json client-identities rotate-request; do "
            f"test ! -e /var/lib/asset-sync/\"$name\" || mv /var/lib/asset-sync/\"$name\" {archive}/; done")
        print("Previous sensor credentials and outbox archived privately; old identity remains unchanged.")
    exists = remote("test ! -f /var/lib/asset-sync/credentials.json || echo enrolled").strip()
    if not exists:
        with httpx.Client(base_url="http://127.0.0.1:8100", trust_env=False) as client:
            login = client.post("/api/v1/auth/login", json={"username": settings.admin_username, "password": settings.admin_password})
            login.raise_for_status()
            client.headers["X-CSRF-Token"] = login.json()["csrf_token"]
            enrollment = client.post("/api/v1/hosts/enrollment-tokens")
            enrollment.raise_for_status()
            token = enrollment.json()["token"]
            remote("umask 077; cat > /etc/asset-sync/enrollment.token; set -a; . /etc/asset-sync/agent.env; set +a; "
                "/opt/asset-sync/.venv/bin/asset-sync enroll --token-file /etc/asset-sync/enrollment.token; "
                "rm /etc/asset-sync/enrollment.token", token.encode())
            client.post("/api/v1/auth/logout").raise_for_status()
        print("Sensor enrolled with an individual key; enrollment token deleted.")
    print(remote("/opt/asset-sync/.venv/bin/python /opt/asset-sync/scripts/pin-sensor-server.py"))
    started = datetime.now(UTC)
    print(remote("systemctl disable honeyforge-agent.service 2>/dev/null || true; "
        "systemctl enable --now asset-sync.service; systemctl restart asset-sync.service; "
        "systemctl is-active asset-sync.service"))
    with httpx.Client(base_url="http://127.0.0.1:8100", trust_env=False) as client:
        client.post("/api/v1/auth/login", json={"username": settings.admin_username, "password": settings.admin_password}).raise_for_status()
        for _ in range(30):
            if any(host["address"] == ip and host["status"] in {"online", "degraded"}
                and datetime.fromisoformat(host["last_seen"].replace("Z", "+00:00")) >= started
                for host in client.get("/api/v1/hosts").json()):
                break
            time.sleep(1)
        else:
            raise RuntimeError("Sensor has not reported a fresh heartbeat. Check its service; a revoked key requires explicit --reenroll.")
    print("Lab sensor ready at " + ip)


if __name__ == "__main__":
    main()
