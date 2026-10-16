"""Generate one private, independent deployment configuration. Never overwrite credentials."""
import argparse
import os
import re
import secrets
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--domain", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--https-port", type=int, default=443)
    parser.add_argument("--http-port", type=int, default=80)
    parser.add_argument("--management-domain", default="")
    parser.add_argument("--management-port", type=int, default=18443)
    parser.add_argument("--loopback", action="store_true", help="Bind published ports to loopback for the local acceptance only")
    args = parser.parse_args()
    management_domain = args.management_domain or "sync." + args.domain
    if not all(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.-]{0,252}", d) for d in [args.domain, management_domain]) or not all(1 <= p <= 65535 for p in (args.https_port, args.http_port, args.management_port)):
        parser.error("Use a DNS hostname and valid ports")
    path = Path(args.output)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    origin = "https://" + args.domain + (":" + str(args.https_port) if args.https_port != 443 else "")
    content = (f"HF_SITE_DOMAIN={args.domain}\nHF_PUBLIC_ORIGIN={origin}\nHF_HTTP_PORT={args.http_port}\n"
        f"HF_HTTPS_PORT={args.https_port}\nHF_HTTP_BIND={'127.0.0.1' if args.loopback else '0.0.0.0'}\n"
        f"HF_MANAGEMENT_DOMAIN={management_domain}\nHF_MANAGEMENT_PORT={args.management_port}\n"
        f"HF_MANAGEMENT_BIND={'127.0.0.1' if args.loopback else '0.0.0.0'}\n"
        f"HF_MANAGEMENT_TLS={'internal' if args.loopback else 'admin@' + args.domain}\n"
        f"HF_SYNC_PROXY_SECRET={secrets.token_hex(32)}\nPOSTGRES_PASSWORD={secrets.token_hex(24)}\nHF_ADMIN_USERNAME=operator\nHF_ADMIN_PASSWORD={secrets.token_hex(24)}\n")
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as file:
        file.write(content)
    print("Private deployment configuration created. Credentials were not printed.")


if __name__ == "__main__":
    main()
