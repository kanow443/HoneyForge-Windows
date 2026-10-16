import argparse
import json
import logging
import random
import signal
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlsplit

import httpx
import psutil

from honeyforge.agent.adapters import DockerRuntime
from honeyforge.agent.collector import DockerCollector
from honeyforge.agent.evidence import EvidenceOutbox, PcapRecorder
from honeyforge.agent.firewall import FirewallCollector
from honeyforge.agent.identity import AgentIdentity
from honeyforge.agent.network import NetworkCollector
from honeyforge.agent.policies import PolicyExecutor, SourceFirewall, protected_addresses
from honeyforge.agent.spool import Spool
from honeyforge.agent.tls import PinnedContext, parse_pins
from honeyforge.infrastructure.certificates import atomic
from honeyforge.infrastructure.settings import settings

log = logging.getLogger("honeyforge.agent")


class Agent:
    def __init__(self, config=settings):
        self.config = config
        url = urlsplit(config.agent_api)
        if url.scheme != "https" and not config.allow_insecure_agent:
            raise ValueError("Agents require HTTPS; select explicit development mode to allow HTTP")
        if url.scheme not in {"http", "https"} or url.username or url.password or url.query or url.fragment:
            raise ValueError("Invalid management URL")
        self.state = Path(config.agent_state_dir)
        self.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.credentials_path = self.state / "credentials.json"
        self.http_lock = threading.RLock()
        self.identity = AgentIdentity(self.state) if url.scheme == "https" and not config.agent_cert_file else None
        pair = self.identity.current() if self.identity else None
        if config.agent_cert_file:
            pair = (config.agent_cert_file, config.agent_key_file)
        self.http = self._new_client(pair)
        self.stopping = threading.Event()
        self.revoked = threading.Event()

    def _new_client(self, pair=None, headers=None):
        trust = PinnedContext(self.config.agent_ca_file or None, parse_pins(self.config.agent_server_spki_pins))
        if pair:
            trust.load_cert_chain(*pair)
        transport = httpx.HTTPTransport(verify=trust, local_address=self.config.agent_management_address or None,
            trust_env=False)
        return httpx.Client(base_url=self.config.agent_api, timeout=10, trust_env=False,
            transport=transport, headers=headers)

    def _install_identity(self, certificate, key):
        # Requests and replacement share the lock: an in-flight request keeps its TLS transport.
        with self.http_lock:
            replacement = self._new_client((certificate, key), dict(self.http.headers))
            previous, self.http = self.http, replacement
            previous.close()

    def refresh_identity(self):
        if not self.identity:
            return
        marker = self.state / "rotate-request"
        self.identity.ensure(self.host_id, self.request, self._install_identity, force=marker.exists())
        marker.unlink(missing_ok=True)

    def enroll(self, token):
        response = self.http.post(self.config.agent_route_prefix + "/enroll", json={"token": token, "name": self.config.agent_name,
            "address": self.config.agent_address, "capabilities": DockerRuntime(self.config).capabilities(), "runtime_version": "asset-sync/0.3.0"})
        response.raise_for_status()
        atomic(self.credentials_path, json.dumps(response.json()).encode())
        log.info("Agent enrolled. Individual credentials saved privately.")

    def initialize(self):
        credentials = json.loads(self.credentials_path.read_text())
        self.host_id = credentials["host_id"]
        self.http.headers["Authorization"] = "Bearer " + credentials["key"]
        self.spool = Spool(self.state / "outbox.sqlite3")
        self.runtime = DockerRuntime(self.config, host_id=self.host_id)
        self.evidence = EvidenceOutbox(self.state / "evidence", self.config.agent_artifact_quota_bytes)
        if self.evidence.recovery_errors:
            self.spool.increment("artifact_errors", self.evidence.recovery_errors)
        self.collector = DockerCollector(self.runtime.client, self.spool, self.host_id, self.evidence)
        self.firewall = FirewallCollector(self.runtime, self.spool)
        self.network = NetworkCollector(self.runtime, self.spool, PcapRecorder(self.evidence,
            self.config.pcap_segment_bytes, self.config.pcap_segment_seconds))
        protected = protected_addresses([urlsplit(self.config.agent_api).hostname, self.config.agent_address])
        self.policies = PolicyExecutor(self.state / "source-policies.json", SourceFirewall(self.runtime, protected))
        self.policies.start()
        self.executor = ThreadPoolExecutor(max_workers=1)
        self.future = None
        self.specs_path = self.state / "runtimes.json"
        self.specs = json.loads(self.specs_path.read_text()) if self.specs_path.exists() else []
        self.last_identity = 0
        self.last_heartbeat = 0
        self.last_firewall = 0
        self.next_upload = 0
        self.upload_failures = 0
        self.last_policies = 0
        self.collection_thread = None
        self.packet_thread = None

    def request(self, method, route, **kwargs):
        if self.stopping.is_set() or self.revoked.is_set():
            raise httpx.RequestError("Agent communication is stopping")
        route = route.replace("/agent/v1", self.config.agent_route_prefix, 1)
        with self.http_lock:
            response = self.http.request(method, route, **kwargs)
        if response.status_code == 401:
            try:
                if response.json().get("error", {}).get("code") == "invalid_agent_key":
                    self.revoked.set()
            except ValueError:
                pass
        response.raise_for_status()
        return response.json()

    def _execute(self, job):
        stage = ["Получение задания"]
        ended = threading.Event()

        def progress(name):
            stage[0] = name
            self.request("POST", f'/agent/v1/jobs/{job["id"]}/progress',
                json={"attempt": job["attempt"], "stage": name})

        def renew():
            while not ended.wait(10):
                try:
                    progress(stage[0])
                except httpx.HTTPError:
                    return

        renewal = threading.Thread(target=renew, daemon=True)
        renewal.start()
        try:
            current = self.request("GET", "/agent/v1/runtimes")
            spec = next((s for s in current if s["deployment_id"] == job["deployment_id"]), None)
            if not spec or spec["revision"] != job["revision"]:
                return
            progress("Проверка конфигурации")
            if job["kind"] == "stop":
                progress("Остановка сервиса")
                self.runtime.stop(spec)
                image = ""
            else:
                container = self.runtime.apply(spec, progress)
                image = container.image.id
            self.request("POST", f'/agent/v1/jobs/{job["id"]}/result',
                json={"attempt": job["attempt"], "succeeded": True, "image_digest": image})
        except Exception as error:
            # Report bounded text. HTTP errors do not include authorization headers.
            message = str(error)[:500]
            try:
                self.request("POST", f'/agent/v1/jobs/{job["id"]}/result',
                    json={"attempt": job["attempt"], "succeeded": False, "error": message})
            except httpx.HTTPError:
                log.warning("Job result not accepted; it will be reconciled through a fresh lease.")
        finally:
            ended.set()
            renewal.join(timeout=1)

    def collect(self):
        try:
            self.collector.collect()
        except Exception:
            self.network.status = "unavailable"
            log.exception("Collector failed; source cursors remain recoverable")

    def tick(self):
        if time.monotonic() >= self.last_identity:
            try:
                self.refresh_identity()
                self.last_identity = time.monotonic() + 60
            except (httpx.HTTPError, ValueError, OSError):
                # TLS renewal failure preserves collection, accepted evidence and the pending CSR.
                self.last_identity = time.monotonic() + 5
        if time.monotonic() - self.last_policies > 2:
            try:
                policies = self.request("GET", "/agent/v1/source-policies")
                for report in self.policies.reconcile(policies):
                    key = report.pop("id")
                    self.request("POST", f"/agent/v1/source-policies/{key}/ack", json=report)
                self.last_policies = time.monotonic()
            except (httpx.HTTPError, ValueError):
                pass
        if time.monotonic() - self.last_firewall > 5:
            try:
                self.runtime.verify_isolation()
                self.firewall.collect()
                self.last_firewall = time.monotonic()
            except Exception:
                # A missing policy is a safety failure; stop every managed trap before exiting.
                for spec in self.specs:
                    self.runtime.stop(spec)
                self.stopping.set()
                log.exception("Network policy unavailable; traps stopped")
                return
        if time.monotonic() >= self.next_upload:
            batch = self.spool.batch()
            if batch:
                try:
                    result = self.request("POST", "/agent/v1/events/batch", json={"events": batch})
                    self.spool.acknowledge(result["accepted"], result["rejected"])
                    self.upload_failures = 0
                except httpx.HTTPError:
                    self.upload_failures += 1
            self.next_upload = time.monotonic() + (min(15, 0.25 * 2 ** min(self.upload_failures, 6)) + random.uniform(0, 0.1))
        if time.monotonic() >= self.last_heartbeat:
            try:
                specs = self.request("GET", "/agent/v1/runtimes")
                self.specs = specs
                temporary = self.specs_path.with_suffix(".tmp")
                temporary.write_text(json.dumps(specs))
                temporary.chmod(0o600)
                temporary.replace(self.specs_path)
                observations = []
                for spec in specs:
                    if spec["desired_state"] == "stopped":
                        self.runtime.stop(spec)
                    state, image = self.runtime.observe(spec)
                    # Do not report absent runtimes while an initial job is applying.
                    if state == "stopped" and spec["desired_state"] == "running" and spec.get("observed_state") != "running":
                        continue
                    observations.append({"deployment_id": spec["deployment_id"], "revision": spec["revision"],
                        "state": state, "image_digest": image})
                self.request("POST", "/agent/v1/heartbeat", json={"cpu_percent": psutil.cpu_percent(),
                    "capabilities": self.runtime.capabilities(), "runtime_version": "asset-sync/0.3.0",
                    "memory_percent": psutil.virtual_memory().percent, **self.spool.metrics(),
                    "queued_artifacts": self.evidence.pending_count(),
                    "network_capture_state": self.network.status,
                    "network_policy": "external-firewall", "runtimes": observations,
                    "padding": random.randbytes(random.randint(128, 1024)).hex()})
                interval = min((s.get("config", {}).get("beacon", {}).get("interval_seconds", self.config.heartbeat_seconds)
                    for s in specs), default=self.config.heartbeat_seconds)
                jitter = max((s.get("config", {}).get("beacon", {}).get("jitter_ratio", 0.2) for s in specs), default=0.2)
                self.last_heartbeat = time.monotonic() + interval * random.uniform(1 - jitter, 1 + jitter)
            except httpx.HTTPError:
                pass
        try:
            self.evidence.upload_one(self.request)
        except (httpx.HTTPError, ValueError, OSError):
            # Keep bytes locally on receiver failure; do not erase an unacknowledged artifact.
            pass
        if self.future is None or self.future.done():
            try:
                job = self.request("POST", "/agent/v1/jobs/claim")["job"]
                if job:
                    self.future = self.executor.submit(self._execute, job)
            except httpx.HTTPError:
                pass

    def run_forever(self):
        self.initialize()
        for sig in (signal.SIGTERM, signal.SIGINT):
            signal.signal(sig, lambda *_: self.stopping.set())

        def collect_forever():
            while not self.stopping.is_set():
                self.collect()
                self.stopping.wait(0.25)

        # Slow/disconnected HTTP cannot stall local packet capture and durable log collection.
        self.collection_thread = threading.Thread(target=collect_forever, name="event-collector", daemon=True)
        self.collection_thread.start()

        def packets_forever():
            while not self.stopping.is_set():
                try:
                    self.network.collect()
                except Exception:
                    self.network.status = "unavailable"
                    self.spool.increment("artifact_errors")
                    log.exception("Network evidence collection unavailable")
                self.stopping.wait(0.05)

        self.packet_thread = threading.Thread(target=packets_forever, name="packet-collector", daemon=True)
        self.packet_thread.start()
        log.info("Agent running; credentials and raw login secrets are not logged.")
        while not self.stopping.is_set():
            self.tick()
            if self.revoked.is_set():
                log.warning("Agent key revoked. Stopping managed runtimes and preserving the local outbox.")
                self.executor.shutdown(wait=True)
                for spec in self.specs:
                    self.runtime.stop(spec)
                self.stopping.set()
                break
            self.stopping.wait(0.25)
        self.executor.shutdown(wait=True)
        self.stopping.set()
        self.collection_thread.join()
        self.packet_thread.join()
        self.policies.close()
        self.runtime.close()
        self.network.close()
        self.spool.db.close()
        self.http.close()


def run():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    parser = argparse.ArgumentParser(description="HoneyForge sensor agent")
    commands = parser.add_subparsers(dest="command", required=True)
    enroll = commands.add_parser("enroll")
    enroll.add_argument("--token-file", required=True)
    commands.add_parser("run")
    commands.add_parser("status")
    commands.add_parser("rotate-certificate")
    args = parser.parse_args()
    agent = Agent()
    if args.command == "enroll":
        agent.enroll(Path(args.token_file).read_text().strip())
    elif args.command == "rotate-certificate":
        from honeyforge.infrastructure.certificates import atomic
        atomic(agent.state / "rotate-request", b"rotate\n")
        print("Certificate rotation requested; the running service will confirm it.")
    elif args.command == "status":
        credentials = json.loads(agent.credentials_path.read_text())
        spool = Spool(agent.state / "outbox.sqlite3")
        print(json.dumps({"host_id": credentials["host_id"], **spool.metrics()}))
    else:
        agent.run_forever()
