"""Create/reuse reproducible synthetic profiles on the current enrolled lab sensor."""
import argparse
import json
import time
from pathlib import Path

import httpx

from honeyforge.infrastructure.settings import settings


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upgrade", action="store_true", help="Publish v2 without modifying any historical version")
    parser.add_argument("--refresh", action="store_true", help="Explicitly redeploy current versions with the installed adapters")
    args = parser.parse_args()
    with httpx.Client(base_url="http://127.0.0.1:8100", trust_env=False, timeout=15) as client:
        response = client.post("/api/v1/auth/login", json={"username": settings.admin_username, "password": settings.admin_password})
        response.raise_for_status()
        client.headers["X-CSRF-Token"] = response.json()["csrf_token"]
        hosts = client.get("/api/v1/hosts").json()
        host = next((h for h in hosts if h["address"] == "192.168.139.142" and h["status"] in {"online", "degraded"}), None)
        if not host:
            raise RuntimeError("Provision the isolated lab sensor and wait for its heartbeat first")
        profiles = client.get("/api/v1/profiles").json()
        deployments = client.get("/api/v1/deployments").json()
        scenarios = [
            ("tcp-banner", "Legacy maintenance banner · LIVE", 2223, {"schema_version": 2,
                "adapter": "tcp-banner", "hostname": "maintenance-stage-01", "persona": "Maintenance operations",
                "recommended_port": 2223, "banner": "SSH-2.0-OpenSSH_8.9p1", "response": "Protocol mismatch."}),
            ("http", "Finance intranet · LIVE", 18080, {"adapter": "http", "hostname": "finance-stage-02",
                "persona": "Finance Operations", "template": "asset-console", "decoy_files": [
                    {"path": "/opt/decoy/backup-notes.txt", "content": "SYNTHETIC LAB DATA\nBackup schedule: 02:00 UTC\nOwner: Finance Operations\n"}]}),
            ("cowrie", "Operations bastion · LIVE", 2222, {"adapter": "cowrie", "hostname": "ops-bastion-03",
                "persona": "Operations maintenance", "decoy_files": [
                    {"path": "/home/admin/backup-notes.txt", "content": "SYNTHETIC LAB DATA\nMaintenance window: Sunday 02:00 UTC\nBackup host: backup-stage-04\n"}]}),
            ("http-vault", "File staging · LIVE", 18081, {"adapter": "http", "hostname": "files-stage-04",
                "persona": "Internal File Services", "template": "file-vault", "decoy_files": [
                    {"path": "/var/www/release-notes.txt", "content": "SYNTHETIC LAB DATA\nStaging release: 2026.10\nApproval: pending\n"}]}),
        ]
        metadata = {"host": {"id": host["id"], "address": host["address"], "name": host["name"]}, "deployments": []}
        for key, name, port, config in scenarios:
            profile_name = "Demo: " + name
            profile = next((p for p in profiles if p["name"] == profile_name), None)
            if profile is None:
                response = client.post("/api/v1/profiles", json={"name": profile_name,
                    "description": "Controlled hackathon demonstration. All resources are synthetic.", "config": config})
                response.raise_for_status()
                profile = response.json()
            if args.upgrade and profile["versions"][0]["config"]["schema_version"] == 1:
                config = {**profile["versions"][0]["config"], "schema_version": 2, "recommended_port": port,
                    "decoy_accounts": [{"username": "root", "password": "hackathon-demo"},
                        {"username": "admin", "password": "hackathon-demo"}]}
                response = client.post(f'/api/v1/profiles/{profile["id"]}/versions', json={"config": config})
                response.raise_for_status()
                profile = client.get(f'/api/v1/profiles/{profile["id"]}').json()
            # Reuse the current runtime, including a newer published profile. A fixed
            # idempotency key must never be reused with a changed request body.
            deployment = next((d for d in deployments if d["name"] == name and d["host_id"] == host["id"]
                and d["port"] == port), None)
            if deployment is None:
                response = client.post("/api/v1/deployments", headers={"Idempotency-Key": f"lab-live-{host['id']}-{key}"},
                    json={"name": name, "host_id": host["id"], "profile_version_id": profile["versions"][0]["id"], "port": port})
                response.raise_for_status()
                deployment = response.json()
            if deployment["state"] == "stopped" or args.refresh or (args.upgrade and deployment["profile_version_id"] != profile["versions"][0]["id"]):
                response = client.post("/api/v1/deployments/" + deployment["id"] + "/redeploy",
                    json={"profile_version_id": profile["versions"][0]["id"]} if args.upgrade else {})
                response.raise_for_status()
            for _ in range(60):
                response = client.get("/api/v1/deployments/" + deployment["id"])
                response.raise_for_status()
                deployment = response.json()
                if deployment["state"] == "running":
                    break
                if deployment["state"] in {"error", "unknown"}:
                    raise RuntimeError(f"{name}: {deployment['state']}; inspect the deployment job")
                time.sleep(1)
            else:
                raise RuntimeError(f"{name}: deployment did not become ready")
            metadata["deployments"].append({k: deployment[k] for k in ("id", "name", "endpoint", "adapter", "runtime_generation", "profile_version_id")})
            print(name + " running at " + deployment["endpoint"])
        path = Path(".runtime/demo.json")
        path.parent.mkdir(exist_ok=True, mode=0o700)
        if path.exists() and not Path(".runtime/demo.previous.json").exists():
            previous = Path(".runtime/demo.previous.json")
            previous.write_bytes(path.read_bytes())
            previous.chmod(0o600)
        path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n")
        path.chmod(0o600)
        client.post("/api/v1/auth/logout").raise_for_status()
        print("Current demo endpoints saved in .runtime/demo.json; credentials were not logged.")


if __name__ == "__main__":
    main()
