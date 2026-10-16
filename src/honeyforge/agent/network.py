"""Passive IPv4 summaries and separate bounded PCAP segments on owned trap bridges."""
import socket
import struct
import time
from datetime import UTC, datetime
from uuid import uuid4


def decode_metadata(packet: bytes):
    if len(packet) < 34 or packet[12:14] != b"\x08\x00" or packet[14] >> 4 != 4:
        return None
    header_length = (packet[14] & 15) * 4
    offset = 14 + header_length
    if header_length < 20 or len(packet) < offset or struct.unpack_from("!H", packet, 20)[0] & 0x1fff:
        return None
    result = {"source_ip": socket.inet_ntoa(packet[26:30]), "destination_ip": socket.inet_ntoa(packet[30:34]),
        "protocol": {6: "tcp", 17: "udp", 1: "icmp"}.get(packet[23], str(packet[23])), "bytes": len(packet)}
    if packet[23] in {6, 17}:
        if len(packet) < offset + (20 if packet[23] == 6 else 8):
            return None
        result["source_port"], result["destination_port"] = struct.unpack_from("!HH", packet, offset)
        if packet[23] == 6:
            result["tcp_flags"] = packet[offset + 13]
    return result


class NetworkCollector:
    def __init__(self, runtime, spool, recorder=None):
        self.runtime, self.spool = runtime, spool
        self.recorder = recorder
        self.sources, self.flows = {}, {}
        self.last_refresh = self.last_totals = 0
        self.status = "idle"

    def refresh(self):
        current = {}
        containers = self.runtime.client.containers.list(
            filters={"label": ["hf.managed=true", f"hf.agent={self.runtime.host_id}"]})
        for container in containers[:100]:
            for net in container.attrs["NetworkSettings"]["Networks"].values():
                bridge = "hf" + container.labels["hf.deployment"].replace("-", "")[:10]
                if bridge not in self.sources:
                    capture = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.htons(3))
                    capture.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4 * 1024 * 1024)
                    try:
                        capture.bind((bridge, 0))
                    except OSError:
                        capture.close()
                        raise
                    capture.setblocking(False)
                    self.sources[bridge] = {"socket": capture, "totals": {"inbound_packets": 0, "outbound_packets": 0,
                        "inbound_bytes": 0, "outbound_bytes": 0}}
                current[bridge] = self.sources[bridge]
                current[bridge].update(container=container, ip=net["IPAddress"])
        for bridge in self.sources.keys() - current.keys():
            if self.recorder:
                self.recorder.close(self.sources[bridge]["container"].id)
            self.sources[bridge]["socket"].close()
        self.sources = current
        self.status = "unavailable" if len(containers) > 100 else "active" if current else "idle"
        self.last_refresh = time.monotonic()

    def collect(self):
        if time.monotonic() - self.last_refresh > 2:
            self.refresh()
        stamp = datetime.now(UTC)
        for source in self.sources.values():
            container, capture, totals = source["container"], source["socket"], source["totals"]
            events = []
            suppressed = 0
            for _ in range(10000):
                try:
                    packet = capture.recv(65536)
                except BlockingIOError:
                    break
                if self.recorder:
                    try:
                        self.recorder.packet(container, "hf" + container.labels["hf.deployment"].replace("-", "")[:10], packet)
                    except OSError:
                        self.spool.increment("artifact_dropped_packets")
                data = decode_metadata(packet)
                if not data:
                    continue
                direction = "outbound" if data["source_ip"] == source["ip"] else "inbound" if data["destination_ip"] == source["ip"] else None
                if not direction:
                    continue
                totals[direction + "_packets"] += 1
                totals[direction + "_bytes"] += len(packet)
                # Record new TCP SYN and first UDP flow. Replies are represented in traffic totals.
                if data["protocol"] == "tcp" and data.get("tcp_flags", 0) & 0x12 != 0x02:
                    continue
                if data["protocol"] not in {"tcp", "udp"}:
                    continue
                flow = (container.id, data["source_ip"], data["destination_ip"], data.get("source_port"), data.get("destination_port"), data["protocol"])
                if self.flows.get(flow, 0) > time.monotonic() - 60:
                    continue
                if len(self.flows) >= 10000 or len(events) >= 100:
                    # Bound sensor memory under a flood; expose discarded metadata as capture loss.
                    suppressed += 1
                    continue
                self.flows[flow] = time.monotonic()
                events.append(self.event(container, "network.connection", stamp, {**data, "direction": direction,
                    "message": f'{direction} {data["protocol"].upper()} {data["source_ip"]}:{data.get("source_port", "")} → {data["destination_ip"]}:{data.get("destination_port", "")}',
                    "observation": "Packet observed. Successful connection or delivery is not established by this event."},
                    data["source_ip"]))
            # Linux PACKET_STATISTICS resets after reading; expose capture losses explicitly.
            _, dropped = struct.unpack("II", capture.getsockopt(263, 6, 8))
            if self.recorder:
                self.recorder.losses(container.id, dropped)
            if dropped or suppressed:
                self.spool.increment("network_dropped_packets", dropped + suppressed)
            if time.monotonic() - self.last_totals > 10 and sum(totals.values()):
                events.append(self.event(container, "network.traffic", stamp,
                    {**totals, "message": "Observed bridge traffic since the previous sample", "measurement": "ipv4-ethernet-byte-counters"}, source["ip"]))
                for key in totals:
                    totals[key] = 0
            if events:
                self.spool.collect("network:" + container.id, stamp.isoformat(), events)
        if time.monotonic() - self.last_totals > 10:
            self.last_totals = time.monotonic()
        self.flows = {key: at for key, at in self.flows.items() if at > time.monotonic() - 60}
        if self.recorder:
            self.recorder.rotate()

    def event(self, container, kind, stamp, payload, source_ip):
        return {"event_id": str(uuid4()), "deployment_id": container.labels["hf.deployment"],
            "generation": container.labels["hf.generation"], "event_type": kind, "source_ip": source_ip,
            "observed_at": stamp.isoformat(), "source_seq": int(stamp.timestamp() * 1000000),
            "payload": payload, "provenance": "network-sensor"}

    def close(self):
        for source in self.sources.values():
            source["socket"].close()
        if self.recorder:
            self.recorder.close()
