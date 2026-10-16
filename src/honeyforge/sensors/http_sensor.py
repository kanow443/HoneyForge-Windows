"""A bounded HTTP decoy. Only synthetic profile data; no control-plane credentials."""
import base64
import hashlib
import html
import json
import os
import random
import re
import secrets
import socket
import threading
import time
from datetime import UTC, datetime
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit
from uuid import uuid4

from sealed_capture import capture as seal_observation

profile = json.loads(os.environ.get("PROFILE_CONFIG", "{}"))
files = {item["path"]: item["content"] for item in profile.get("decoy_files", [])}
tokens = {item["path"]: item for item in json.loads(os.environ.get("DECOY_TOKENS", "[]"))}
files.update({path: item["content"] for path, item in tokens.items()})
write_lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def version_string(self):
        return profile.get("server_banner", "nginx")

    def log_message(self, *args):
        pass

    def page(self, error=""):
        persona = html.escape(profile.get("persona", "Asset Operations"))
        hostname = html.escape(profile.get("hostname", "files-stage-02"))
        title = "File Vault" if profile.get("template") == "file-vault" else "Asset Console"
        return f'''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>{persona} | {title}</title><style>body{{background:#f4f6f8;color:#17202e;font:14px system-ui;display:grid;place-items:center;min-height:95vh}}main{{width:340px;padding:36px;background:white;border:1px solid #d8dde6;border-radius:8px}}small{{color:#748093}}h1{{font-size:24px}}label{{display:block;margin:18px 0 7px}}input,button{{box-sizing:border-box;width:100%;padding:11px;border:1px solid #c9d0dc;border-radius:4px}}button{{margin-top:22px;background:#253951;color:white}}.error{{color:#ad3040}}</style>
<main><small>{persona}</small><h1>{title}</h1><p>Sign in to your workspace.</p><p class="error">{html.escape(error)}</p><form action="/login" method="post"><label>Username</label><input name="username" autocomplete="off"><label>Password</label><input name="password" type="password"><button>Sign in</button></form><p><small>{hostname} · Internal services</small></p></main></html>'''.encode()

    def reply(self, status, body, content_type="text/html; charset=utf-8", capture=None, private=None):
        timing = profile.get("realism", {})
        prefix = "auth" if capture and self.command == "POST" else "response"
        minimum = timing.get(prefix + "_min_ms", 180 if prefix == "auth" else 30)
        maximum = timing.get(prefix + "_max_ms", 420 if prefix == "auth" else 120)
        time.sleep(random.uniform(minimum, maximum) / 1000)
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", "")[:8192])
        except CookieError:
            cookie = SimpleCookie()
        token = cookie["workspace_session"].value if "workspace_session" in cookie else ""
        if not re.fullmatch(r"[a-f0-9]{32}", token):
            token = secrets.token_hex(16)
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Set-Cookie", f"workspace_session={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=1800")
        self.send_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)
        parsed = urlsplit(self.path)
        event = {"event_id": str(uuid4()), "event_type": "http.login" if self.command == "POST" else "http.request",
            "source_ip": self.client_address[0], "observed_at": datetime.now(UTC).isoformat(),
            "source_session_id": hashlib.sha256((self.client_address[0] + ":" + token).encode()).hexdigest(),
            "payload": {"method": self.command, "path": unquote(parsed.path)[:1024], "status": status,
                "user_agent": self.headers.get("User-Agent", "")[:512], "decoy_access": unquote(parsed.path) in files,
                "query_fields": list(parse_qs(parsed.query))[:20], **(capture or {}),
                **({"bait_binding_id": tokens[unquote(parsed.path)]["binding_id"]} if unquote(parsed.path) in tokens else {})}}
        if private and profile.get("recording", {}).get("capture_credentials", True):
            try:
                event["private_capture"] = seal_observation(private, event["event_id"],
                    event["source_session_id"], event["event_type"])
                event["payload"]["private_capture_state"] = "sealed" if event["private_capture"] else "unavailable"
            except Exception:
                event["payload"]["private_capture_state"] = "unavailable"
        with write_lock:
            print(json.dumps(event, ensure_ascii=False), flush=True)

    def do_GET(self):
        path = unquote(urlsplit(self.path).path)
        if path in files:
            return self.reply(200, files[path].encode(), "text/plain; charset=utf-8")
        if path in {"/", "/login"}:
            return self.reply(200, self.page())
        self.send_error(404)

    def do_HEAD(self):
        self.do_GET()

    def send_error(self, code, message=None, explain=None):
        # Match the configured front server, including malformed HTTP and unknown methods.
        title = f"{code} {self.responses.get(code, ('Error',))[0]}"
        banner = html.escape(self.version_string())
        body = f"<html><head><title>{title}</title></head><body><center><h1>{title}</h1></center><hr><center>{banner}</center></body></html>\n".encode()
        self.close_connection = True
        if not hasattr(self, "headers"):
            self.headers = {}
        self.reply(code, body)

    def do_POST(self):
        if unquote(urlsplit(self.path).path) != "/login":
            return self.send_error(404)
        if self.headers.get("Transfer-Encoding") or "Content-Length" not in self.headers:
            return self.send_error(411)
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return self.send_error(400)
        if length < 0 or length > 8192:
            self.close_connection = True
            return self.send_error(413)
        raw = self.rfile.read(length)
        data = parse_qs(raw.decode(errors="replace"), keep_blank_values=True)
        username, password = data.get("username", [""])[0][:100], data.get("password", [""])[0][:200]
        limit = profile.get("recording", {}).get("http_payload_bytes", 8192)
        authenticated = any(a["username"] == username and secrets.compare_digest(a["password"], password)
            for a in profile.get("decoy_accounts", []))
        status = 200 if authenticated else 401
        body = b"<html><title>Workspace</title><h1>Service workspace</h1><p>No scheduled tasks.</p></html>" if authenticated else self.page("Invalid credentials. Please try again.")
        self.reply(status, body, capture={"username": username, "password_supplied": "password" in data,
            "authenticated": authenticated}, private={"username": username, "password": password,
                "http_payload_base64": base64.b64encode(raw[:limit]).decode(),
                "captured_bytes": min(len(raw), limit), "original_bytes": len(raw), "truncated": len(raw) > limit,
                "password_truncated": len(data.get("password", [""])[0]) > 200})

    def do_PUT(self):
        self.close_connection = True
        self.send_error(405)

    do_DELETE = do_PUT
    do_OPTIONS = do_PUT
    do_PATCH = do_PUT


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 16

    def handle_error(self, request, client_address):
        # Broken client connections are expected in a decoy.
        pass


if __name__ == "__main__":
    socket.setdefaulttimeout(10)
    Server(("0.0.0.0", 8080), Handler).serve_forever()
