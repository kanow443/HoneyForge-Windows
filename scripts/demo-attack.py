"""Real interactions against the dedicated lab traps; no event fixtures or external targets."""
import argparse
import json
import time
from pathlib import Path

import httpx
import paramiko


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--http", action="store_true")
    parser.add_argument("--ssh", action="store_true")
    args = parser.parse_args()
    if not args.http and not args.ssh:
        args.http = args.ssh = True
    demo = json.loads(Path(".runtime/demo.json").read_text())
    address = demo["host"]["address"]
    if address != "192.168.139.142":
        raise RuntimeError("This demonstration script only targets the dedicated isolated lab sensor")
    if args.http:
        with httpx.Client(base_url=f"http://{address}:18080", trust_env=False, timeout=5) as client:
            for path in ["/", "/opt/decoy/backup-notes.txt"]:
                response = client.get(path)
                print(f"HTTP {response.status_code} {path}")
                time.sleep(1)
            response = client.post("/login", data={"username": "demo-operator", "password": "synthetic-demo-only"})
            print("HTTP login attempt:", response.status_code)
    if args.ssh:
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        client.connect(address, port=2222, username="root", password="hackathon-demo", timeout=5,
            allow_agent=False, look_for_keys=False)
        shell = client.invoke_shell()
        for command in ["whoami", "hostname", "uname -a", "cat /home/admin/backup-notes.txt", "exit"]:
            shell.send(command + "\n")
            time.sleep(1)
            output = b""
            while shell.recv_ready():
                output += shell.recv(8192)
            print(output.decode(errors="replace"), end="")
        client.close()


if __name__ == "__main__":
    main()
