"""Write a private Linux sensor configuration; credentials belong to enrollment, not this file."""
import argparse
import ipaddress
import os
import re
from pathlib import Path
from urllib.parse import urlsplit


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api", required=True)
    parser.add_argument("--address", required=True)
    parser.add_argument("--name", default="asset-sync")
    parser.add_argument("--output", default="/etc/asset-sync/agent.env")
    parser.add_argument("--ca-file", default="")
    args = parser.parse_args()
    url = urlsplit(args.api)
    ipaddress.IPv4Address(args.address)
    if url.scheme != "https" or not url.hostname or url.username or url.password or url.query or url.fragment or url.path not in {"", "/"}:
        parser.error("Use the HTTPS control-plane origin, without credentials or a path")
    if not re.fullmatch(r"[\w .-]{1,100}", args.name) or any(c in args.api for c in "\r\n\"'\\$` "):
        parser.error("Invalid name or API origin")
    path = Path(args.output)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    content = (f"HF_AGENT_API={args.api.rstrip('/')}\nHF_AGENT_ADDRESS={args.address}\nHF_AGENT_NAME={args.name}\n"
        f"HF_AGENT_BIND={args.address}\nHF_AGENT_STATE_DIR=/var/lib/asset-sync\nHF_ALLOW_INSECURE_AGENT=false\n"
        f"HF_AGENT_CA_FILE={args.ca_file}\nHF_AGENT_ROUTE_PREFIX=/assets/sync/v1\n"
        "HF_AGENT_MANAGEMENT_ADDRESS=10.88.0.1\n"
        "HF_HTTP_IMAGE=honeyforge-http:0.1.0\nHF_COWRIE_IMAGE=honeyforge-cowrie:0.1.0\nHF_TCP_IMAGE=honeyforge-tcp:0.1.0\n")
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as file:
        file.write(content)
    print("Private HTTPS sensor configuration created; no credentials printed.")


if __name__ == "__main__":
    main()
