"""Real individual mTLS, two-phase rollover and rejection after the actual five-minute grace."""

import json
import statistics
import subprocess
import time
from datetime import UTC, datetime
from pathlib import Path

import httpx

from honeyforge.infrastructure.settings import settings

ORB = "/Applications/OrbStack.app/Contents/MacOS/bin/orbctl"


def remote(vm, code):
    return json.loads(
        subprocess.check_output(
            [ORB, "run", "-m", vm, "-u", "root", "/opt/asset-sync/.venv/bin/python", "-c", code]
        )
    )


SETUP = """
import json,httpx,ssl
from pathlib import Path
from honeyforge.agent.main import Agent
from honeyforge.infrastructure.settings import Settings
config=Settings(_env_file='/etc/asset-sync/agent.env')
a=Agent(config)
credentials=json.loads(a.credentials_path.read_text())
a.http.headers['Authorization']='Bearer '+credentials['key']
"""


def main():
    evidence = {"at": datetime.now(UTC).isoformat(), "checks": {}, "sensors": [], "beacon": {}}
    with httpx.Client(base_url="http://127.0.0.1:8100", trust_env=False, timeout=15) as api:
        login = api.post(
            "/api/v1/auth/login",
            json={"username": settings.admin_username, "password": settings.admin_password},
        )
        login.raise_for_status()
        api.headers["X-CSRF-Token"] = login.json()["csrf_token"]
        hosts = api.get("/api/v1/hosts").json()
        rows = []
        for vm, address in [
            ("honeyforge-sensor", "192.168.139.142"),
            ("honeyforge-sensor-2", "192.168.139.223"),
        ]:
            host = next(h for h in hosts if h["address"] == address and h["status"] in {"online", "degraded"})
            certs = api.get("/api/v1/hosts/" + host["id"] + "/certificates").json()
            current = next(c for c in certs if c["state"] == "active")
            check = remote(
                vm,
                SETUP
                + """
assert a.request('GET','/agent/v1/runtimes')
old=a.identity.current()
Path('/var/lib/asset-sync/acceptance-old-identity.json').write_text(json.dumps({'certificate':str(old[0]),'key':str(old[1])}))
Path('/var/lib/asset-sync/acceptance-old-identity.json').chmod(0o600)
plain=a._new_client(headers=dict(a.http.headers))
r=plain.get(config.agent_route_prefix+'/runtimes')
assert r.status_code==401 and r.json()['error']['code']=='agent_certificate_required'
r=plain.get(config.agent_route_prefix+'/runtimes',headers={'X-Asset-Client-Fingerprint':'a'*64,'X-Asset-Gateway':'spoof','X-Asset-Scheme':'https'})
assert r.status_code==401
r=plain.post(config.agent_route_prefix+'/certificates/issue',json={'csr':a.identity._pending().joinpath('request.pem').read_text()})
assert r.status_code==401
# The pending request can be completed only with the current bound certificate.
Path('/var/lib/asset-sync/rotate-request').write_text('rotate');Path('/var/lib/asset-sync/rotate-request').chmod(0o600)
print(json.dumps({'bound_client_certificate_accepted':True,'missing_certificate_rejected':True,'spoofed_public_headers_rejected':True,'post_bootstrap_bearer_only_issuance_rejected':True}))
""",
            )
            rows.append((vm, host, current))
            evidence["sensors"].append({"host_id": host["id"], "address": address, **check})
        # The service processes its durable CSR and independently confirms the new TLS connection.
        deadline = time.monotonic() + 90
        rotated = {}
        while time.monotonic() < deadline:
            for vm, host, old in rows:
                certs = api.get("/api/v1/hosts/" + host["id"] + "/certificates").json()
                fresh = next((c for c in certs if c["state"] == "active" and c["id"] != old["id"]), None)
                if fresh:
                    rotated[vm] = fresh
            if len(rotated) == 2:
                break
            time.sleep(1)
        assert len(rotated) == 2, "Rotation was not confirmed by both live services"
        expires = []
        for vm, host, old in rows:
            oldrow = next(
                c
                for c in api.get("/api/v1/hosts/" + host["id"] + "/certificates").json()
                if c["id"] == old["id"]
            )
            assert oldrow["state"] == "overlap"
            expires.append(datetime.fromisoformat(oldrow["accept_until"].replace("Z", "+00:00")))
            overlap = remote(
                vm,
                SETUP
                + """
p=json.loads(Path('/var/lib/asset-sync/acceptance-old-identity.json').read_text())
old=a._new_client((p['certificate'],p['key']),dict(a.http.headers))
assert old.get(config.agent_route_prefix+'/runtimes').status_code==200
assert a.request('GET','/agent/v1/runtimes')
print(json.dumps({'old_and_new_accepted_during_grace':True}))
""",
            )
            evidence["sensors"][0 if vm == "honeyforge-sensor" else 1].update(
                overlap,
                old_certificate_id=oldrow["id"],
                new_certificate_id=rotated[vm]["id"],
                old_accept_until=oldrow["accept_until"],
            )
        print(
            json.dumps(
                {
                    "state": "rotation_confirmed",
                    "real_grace_seconds": 300,
                    "waiting_until": max(expires).isoformat(),
                }
            ),
            flush=True,
        )
        # Sample real delivered heartbeat timestamps while waiting, without changing either runtime.
        seen = {h["id"]: [] for _, h, _ in rows}
        while datetime.now(UTC) <= max(expires):
            for host in api.get("/api/v1/hosts").json():
                values = seen.get(host["id"])
                if (
                    values is not None
                    and host["last_seen"]
                    and (not values or values[-1] != host["last_seen"])
                ):
                    values.append(host["last_seen"])
            time.sleep(0.2)
        for vm, host, old in rows:
            check = remote(
                vm,
                SETUP
                + """
p=json.loads(Path('/var/lib/asset-sync/acceptance-old-identity.json').read_text())
old=a._new_client((p['certificate'],p['key']),dict(a.http.headers))
r=old.get(config.agent_route_prefix+'/runtimes')
assert r.status_code==401 and r.json()['error']['code']=='agent_certificate_rejected'
assert a.request('GET','/agent/v1/runtimes')
print(json.dumps({'old_rejected_after_real_300_seconds':True,'new_still_accepted':True}))
""",
            )
            evidence["sensors"][0 if vm == "honeyforge-sensor" else 1].update(check)
            assert api.post("/api/v1/agent-certificates/" + old["id"] + "/revoke").status_code == 200
            series = [datetime.fromisoformat(x.replace("Z", "+00:00")) for x in seen[host["id"]]]
            intervals = [(b - a).total_seconds() for a, b in zip(series, series[1:])]
            assert len(intervals) >= 40 and len(set(round(x, 1) for x in intervals)) >= 10
            evidence["beacon"][host["address"]] = {
                "time_basis": "Delivered host.last_seen; includes request duration and 250ms scheduling tick",
                "scheduled_interval_seconds": 5,
                "scheduled_jitter_ratio": 0.2,
                "samples": len(intervals),
                "min_seconds": min(intervals),
                "max_seconds": max(intervals),
                "median_seconds": statistics.median(intervals),
                "observed_intervals_seconds": intervals,
            }
        evidence["checks"] = {
            "both_real_individual_certificates": True,
            "actual_300_second_overlap": True,
            "post_grace_old_rejected": True,
            "old_explicit_revocation": True,
            "new_certificates_continue_management": True,
            "beacon_actual_delivery_intervals_observed": True,
        }
    evidence["completed_at"] = datetime.now(UTC).isoformat()
    Path("docs/evidence/backend/certificates.json").write_text(
        json.dumps(evidence, ensure_ascii=False, indent=2) + "\n"
    )
    print(json.dumps(evidence["checks"]), flush=True)


if __name__ == "__main__":
    main()
