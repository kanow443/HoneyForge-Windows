"""Consistent database + binary volume backup during a short control API pause."""
import argparse
import hashlib
import json
import os
import subprocess
from datetime import UTC, datetime
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", required=True)
    parser.add_argument("--project", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    destination = Path(args.output)
    destination.mkdir(parents=True, exist_ok=False, mode=0o700)
    command = ["docker", "compose", "--env-file", str(Path(args.env_file).resolve()), "-p", args.project,
        "-f", str(root / "compose.production.yml")]

    def compose(*parts):
        return subprocess.run([*command, *parts], check=True, capture_output=True).stdout

    container = compose("ps", "-q", "api").decode().strip()
    if not container:
        raise RuntimeError("API container is absent; backup did not start")
    mounts = json.loads(subprocess.check_output(["docker", "inspect", "--format", "{{json .Mounts}}", container]))
    volume = next(m["Name"] for m in mounts if m["Destination"] == "/var/lib/honeyforge" and m["Type"] == "volume")
    hashes = {}

    def capture(path, command):
        with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as file:
            process = subprocess.run(command, stdout=file, stderr=subprocess.PIPE)
        if process.returncode:
            raise RuntimeError("Backup command failed; partial backup must not be restored")
        with path.open("rb") as file:
            hashes[path.name] = {"sha256": hashlib.file_digest(file, "sha256").hexdigest(), "bytes": path.stat().st_size}

    compose("stop", "api")
    try:
        capture(destination / "database.dump", [*command, "exec", "-T", "postgres", "pg_dump", "-U", "honeyforge", "-d", "honeyforge", "-Fc"])
        capture(destination / "evidence.tar", ["docker", "run", "--rm", "--network", "none", "--cap-drop", "ALL", "--read-only", "--user", "10001:10001",
            "--mount", f"type=volume,src={volume},dst=/evidence,readonly", "postgres:17.7-alpine", "tar", "-C", "/evidence", "-cf", "-", "."])
        manifest = {"format": "honeyforge-backup-v1", "at": datetime.now(UTC).isoformat(), "project": args.project,
            "schema": compose("exec", "-T", "postgres", "psql", "-U", "honeyforge", "-d", "honeyforge", "-Atc", "SELECT version_num FROM alembic_version").decode().strip(),
            "files": hashes, "key_storage": "Centre capture keys are included in the private volume archive; protect this backup.",
            "credential_source": "Keep the original private deployment env separately; it is deliberately excluded."}
        path = destination / "manifest.json"
        with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as file:
            json.dump(manifest, file, ensure_ascii=False, indent=2)
            file.write("\n")
    finally:
        compose("start", "api")
        compose("up", "-d", "--no-build", "--wait", "api")
    print("Consistent private backup completed; API resumed. Verify restore on an independent installation.")


if __name__ == "__main__":
    main()
