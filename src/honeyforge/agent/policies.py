"""Persisted, typed source policies with a local expiry worker independent of API connectivity."""
import os
import socket
import subprocess
import threading
from datetime import UTC, datetime
from ipaddress import IPv4Address
from pathlib import Path
from uuid import UUID

from pydantic import TypeAdapter

from honeyforge.application.schemas import AgentPolicy


class SourceFirewall:
    def __init__(self, runtime, protected_addresses=()):
        self.runtime = runtime
        self.protected = set(protected_addresses)

    @staticmethod
    def names(deployment_id):
        key = UUID(str(deployment_id)).hex
        return "hf" + key[:10], "HF-B-" + key[:16]

    def command(self, *args, check=True):
        return subprocess.run(["iptables", "-w", "5", *args], check=check, timeout=10,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def terminate(self, policy):
        return self.runtime.terminate_sessions(policy)

    def apply(self, policies, instant):
        try:
            containers = self.runtime.client.containers.list(all=True,
                filters={"label": ["hf.managed=true", f"hf.agent={self.runtime.host_id}"]})
        except Exception:
            # Expired rules still have to be removed when the Docker API is unavailable.
            containers = []
        owned = {c.labels["hf.deployment"]: c for c in containers}
        groups = {key: set() for key in owned}
        states = {}
        for policy in policies:
            key = str(policy.deployment_id)
            groups.setdefault(key, set())
            active = policy.desired_state == "blocked" and policy.expires_at > instant
            if not active:
                states[str(policy.id)] = "released"
                continue
            address = IPv4Address(policy.source_ip)
            if address.is_loopback or address.is_link_local or address.is_unspecified or address.is_multicast or str(address) == "255.255.255.255" or str(address) in self.protected:
                states[str(policy.id)] = "error"
                continue
            container = owned.get(key)
            if not container or container.labels.get("hf.generation") != str(policy.generation):
                states[str(policy.id)] = "error"
                continue
            groups[key].add(str(address))
            states[str(policy.id)] = "applied"
        for deployment_id, sources in groups.items():
            bridge, chain = self.names(deployment_id)
            if self.command("-S", chain, check=False).returncode:
                self.command("-N", chain)
            # iptables-restore commits each table atomically: no flush/add window on a live policy.
            lines = ["*filter", f"-F {chain}"]
            lines += [f"-A {chain} -s {source}/32 -m conntrack --ctstate NEW -j DROP" for source in sorted(sources)]
            lines.append("COMMIT")
            subprocess.run(["iptables-restore", "-w", "5", "--noflush"], input="\n".join(lines) + "\n",
                text=True, check=True, timeout=10, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if self.command("-C", "DOCKER-USER", "-o", bridge, "-j", chain, check=False).returncode:
                self.command("-I", "DOCKER-USER", "1", "-o", bridge, "-j", chain)
            for source in sources:
                self.command("-C", chain, "-s", source + "/32", "-m", "conntrack", "--ctstate", "NEW", "-j", "DROP")
        return states


class PolicyExecutor:
    def __init__(self, path: Path, firewall, clock=None):
        self.path, self.firewall = path, firewall
        self.clock = clock or (lambda: datetime.now(UTC))
        self.lock = threading.Lock()
        self.stopping = threading.Event()
        self.policies = TypeAdapter(list[AgentPolicy]).validate_json(path.read_text()) if path.exists() else []
        self.reports = []
        self.thread = None

    def persist(self):
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        temporary = self.path.with_suffix(".tmp")
        with temporary.open("w") as target:
            os.chmod(temporary, 0o600)
            target.write(TypeAdapter(list[AgentPolicy]).dump_json(self.policies).decode())
            target.flush()
            os.fsync(target.fileno())
        temporary.replace(self.path)
        directory = os.open(self.path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)

    def reconcile(self, snapshot=None):
        with self.lock:
            if snapshot is not None:
                if len(snapshot) > 1000:
                    raise ValueError("Policy snapshot exceeds the supported limit")
                incoming = TypeAdapter(list[AgentPolicy]).validate_python(snapshot)
                revisions = {str(p.id): p.revision for p in self.policies}
                if any(p.revision < revisions.get(str(p.id), 0) for p in incoming):
                    raise ValueError("Policy snapshot contains a stale revision")
                # Include removals for one reconciliation so an omitted policy cannot leave a rule behind.
                incoming_ids = {str(p.id) for p in incoming}
                removed = [p.model_copy(update={"desired_state": "released"}) for p in self.policies if str(p.id) not in incoming_ids]
                self.policies = incoming + removed
                self.persist()
            try:
                states = self.firewall.apply(self.policies, self.clock())
                self.reports = []
                for p in self.policies:
                    state = states[str(p.id)]
                    termination = {"termination_state": "pending" if p.terminate_sessions else "not_requested",
                        "terminated_sessions": [], "termination_error": None}
                    if state == "applied" and p.terminate_sessions:
                        try:
                            termination = self.firewall.terminate(p)
                        except Exception:
                            termination = {"termination_state": "error", "terminated_sessions": [],
                                "termination_error": "SSH transport termination could not be verified"}
                    self.reports.append({"id": str(p.id), "revision": p.revision, "state": state,
                        "error": "The runtime or source policy could not be verified" if state == "error" else None,
                        **termination})
                if snapshot is not None:
                    self.policies = incoming
                    self.reports = [r for r in self.reports if r["id"] in incoming_ids]
                    self.persist()
            except Exception:
                # Never report applied on an unverified partial update; retry in the next local tick.
                self.reports = [{"id": str(p.id), "revision": p.revision, "state": "error",
                    "error": "Source policy could not be verified on the sensor"} for p in self.policies]
            return [dict(r) for r in self.reports]

    def start(self):
        self.reconcile()

        def expire():
            while not self.stopping.wait(0.5):
                with self.lock:
                    due = any(p.desired_state == "blocked" and p.expires_at <= self.clock()
                        and next((r["state"] for r in self.reports if r["id"] == str(p.id)), None) != "released" for p in self.policies)
                if due:
                    self.reconcile()

        self.thread = threading.Thread(target=expire, name="policy-expiry", daemon=True)
        self.thread.start()

    def close(self):
        self.stopping.set()
        if self.thread:
            self.thread.join(timeout=20)


def protected_addresses(hostnames):
    result = set()
    for hostname in hostnames:
        if not hostname:
            continue
        for address in socket.getaddrinfo(hostname, None, socket.AF_INET):
            result.add(address[4][0])
    return result
