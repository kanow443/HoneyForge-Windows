import json
import re
import unicodedata
from datetime import UTC, datetime
from urllib.parse import urlsplit, urlunsplit
from uuid import NAMESPACE_URL, uuid5

from docker.errors import APIError, NotFound

from honeyforge.application.schemas import TelemetryEvent
from honeyforge.infrastructure.security import sanitize

COWRIE_TYPES = {
    "cowrie.session.connect": "ssh.connect", "cowrie.login.failed": "ssh.login.failed",
    "cowrie.login.success": "ssh.login.success", "cowrie.command.input": "ssh.command",
    "cowrie.session.closed": "ssh.disconnect", "cowrie.direct-tcpip.request": "ssh.forward",
    "honeyforge.terminal.output": "ssh.output", "honeyforge.terminal.truncated": "sensor.error",
    "cowrie.client.version": "ssh.client.version", "cowrie.client.kex": "ssh.client.kex",
    "cowrie.session.file_download": "ssh.file.download", "cowrie.session.file_download.failed": "ssh.file.download.failed",
    "cowrie.session.file_upload": "ssh.file.upload",
}


def terminal_text(value):
    text = re.sub(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-_]", "", value)
    return "".join(char for char in text.replace("\r\n", "\n")
        if char in "\n\t" or (ord(char) >= 32 and ord(char) != 127 and unicodedata.category(char) != "Cf"))[:16384]


def timestamp(value):
    # Docker RFC3339 timestamps may have nanoseconds; datetime safely keeps microseconds.
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


class DockerCollector:
    def __init__(self, client, spool, host_id, evidence=None):
        self.client, self.spool, self.host_id = client, spool, host_id
        self.evidence = evidence

    def collect(self):
        for container in self.client.containers.list(all=True, filters={"label": ["hf.managed=true", f"hf.agent={self.host_id}"]}):
            source = container.id
            saved = float(self.spool.cursor(source))
            since = max(0, int(saved) - 1)
            try:
                logs = container.logs(timestamps=True, stream=True, follow=False, **({"since": since} if since else {}))
            except (APIError, NotFound) as error:
                if error.status_code not in {404, 409}:
                    raise
                # Reconciliation may remove a stopped container between listing and reading.
                # Skip only this source; do not kill collection for every other trap.
                continue
            events, errors, latest = [], 0, saved
            processed = 0
            try:
                for chunk in logs:
                    for line in chunk.splitlines():
                        stamp, separator, raw = line.partition(b" ")
                        if not separator:
                            continue
                        try:
                            source_time = timestamp(stamp.decode())
                            if source_time.timestamp() < saved:
                                continue
                            latest = max(latest, source_time.timestamp())
                            if not raw.startswith(b"{"):
                                continue
                            if len(raw) > 65536:
                                errors += 1
                                continue
                            data = json.loads(raw)
                            event = self.normalize(container, data, source_time, stamp.decode(), raw)
                            if event:
                                if self.spool.seen(event["event_id"]):
                                    continue
                                TelemetryEvent.model_validate(event)
                                events.append(event)
                        except (ValueError, TypeError, KeyError):
                            errors += 1
                        processed += 1
                        if len(events) >= 100:
                            self.spool.collect(source, str(latest), events, errors)
                            events, errors = [], 0
                    if processed >= 1000:
                        break
            except (APIError, NotFound) as error:
                if error.status_code not in {404, 409}:
                    raise
            finally:
                if hasattr(logs, "close"):
                    logs.close()
            self.spool.collect(source, str(latest), events, errors)

    def normalize(self, container, data, source_time, stamp, raw):
        adapter = container.labels["hf.adapter"]
        if adapter == "cowrie":
            kind = COWRIE_TYPES.get(data.get("eventid"))
            if not kind:
                return None
            payload = {"message": data.get("message", ""), "username": data.get("username", ""),
                "command": data.get("input", ""), "duration": data.get("duration"),
                "destination": data.get("dst_ip"), "destination_port": data.get("dst_port")}
            if kind == "ssh.output":
                payload = {"text": terminal_text(data.get("text", "")), "byte_count": data.get("byte_count", 0),
                    "capture": "shell-output"}
            elif kind == "sensor.error":
                payload = {"message": "Terminal output capture was truncated by the sensor quota",
                    "capture": "shell-output", "capture_limit_bytes": data.get("capture_limit_bytes"),
                    "pending_limit_bytes": data.get("pending_limit_bytes")}
            elif kind == "ssh.client.version":
                payload = {"version": data.get("version", ""), "observation": "client-claimed", "identity": "unknown"}
            elif kind == "ssh.client.kex":
                payload = {"hassh": data.get("hassh", ""), "algorithms": data.get("hasshAlgorithms", ""),
                    "observation": "client-negotiation", "identity": "unknown"}
            elif kind.startswith("ssh.file."):
                try:
                    url = urlsplit(data.get("url", ""))
                    netloc = (url.hostname or "") + (":" + str(url.port) if url.port else "")
                    safe_url = urlunsplit((url.scheme, netloc, url.path, "", ""))
                except ValueError:
                    safe_url = "[invalid URL]"
                payload = {"url": safe_url, "sha256": data.get("shasum", ""),
                    "destination": data.get("destfile", data.get("filename", "")),
                    "error": data.get("error"), "observation": "sensor-reported",
                    "artifact_verified": False}
            # Cowrie's human-readable login message may contain a password. Replace it completely.
            if kind.startswith("ssh.login."):
                payload["message"] = "Login accepted" if kind.endswith("success") else "Login rejected"
            observed = data.get("timestamp", source_time.isoformat())
            source_ip, source_session = data.get("src_ip", "unknown"), data.get("session")
            provenance = "cowrie"
        else:
            kind, payload = data["event_type"], data["payload"]
            observed, source_ip = data["observed_at"], data["source_ip"]
            source_session = data.get("source_session_id")
            provenance = "tcp-sensor" if adapter == "tcp-banner" else "http-sensor"
        native_id = data.get("hf_event_id") or (data.get("event_id") if data.get("private_capture") else None)
        event = {"event_id": native_id or str(uuid5(NAMESPACE_URL, container.id + ":" + stamp + ":" + raw.decode())),
            "deployment_id": container.labels["hf.deployment"], "generation": container.labels["hf.generation"],
            "event_type": kind, "source_ip": source_ip, "source_session_id": source_session,
            "source_seq": int(source_time.timestamp() * 1000000),
            "observed_at": timestamp(observed).astimezone(UTC).isoformat(), "payload": sanitize(payload), "provenance": provenance,
            "private_capture": data.get("private_capture")}
        if self.evidence and kind in {"ssh.file.download", "ssh.file.upload"}:
            try:
                event["payload"]["artifact_id"] = self.evidence.capture_file(container, data, event)
                event["payload"]["artifact_capture"] = "sensor-durable"
            except Exception:
                self.spool.increment("artifact_errors")
                event["payload"]["artifact_capture"] = "unavailable"
                event["payload"]["artifact_error"] = "File bytes could not be independently captured within the evidence budget"
        return event
