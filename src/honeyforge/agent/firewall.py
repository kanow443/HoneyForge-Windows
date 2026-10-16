"""Observed firewall counter deltas, not invented successful connections or packet destinations."""
import re
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from uuid import NAMESPACE_URL, uuid5


class FirewallCollector:
    def __init__(self, runtime, spool):
        self.runtime, self.spool = runtime, spool

    def collect(self):
        containers = self.runtime.client.containers.list(all=True,
            filters={"label": ["hf.managed=true", f"hf.agent={self.runtime.host_id}"]})
        policies = {self.runtime.configure_network_policy(c.labels["hf.deployment"], c.labels["hf.generation"]): c for c in containers}
        output = subprocess.check_output(["iptables-save", "-c", "-t", "filter"], text=True)
        for line in output.splitlines():
            match = re.fullmatch(r"\[(\d+):(\d+)\] -A (HF-D-[0-9a-f]+) -j DROP", line)
            if not match or match[3] not in policies:
                continue
            packets, byte_count, chain = int(match[1]), int(match[2]), match[3]
            container = policies[chain]
            source = "firewall:" + container.labels["hf.deployment"] + ":" + container.labels["hf.generation"] + ":" + Path("/proc/sys/kernel/random/boot_id").read_text().strip()
            previous = int(self.spool.cursor(source))
            delta = packets - previous if packets >= previous else packets
            if not delta:
                continue
            stamp = datetime.now(UTC).isoformat()
            ip = next((n["IPAddress"] for n in container.attrs["NetworkSettings"]["Networks"].values()), "unknown")
            event = {"event_id": str(uuid5(NAMESPACE_URL, source + ":" + str(previous) + ":" + str(packets))),
                "deployment_id": container.labels["hf.deployment"], "generation": container.labels["hf.generation"],
                "event_type": "network.blocked", "source_ip": ip, "observed_at": stamp,
                "source_seq": int(datetime.now(UTC).timestamp() * 1000000), "provenance": "firewall",
                "payload": {"direction": "outbound", "packet_count": delta, "total_blocked_packets": packets,
                    "total_blocked_bytes": byte_count, "measurement": "iptables-drop-counter-delta",
                    "note": "Aggregated blocked packets since the previous sample; not a count of unique connections. Destination is unavailable."}}
            self.spool.collect(source, str(packets), [event])
