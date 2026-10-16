"""Private, restart-safe binary evidence outbox. Received files are never executed."""
import base64
import hashlib
import json
import os
import re
import struct
import threading
import time
from datetime import UTC, datetime
from pathlib import Path
from uuid import NAMESPACE_URL, uuid4, uuid5

PCAP_HEADER = struct.pack("<IHHIIII", 0xa1b2c3d4, 2, 4, 0, 0, 65535, 1)


class EvidenceOutbox:
    def __init__(self, path, quota):
        self.root = Path(path)
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.root.chmod(0o700)
        self.lock, self.quota = threading.RLock(), quota
        self.attempts = {}
        self.recovery_errors = 0
        self.used = sum(p.stat().st_size for suffix in ("*.blob", "*.part") for p in self.root.glob(suffix))
        for path in self.root.glob("*.part"):
            metadata_path = path.with_suffix(".json")
            if not metadata_path.exists():
                continue
            metadata = json.loads(metadata_path.read_text())
            if metadata["kind"] == "pcap":
                self.recover_pcap(path, metadata)
            elif metadata["kind"] == "file":
                with path.open("rb") as file:
                    valid = hashlib.file_digest(file, "sha256").hexdigest() == metadata["details"].get("expected_sha256")
                if valid:
                    self.finalize(path, metadata)
                else:
                    self.used -= path.stat().st_size
                    path.unlink()
                    metadata_path.unlink()
                    self.recovery_errors += 1
        for path in self.root.glob("*.blob"):
            metadata_path = path.with_suffix(".json")
            if metadata_path.exists():
                metadata = json.loads(metadata_path.read_text())
                if "sha256" not in metadata:
                    with path.open("rb") as file:
                        metadata.update(sha256=hashlib.file_digest(file, "sha256").hexdigest(), size_bytes=path.stat().st_size)
                    self.metadata(metadata)

    def metadata(self, metadata):
        path = self.root / (metadata["id"] + ".json")
        if not path.exists() and sum(1 for _ in self.root.glob("*.json")) >= 4096:
            raise OSError("Local evidence manifest budget exhausted")
        temporary = path.with_suffix(".tmp")
        with temporary.open("w") as file:
            os.fchmod(file.fileno(), 0o600)
            json.dump(metadata, file)
            file.flush()
            os.fsync(file.fileno())
        temporary.replace(path)
        directory = os.open(self.root, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)

    def write(self, path, content):
        with self.lock:
            if self.used + len(content) > self.quota:
                raise OSError("Local evidence quota exhausted")
            with path.open("ab") as file:
                os.fchmod(file.fileno(), 0o600)
                file.write(content)
            self.used += len(content)

    def finalize(self, path, metadata):
        with self.lock:
            with path.open("rb") as file:
                os.fsync(file.fileno())
                sha = hashlib.file_digest(file, "sha256").hexdigest()
            path.replace(path.with_suffix(".blob"))
            metadata.update(sha256=sha, size_bytes=path.with_suffix(".blob").stat().st_size)
            self.metadata(metadata)

    def recover_pcap(self, path, metadata):
        with path.open("r+b") as file:
            if file.read(24) != PCAP_HEADER:
                raise ValueError("Invalid private PCAP segment")
            position, packets, original, last_stamp = 24, 0, path.stat().st_size, metadata["started_at"]
            while header := file.read(16):
                if len(header) != 16:
                    break
                seconds, micros, captured, full = struct.unpack("<IIII", header)
                if captured > 65535 or captured > full or micros >= 1000000 or len(file.read(captured)) != captured:
                    break
                position += 16 + captured
                packets += 1
                last_stamp = datetime.fromtimestamp(seconds + micros / 1000000, UTC).isoformat()
            file.truncate(position)
            self.used -= original - position
        metadata["ended_at"] = last_stamp
        metadata["details"].update(packet_count=packets, kernel_drops=None, recovery="agent-restart; trailing incomplete record removed; kernel loss count unknown")
        self.finalize(path, metadata)

    def capture_file(self, container, data, event):
        sha = data.get("shasum", "")
        if not re.fullmatch(r"[0-9a-f]{64}", sha):
            raise ValueError("Invalid sensor file checksum")
        identifier = str(uuid5(NAMESPACE_URL, event["event_id"] + ":file:" + sha))
        with self.lock:
            if (self.root / (identifier + ".json")).exists() and (self.root / (identifier + ".blob")).exists():
                return identifier
        # Docker's archive endpoint may not expose tmpfs contents on every runtime.
        # This pinned client reads in the container namespace with O_NOFOLLOW.
        result = container.exec_run(["/cowrie/cowrie-env/bin/python3", "/app/cowrie_file.py", sha],
            user="999:999", demux=True)
        content = result.output[0] or b""
        if result.exit_code or not content or len(content) > 10 * 1024 * 1024 or hashlib.sha256(content).hexdigest() != sha:
            raise ValueError("Captured file checksum mismatch")
        metadata = {"id": identifier, "deployment_id": event["deployment_id"], "generation": event["generation"],
                "source_session_id": event["source_session_id"], "kind": "file", "started_at": event["observed_at"],
                "ended_at": event["observed_at"], "details": {"sensor_event_id": event["event_id"],
                    "capture": "cowrie-file-bytes", "malware_verdict": "not_scanned", "expected_sha256": sha}}
        path = self.root / (identifier + ".part")
        with self.lock:
            if self.used + len(content) > self.quota:
                raise OSError("Local evidence quota exhausted")
            self.metadata(metadata)
            self.write(path, content)
            self.finalize(path, metadata)
            return identifier

    def pending_count(self):
        with self.lock:
            return sum(1 for path in self.root.glob("*.json") if (path.with_suffix(".blob")).exists())

    def upload_one(self, request):
        with self.lock:
            pending = sorted((p for p in self.root.glob("*.json") if p.with_suffix(".blob").exists()
                and time.monotonic() - self.attempts.get(p.stem, 0) >= 1), key=lambda p: self.attempts.get(p.stem, 0))
            if not pending:
                return
            path = pending[0]
            metadata = json.loads(path.read_text())
            blob = path.with_suffix(".blob")
            self.attempts[path.stem] = time.monotonic()
        result = request("POST", "/agent/v1/artifacts", json=metadata)
        if result["state"] != "available":
            with self.lock:
                with blob.open("rb") as file:
                    file.seek(result["received_bytes"])
                    chunk = file.read(262144)
            if not chunk:
                raise ValueError("Artifact receiver offset is inconsistent")
            result = request("POST", f'/agent/v1/artifacts/{metadata["id"]}/chunks',
                json={"offset": result["received_bytes"], "data_base64": base64.b64encode(chunk).decode()})
        with self.lock:
            if result["state"] == "available" and result["sha256"] == metadata["sha256"] and result["received_bytes"] == metadata["size_bytes"]:
                size = blob.stat().st_size
                blob.unlink()
                path.unlink()
                self.used -= size
                self.attempts.pop(path.stem, None)


class PcapRecorder:
    def __init__(self, outbox, segment_bytes, segment_seconds):
        self.outbox, self.segment_bytes, self.segment_seconds = outbox, segment_bytes, segment_seconds
        self.active = {}

    def packet(self, container, bridge, packet):
        key = container.id
        if key not in self.active:
            identifier = str(uuid4())
            stamp = datetime.now(UTC).isoformat()
            metadata = {"id": identifier, "deployment_id": container.labels["hf.deployment"],
                "generation": container.labels["hf.generation"], "source_session_id": None, "kind": "pcap",
                "started_at": stamp, "ended_at": stamp,
                "details": {"capture": "AF_PACKET-owned-trap-bridge", "interface": bridge,
                    "snaplen": 65535, "linktype": "ethernet", "packet_count": 0, "kernel_drops": 0,
                    "scope": "Packets reaching this bridge; encrypted payload remains encrypted"}}
            path = self.outbox.root / (identifier + ".part")
            self.outbox.metadata(metadata)
            try:
                self.outbox.write(path, PCAP_HEADER)
            except OSError:
                path.with_suffix(".json").unlink(missing_ok=True)
                raise
            self.active[key] = (path, metadata, time.monotonic())
        path, metadata, started = self.active[key]
        stamp = time.time_ns()
        seconds, fraction = divmod(stamp, 1000000000)
        content = packet[:65535]
        self.outbox.write(path, struct.pack("<IIII", seconds, fraction // 1000, len(content), len(packet)) + content)
        metadata["ended_at"] = datetime.fromtimestamp(stamp / 1000000000, UTC).isoformat()
        metadata["details"]["packet_count"] += 1
        if path.stat().st_size >= self.segment_bytes:
            self.close(key)

    def losses(self, container_id, count):
        if container_id in self.active:
            self.active[container_id][1]["details"]["kernel_drops"] += count

    def rotate(self):
        for key, (_, _, started) in list(self.active.items()):
            if time.monotonic() - started >= self.segment_seconds:
                self.close(key)

    def close(self, key=None):
        for identifier in [key] if key is not None else list(self.active):
            item = self.active.get(identifier)
            if item:
                path, metadata, _ = item
                self.outbox.finalize(path, metadata)
                del self.active[identifier]
