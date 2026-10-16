import json
import socket
import subprocess
import sys
import time
from typing import Protocol
from uuid import UUID

import docker
from docker.errors import ImageNotFound, NotFound

from honeyforge.domain.profiles import validate_profile


class Adapter(Protocol):
    def environment(self, config: dict) -> dict: ...
    def container_port(self) -> int: ...
    def user(self) -> str: ...
    def writable_paths(self) -> dict: ...


class HttpAdapter:
    def environment(self, config):
        return {"PROFILE_CONFIG": json.dumps(config)}

    def container_port(self):
        return 8080

    def user(self):
        return "10001:10001"

    def writable_paths(self):
        return {"/tmp": "rw,nosuid,nodev,noexec,size=8m,mode=1777"}


class CowrieAdapter(HttpAdapter):
    def container_port(self):
        return 2222

    def user(self):
        return "999:999"

    def writable_paths(self):
        return {"/tmp": "rw,nosuid,nodev,noexec,size=8m,mode=1777",
            "/cowrie/cowrie-git/etc": "rw,nosuid,nodev,noexec,size=8m,uid=999,gid=999,mode=0750",
            "/cowrie/cowrie-git/var": "rw,nosuid,nodev,noexec,size=32m,uid=999,gid=999,mode=0750"}


class TcpAdapter(HttpAdapter):
    def container_port(self):
        return 9000


class DockerRuntime:
    """Allowlisted adapters. No operator-provided image, command, mount or privilege."""
    def __init__(self, settings, client=None, host_id="development"):
        # Container restoration after a sensor reboot can exceed the SDK's
        # default 60-second request timeout on slower Windows-hosted VMs.
        self.settings, self.client = settings, client or docker.from_env(timeout=180)
        self.host_id = host_id
        self.adapters = {"http": HttpAdapter(), "cowrie": CowrieAdapter(), "tcp-banner": TcpAdapter()}
        self.images = {"http": settings.http_image, "cowrie": settings.cowrie_image, "tcp-banner": settings.tcp_image}

    def _name(self, spec):
        return "hf-" + spec["deployment_id"]

    def get(self, spec):
        try:
            container = self.client.containers.get(self._name(spec))
            if container.labels.get("hf.agent") != self.host_id:
                raise RuntimeError("Runtime name is owned by a different agent")
            return container
        except NotFound:
            return None

    def apply(self, spec, progress):
        self.verify_isolation()
        self.configure_network_policy(spec["deployment_id"], spec["generation"])
        config = validate_profile(spec["config"]).model_dump(mode="json")
        if config["adapter"] != spec["adapter"]:
            raise ValueError("Adapter mismatch")
        adapter = self.adapters[spec["adapter"]]
        existing = self.get(spec)
        if existing and existing.status == "running" and existing.labels.get("hf.generation") == spec["generation"]:
            progress("Проверка работающей ловушки")
            return existing
        if existing:
            existing.remove(force=True, v=True)
        progress("Проверка образа")
        try:
            image = self.client.images.get(self.images[spec["adapter"]])
        except ImageNotFound:
            # Installation preloads images, but an agent can pull an allowlisted image on demand.
            image = self.client.images.pull(self.images[spec["adapter"]])
        network_name = "hf-net-" + spec["deployment_id"]
        try:
            network = self.client.networks.get(network_name)
        except NotFound:
            network = self.client.networks.create(network_name, internal=False, enable_ipv6=False,
                driver="bridge", labels={"hf.managed": "true", "hf.deployment": spec["deployment_id"]},
                options={"com.docker.network.bridge.name": "hf" + spec["deployment_id"].replace("-", "")[:10],
                    "com.docker.network.bridge.enable_icc": "false"})
        progress("Запуск в изолированной сети")
        environment = adapter.environment(config)
        environment["DECOY_TOKENS"] = json.dumps(spec.get("honeytokens", []))
        if spec.get("capture_key"):
            environment.update(CAPTURE_PUBLIC_KEY=spec["capture_key"]["public_key"],
                CAPTURE_KEY_ID=spec["capture_key"]["key_id"], CAPTURE_HOST_ID=self.host_id,
                CAPTURE_DEPLOYMENT_ID=spec["deployment_id"], CAPTURE_GENERATION=spec["generation"])
        container = self.client.containers.run(image.id, detach=True, name=self._name(spec),
            hostname=config["hostname"], environment=environment,
            ports={f"{adapter.container_port()}/tcp": (self.settings.agent_bind, spec["port"])},
            network=network.name, user=adapter.user(), read_only=True, cap_drop=["ALL"],
            security_opt=["no-new-privileges:true"], tmpfs=adapter.writable_paths(), dns=["127.0.0.1"],
            mem_limit=f'{config["limits"]["memory_mb"]}m', memswap_limit=f'{config["limits"]["memory_mb"]}m',
            nano_cpus=int(config["limits"]["cpu"] * 1e9), pids_limit=config["limits"]["pids"],
            log_config=docker.types.LogConfig(type="json-file", config={"max-size": "10m", "max-file": "3"}),
            labels={"hf.managed": "true", "hf.agent": self.host_id, "hf.deployment": spec["deployment_id"], "hf.generation": spec["generation"],
                "hf.ssh-control": "1" if spec["adapter"] == "cowrie" else "0",
                "hf.revision": str(spec["revision"]), "hf.adapter": spec["adapter"]},
            restart_policy={"Name": "no"})
        progress("Проверка готовности сервиса")
        host = "127.0.0.1" if self.settings.agent_bind == "0.0.0.0" else self.settings.agent_bind
        # Cowrie can take longer to start after Docker restores a Windows-hosted VM.
        readiness_attempts = 180 if spec["adapter"] == "cowrie" else 30
        for _ in range(readiness_attempts):
            container.reload()
            if container.status != "running":
                logs = container.logs(tail=10).decode(errors="replace")
                container.remove(force=True, v=True)
                raise RuntimeError("Sensor failed readiness: " + logs[-400:])
            try:
                with socket.create_connection((host, spec["port"]), timeout=0.5) as connection:
                    if spec["adapter"] in {"cowrie", "tcp-banner"}:
                        if spec["adapter"] == "tcp-banner":
                            if not connection.recv(512).startswith(config["banner"].encode()):
                                raise OSError("TCP banner not ready")
                            return container
                        if not connection.recv(256).startswith(b"SSH-2.0-"):
                            raise OSError("SSH banner not ready")
                    else:
                        connection.sendall(b"HEAD / HTTP/1.0\r\n\r\n")
                        if not connection.recv(64).startswith(b"HTTP/"):
                            raise OSError("HTTP response not ready")
                return container
            except OSError:
                time.sleep(0.3)
        logs = container.logs(tail=10).decode(errors="replace")
        container.remove(force=True, v=True)
        raise RuntimeError("Service readiness timed out: " + logs[-400:])

    def terminate_sessions(self, policy):
        container = self.get({"deployment_id": str(policy.deployment_id)})
        if not container or container.labels.get("hf.generation") != str(policy.generation):
            raise RuntimeError("SSH runtime generation is unavailable")
        if container.labels.get("hf.adapter") != "cowrie" or container.labels.get("hf.ssh-control") != "1":
            return {"termination_state": "unsupported", "terminated_sessions": [],
                "termination_error": "Redeploy with the SSH session control adapter"}
        from ipaddress import IPv4Address

        from honeyforge.application.schemas import PolicyAck
        address = str(IPv4Address(policy.source_ip))
        result = container.exec_run(["/cowrie/cowrie-env/bin/python3", "/app/cowrie_control.py",
            address, str(policy.id), str(policy.revision)], user="999:999")
        if result.exit_code != 0 or len(result.output) > 65536:
            raise RuntimeError("Local SSH termination could not be verified")
        report = PolicyAck.model_validate({"revision": policy.revision, "state": "applied", **json.loads(result.output)})
        return report.model_dump(include={"termination_state", "terminated_sessions", "termination_error"})

    def verify_isolation(self):
        """Fail closed: published bridges require preinstalled host and forward egress rules."""
        if sys.platform != "linux":
            raise RuntimeError("Run sensor agents on a dedicated Linux host with the HoneyForge firewall")
        for chain, target in (("DOCKER-USER", "HF-EGRESS"), ("INPUT", "HF-HOST")):
            subprocess.run(["iptables", "-w", "-C", chain, "-i", "hf+", "-j", target],
                check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

            subprocess.run(["iptables", "-w", "-C", target, "-j", "DROP"],
                check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def configure_network_policy(self, deployment_id, generation):
        """Dedicated counters attribute dropped packets to exactly one trap bridge."""
        key = UUID(deployment_id).hex
        bridge, chain = "hf" + key[:10], "HF-D-" + UUID(generation).hex[:16]
        def command(*args):
            return subprocess.run(["iptables", "-w", *args],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if command("-S", chain).returncode:
            command("-N", chain).check_returncode()
            command("-A", chain, "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "RETURN").check_returncode()
            command("-A", chain, "-j", "DROP").check_returncode()
        for parent in ("HF-EGRESS", "HF-HOST"):
            if command("-C", parent, "-i", bridge, "-j", chain).returncode:
                command("-I", parent, "1", "-i", bridge, "-j", chain).check_returncode()
        return chain

    def capabilities(self):
        return ["http", "cowrie", "tcp-banner"]

    def close(self):
        pass

    def stop(self, spec):
        container = self.get(spec)
        if container:
            container.stop(timeout=5)
            # Keep logs until the collector has drained them; remove before next apply.

    def observe(self, spec):
        container = self.get(spec)
        if not container:
            return "stopped", ""
        container.reload()
        if container.labels.get("hf.generation") != spec["generation"]:
            return "error", ""
        return ("running" if container.status == "running" else "stopped"), container.image.id
