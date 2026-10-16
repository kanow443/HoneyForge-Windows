"""Fixed local client. Never exposes an arbitrary command or a network listener."""
import json
import socket
import sys
from ipaddress import IPv4Address
from uuid import UUID

PATH = "/cowrie/cowrie-git/var/lib/cowrie/control.sock"


def run():
    source, operation, revision = str(IPv4Address(sys.argv[1])), str(UUID(sys.argv[2])), int(sys.argv[3])
    if revision < 1:
        raise ValueError("Invalid revision")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(4)
        connection.connect(PATH)
        connection.sendall(json.dumps({"source_ip": source, "operation_id": operation, "revision": revision}).encode() + b"\n")
        data = b""
        while b"\n" not in data:
            chunk = connection.recv(4096)
            if not chunk or len(data) + len(chunk) > 65536:
                raise ValueError("Invalid control response")
            data += chunk
        result = json.loads(data.split(b"\n", 1)[0])
        print(json.dumps(result))


if __name__ == "__main__":
    run()
