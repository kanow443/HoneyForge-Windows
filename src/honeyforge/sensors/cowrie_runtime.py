"""A pinned Cowrie protocol adapter; emits authenticated shell output through its event dispatcher."""
import json
import os
import random
import sys
from pathlib import Path
from urllib.parse import urlsplit
from uuid import uuid4

from cowrie.core.events import EventDispatcher
from cowrie.insults import insults
from cowrie.ssh import transport as ssh_transport
from cowrie.ssh.userauth import HoneyPotSSHUserAuthServer
from sealed_capture import capture
from session_control import SessionRegistry
from terminal_capture import OutputCapture
from twisted.internet import reactor
from twisted.internet.protocol import Factory, connectionDone
from twisted.internet.task import deferLater
from twisted.protocols.basic import LineReceiver
from twisted.scripts.twistd import run

registry = SessionRegistry()
original_dispatch = EventDispatcher.dispatch
profile = json.loads(os.environ["PROFILE_CONFIG"])


def sealed_dispatch(self, event):
    """Transform credentials BEFORE every output sink and the console renderer."""
    if event.get("eventid") in {"cowrie.login.failed", "cowrie.login.success"}:
        event = dict(event)
        event_id = str(uuid4())
        event["hf_event_id"] = event_id
        password = event.pop("password", "")
        content = {"username": str(event.get("username", "")), "password": str(password)}
        event["format"] = event["message"] = "Login observation; credentials sealed separately"
        if profile.get("recording", {}).get("capture_credentials", True):
            try:
                kind = "ssh.login.success" if event["eventid"].endswith("success") else "ssh.login.failed"
                event["private_capture"] = capture(content, event_id, event.get("session"), kind)
            except Exception:
                event["private_capture_state"] = "unavailable"
    return original_dispatch(self, event)


EventDispatcher.dispatch = sealed_dispatch

# Delay auth on the reactor without blocking telemetry or other SSH sessions.
# Applied to the existing upstream checker; credentials still use sealed_dispatch.
_original_auth_password = HoneyPotSSHUserAuthServer.auth_password

def delayed_password(self, packet):
    realism = profile.get('realism', {})
    low, high = realism.get('auth_min_ms', 180), realism.get('auth_max_ms', 420)
    return deferLater(reactor, random.uniform(low, high) / 1000, _original_auth_password, self, packet)

HoneyPotSSHUserAuthServer.auth_password = delayed_password



class ManagedSSHTransport(ssh_transport.HoneyPotSSHTransport):
    def connectionMade(self):
        super().connectionMade()
        registry.register(self.transportId, self.transport.getPeer().host, self.transport)

    def connectionLost(self, reason=connectionDone):
        registry.unregister(self.transportId)
        super().connectionLost(reason)


class ControlProtocol(LineReceiver):
    delimiter = b"\n"
    MAX_LENGTH = 1024

    def connectionMade(self):
        self.timer = reactor.callLater(3, self.transport.abortConnection)
        self.requested = False

    def connectionLost(self, reason=connectionDone):
        if self.timer.active():
            self.timer.cancel()

    def lineReceived(self, line):
        if self.requested:
            self.transport.abortConnection()
            return
        self.requested = True
        try:
            request = json.loads(line)
            if set(request) != {"source_ip", "operation_id", "revision"}:
                raise ValueError("Invalid control command")
            key = registry.terminate(**request)
            self.poll(key, 0)
        except (ValueError, TypeError, KeyError):
            self.reply({"termination_state": "error", "terminated_sessions": [], "termination_error": "Invalid local control request"})

    def poll(self, key, attempt):
        if not self.transport.connected:
            return
        result = registry.result(key)
        if result["termination_state"] == "pending" and attempt < 100:
            reactor.callLater(0.02, self.poll, key, attempt + 1)
            return
        if result["termination_state"] == "pending":
            result.update(termination_state="error", termination_error="Some SSH transports did not close before the deadline")
        self.reply(result)

    def reply(self, result):
        self.sendLine(json.dumps(result).encode())
        self.transport.loseConnection()


def start_control():
    path = Path("/cowrie/cowrie-git/var/lib/cowrie/control.sock")
    path.unlink(missing_ok=True)
    factory = Factory()
    factory.protocol = ControlProtocol
    reactor.listenUNIX(str(path), factory, mode=0o600, wantPID=False)
    os.chmod(path, 0o600)


def start_download_fixture():
    """An explicit lab mode: real HTTP bytes, no Internet egress or arbitrary private targets."""
    from cowrie.commands import curl, wget
    from cowrie.core import download, network
    from twisted.internet.defer import fail, succeed
    from twisted.web.resource import Resource
    from twisted.web.server import Site

    class Sample(Resource):
        isLeaf = True

        def render_GET(self, request):
            if request.path != b"/sample.txt":
                request.setResponseCode(404)
                return b"Not found\n"
            request.setHeader(b"content-type", b"application/octet-stream")
            return b"SYNTHETIC LAB ARTIFACT\nHoneyForge download verification\n"

    original_resolve, original_fetch = network.resolve_allowed, download.fetch
    original_communication = network.communication_allowed

    def resolve(address):
        return succeed("127.0.0.1") if address == "downloads.honeyforge.test" else original_resolve(address)

    def fetch(reactor, url, *args, **kwargs):
        parsed = urlsplit(url)
        if parsed.hostname == "downloads.honeyforge.test":
            if parsed.scheme != "http" or parsed.port != 18090 or parsed.path != "/sample.txt" or parsed.query or parsed.username or parsed.password:
                return fail(download.BlockedAddress("Only the explicitly configured fixture endpoint is allowed"))
        return original_fetch(reactor, url, *args, **kwargs)

    download.resolve_allowed = resolve
    wget.communication_allowed = curl.communication_allowed = lambda address: (
        succeed(True) if address == "downloads.honeyforge.test" else original_communication(address))
    download.fetch = wget.fetch = curl.fetch = fetch
    reactor.listenTCP(18090, Site(Sample()), interface="127.0.0.1")


class StreamingShellProtocol(insults.LoggingServerProtocol):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.capture = OutputCapture(lambda *a, **kw: self.getEventLog().dispatch(*a, **kw), reactor.callLater,
            budget=profile.get("recording", {}).get("shell_output_bytes", 262144))

    def write(self, data):
        super().write(data)
        self.capture.add(data)

    def connectionLost(self, reason=connectionDone):
        self.capture.close()
        super().connectionLost(reason)


# Cowrie's shell factory resolves this protocol class from the module at channel creation.
# The image digest freezes this integration point; image upgrades require a real shell acceptance.
insults.LoggingServerProtocol = StreamingShellProtocol
ssh_transport.HoneyPotSSHTransport = ManagedSSHTransport
reactor.callWhenRunning(start_control)
if json.loads(os.environ["PROFILE_CONFIG"]).get("download_mode") == "fixture":
    reactor.callWhenRunning(start_download_fixture)
sys.argv = ["twistd", "-n", "--umask=0022", "--pidfile=", "--logger", "cowrie.python.logfile.stdoutLogger", "cowrie"]
run()
