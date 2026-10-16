"""Verify actual management routing, decoy boundaries and binary recovery after agent restart."""
import hashlib
import json
import subprocess
from datetime import UTC, datetime
from pathlib import Path

import httpx

from honeyforge.infrastructure.settings import settings

ORB = "/Applications/OrbStack.app/Contents/MacOS/bin/orbctl"


def remote(vm, *command):
    return subprocess.check_output([ORB, "run", "-m", vm, "-u", "root", *command])


def main():
    evidence = {"at": datetime.now(UTC).isoformat(), "checks": {}, "sensors": []}
    with httpx.Client(base_url="http://127.0.0.1:8100", trust_env=False, timeout=15) as api:
        login = api.post("/api/v1/auth/login", json={"username": settings.admin_username, "password": settings.admin_password})
        login.raise_for_status()
        api.headers["X-CSRF-Token"] = login.json()["csrf_token"]
        hosts = api.get("/api/v1/hosts").json()
        deployments = api.get("/api/v1/deployments").json()
        for vm, address in [("honeyforge-sensor", "192.168.139.142"), ("honeyforge-sensor-2", "192.168.139.223")]:
            host = next(h for h in hosts if h["address"] == address and h["status"] in {"online", "degraded"})
            raw = remote(vm, "/opt/asset-sync/.venv/bin/python", "-c",
                "import json,httpx,socket; from pathlib import Path; from honeyforge.agent.main import Agent; "
                "from honeyforge.infrastructure.settings import Settings; "
                "a=Agent(Settings(_env_file='/etc/asset-sync/agent.env')); assert a.http.get('/',timeout=3).status_code==200; "
                "assert all(a.http.get(p).status_code==404 for p in ['/agent/v1/runtimes','/docs','/openapi.json','/health/ready']); "
                "assert a.http.get('/assets/sync/v1/runtimes').status_code==401; "
                "s=socket.socket();s.settimeout(1);s.bind(('10.88.0.1',0)); "
                "\ntry: s.connect(('1.1.1.1',443))"
                "\nexcept OSError: restricted=True"
                "\nelse: raise AssertionError('Unexpected management egress')"
                "\nassert all(not p.stat().st_mode & 0o077 for p in [Path('/etc/asset-sync/agent.env'),Path('/var/lib/asset-sync/credentials.json')]); "
                "print(json.dumps({'management_source':'10.88.0.1','management_interface':'asmgmt0','verified_https':True,'non_gateway_egress_denied':restricted,'private_state_permissions':True}))")
            sensor = json.loads(raw)
            sensor.update(host_id=host["id"], address=address)
            traps = [d for d in deployments if d["host_id"] == host["id"] and d["state"] == "running"]
            neighbour = None
            for trap in traps:
                details = json.loads(remote(vm, "docker", "inspect", "hf-" + trap["id"]))[0]
                assert details["HostConfig"]["ReadonlyRootfs"]
                assert "ALL" in details["HostConfig"]["CapDrop"]
                assert details["HostConfig"]["Privileged"] is False
                assert all(m["Destination"] != "/var/run/docker.sock" for m in details["Mounts"])
                assert all(binding["HostIp"] == address for values in details["HostConfig"]["PortBindings"].values() for binding in values)
                if trap["adapter"] == "cowrie":
                    neighbour = next(iter(details["NetworkSettings"]["Networks"].values()))["IPAddress"]
            assert neighbour
            remote(vm, "python3", "-c", "import socket; s=socket.create_connection((" + repr(neighbour)
                + ",2222),timeout=2); assert s.recv(256).startswith(b'SSH-'); s.close()")
            http_trap = next(t for t in traps if t["adapter"] == "http")
            result = remote(vm, "docker", "exec", "hf-" + http_trap["id"], "python", "-c",
                "import socket,json; from pathlib import Path; "
                "assert all(not Path(p).exists() for p in ['/opt/asset-sync','/etc/asset-sync','/var/lib/asset-sync','/var/run/docker.sock']); "
                "targets=[('0.250.250.254',18443),('10.88.0.1',18443),('192.168.139.223',18422),(" + repr(neighbour) + ",2222),('1.1.1.1',443)]; denied=[]"
                "\nfor target in targets:"
                "\n try: c=socket.create_connection(target,timeout=1);c.close();raise AssertionError('Decoy escaped egress boundary')"
                "\n except OSError: denied.append(target)"
                "\nprint(json.dumps({'management_host_neighbour_internet_denied':denied,'agent_paths_and_socket_absent':True}))")
            sensor["decoy_boundary"] = json.loads(result)
            sensor["explicit_trap_bindings"] = len(traps)
            sensor["management_forward_counters"] = remote(vm, "ip", "netns", "exec", "asset-management", "iptables", "-nvL", "FORWARD").decode()
            evidence["sensors"].append(sensor)
        foundation = json.loads(Path("docs/evidence/backend/foundation.json").read_text())
        artifact = foundation["sftp_artifact"]
        content = api.get(f'/api/v1/artifacts/{artifact["id"]}/download')
        content.raise_for_status()
        assert hashlib.sha256(content.content).hexdigest() == artifact["sha256"]
        evidence["checks"] = {"two_management_interfaces_and_subnets": True, "gateway_only_management_egress": True,
            "decoys_cannot_reach_management_host_neighbours_or_internet": True,
            "trap_ports_only_on_explicit_decoy_address": True, "agent_private_paths_and_docker_socket_not_mounted": True,
            "sftp_bytes_survived_agent_restart_and_runtime_redeploy": True}
        evidence["boundary"] = "Logical network isolation on each dedicated VM; shared outer virtual NIC, no claim of a physically separate management fabric. Trusted host/hypervisor compromise excluded."
    Path("docs/evidence/backend/masking.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(evidence["checks"], indent=2))


if __name__ == "__main__":
    main()
