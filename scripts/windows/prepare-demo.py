"""Run inside the centre API container; deploy real traps on an explicitly enrolled sensor."""
import sys
import time

import httpx

from honeyforge.infrastructure.settings import settings


def prepare(address: str):
    with httpx.Client(base_url="http://127.0.0.1:8100", trust_env=False, timeout=20) as client:
        response = client.post("/api/v1/auth/login", json={
            "username": settings.admin_username, "password": settings.admin_password,
        })
        response.raise_for_status()
        # Container-local administration still supplies the exact authorised origin and CSRF.
        # Secure cookies remain secure in the product; only this trusted local client supplies its session.
        client.headers.update({"Origin": settings.public_origin,
            "X-CSRF-Token": response.json()["csrf_token"],
            "Cookie": "; ".join(f"{k}={v}" for k, v in response.cookies.items())})

        def request(method, path, **kwargs):
            result = client.request(method, path, **kwargs)
            result.raise_for_status()
            return result.json()

        try:
            hosts = request("GET", "/api/v1/hosts")
            matches = [h for h in hosts if h["address"] == address and h["status"] in {"online", "degraded"}]
            if len(matches) != 1:
                raise RuntimeError("Expected exactly one enrolled online sensor with this address. Check Hosts.")
            host = matches[0]
            print(f"Sensor {host['name']} status: {host['status']}")
            profiles = request("GET", "/api/v1/profiles")
            deployments = request("GET", "/api/v1/deployments")
            for adapter, port, title in [
                ("tcp-banner", 2223, "Low maintenance banner"),
                ("cowrie", 2222, "Medium operations SSH"),
                ("http", 18080, "Medium finance HTTP"),
            ]:
                name = "Windows demo: " + title
                config = {"schema_version": 2, "adapter": adapter, "hostname": "stage-operations-01",
                    "persona": "Operations", "recommended_port": port,
                    "decoy_accounts": [{"username": "root", "password": "hackathon-demo"}]}
                if adapter == "cowrie":
                    config["decoy_files"] = [{"path": "/home/admin/backup-notes.txt",
                        "content": "SYNTHETIC DEMO DATA\nMaintenance window: Sunday 02:00 UTC\n"}]
                profile = next((p for p in profiles if p["name"] == name), None)
                if profile and profile.get("archived_at"):
                    raise RuntimeError(f"Restore archived profile {name} explicitly before running Demo.")
                if profile is None:
                    profile = request("POST", "/api/v1/profiles", json={"name": name,
                        "description": "Synthetic, reproducible Windows demonstration; real runtime events only.",
                        "config": config})
                version = profile["versions"][0]["id"]
                existing = [d for d in deployments if d["name"] == name and d["host_id"] == host["id"]]
                if len(existing) > 1:
                    raise RuntimeError(f"Duplicate demo deployment {name}; review Traps manually.")
                deployment = existing[0] if existing else request("POST", "/api/v1/deployments",
                    headers={"Idempotency-Key": f"windows-demo-{host['id']}-{adapter}"},
                    json={"name": name, "host_id": host["id"], "profile_version_id": version, "port": port})
                if deployment["state"] in {"stopped", "error", "unknown"}:
                    request("POST", f"/api/v1/deployments/{deployment['id']}/redeploy", json={})
                deadline = time.monotonic() + 180
                while time.monotonic() < deadline:
                    deployment = request("GET", f"/api/v1/deployments/{deployment['id']}")
                    if deployment["state"] == "running":
                        print(f"{name}: {deployment['endpoint']} ({deployment['id']})")
                        break
                    if deployment["state"] in {"error", "unknown"}:
                        raise RuntimeError(f"{name}: {deployment['state']}; review the job in Traps.")
                    time.sleep(2)
                else:
                    raise TimeoutError(f"{name}: no confirmed Running state within 180 seconds.")
        finally:
            request("POST", "/api/v1/auth/logout")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Provide the explicitly enrolled sensor IPv4 address.")
    prepare(sys.argv[1])
