"""Bounded registry of real transports, independent of the emulated shell."""
from collections import OrderedDict
from ipaddress import IPv4Address
from uuid import UUID


class SessionRegistry:
    def __init__(self, maximum=1000):
        self.maximum = maximum
        self.sessions = {}
        self.operations = OrderedDict()

    def register(self, key, source_ip, transport):
        if len(self.sessions) >= self.maximum:
            transport.abortConnection()
            return False
        self.sessions[key] = (source_ip, transport)
        return True

    def unregister(self, key):
        self.sessions.pop(key, None)

    def terminate(self, source_ip, operation_id, revision):
        address = str(IPv4Address(source_ip))
        key = (str(UUID(operation_id)), int(revision))
        if key[1] < 1:
            raise ValueError("Positive revision required")
        previous = self.operations.get(key)
        if previous and previous["source_ip"] != address:
            raise ValueError("Operation scope cannot change")
        if previous is None:
            previous = {"source_ip": address, "ids": set()}
            self.operations[key] = previous
        targets = [(identifier, transport) for identifier, (source, transport) in self.sessions.items() if source == address]
        if len(previous["ids"] | {identifier for identifier, _ in targets}) > self.maximum:
            raise ValueError("Termination evidence quota exceeded")
        for identifier, transport in targets:
            previous["ids"].add(identifier)
            transport.abortConnection()
        self.operations.move_to_end(key)
        while len(self.operations) > self.maximum:
            self.operations.popitem(last=False)
        return key

    def result(self, key):
        operation = self.operations[key]
        pending = [identifier for identifier, (source, _) in self.sessions.items() if source == operation["source_ip"]]
        closed = operation["ids"] - self.sessions.keys()
        return {"termination_state": "pending" if pending else "completed", "terminated_sessions": sorted(closed),
            "termination_error": None}
