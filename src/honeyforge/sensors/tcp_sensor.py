"""Low interaction: bounded banner exchange, no authentication or command execution."""
import base64
import json
import os
import random
import socket
import socketserver
import threading
import time
from datetime import UTC, datetime
from uuid import uuid4

profile = json.loads(os.environ.get("PROFILE_CONFIG", "{}"))
lock = threading.Lock()


class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        session = uuid4().hex

        def event(kind, **payload):
            with lock:
                print(json.dumps({"event_id": str(uuid4()), "event_type": kind,
                    "source_ip": self.client_address[0], "source_session_id": session,
                    "observed_at": datetime.now(UTC).isoformat(), "payload": payload}), flush=True)

        event("tcp.connect", source_port=self.client_address[1], destination_port=self.server.server_address[1])
        try:
            self.request.settimeout(10)
            timing = profile.get("realism", {})
            time.sleep(random.uniform(timing.get("response_min_ms", 30), timing.get("response_max_ms", 120)) / 1000)
            self.request.sendall((profile.get("banner", "Service ready") + "\r\n").encode())
            # One extra byte distinguishes exact budget from actual truncation.
            data = self.request.recv(2049)
            if data:
                event("tcp.request", data_base64=base64.b64encode(data[:2048]).decode(),
                    bytes_received=len(data), truncated=len(data) > 2048, capture_limit_bytes=2048)
                self.request.sendall((profile.get("response", "Protocol mismatch.") + "\r\n").encode())
        except (OSError, socket.timeout):
            pass
        finally:
            event("tcp.disconnect")


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True
    request_queue_size = 16

    def handle_error(self, request, client_address):
        pass


if __name__ == "__main__":
    with Server(("0.0.0.0", 9000), Handler) as server:
        server.serve_forever()
