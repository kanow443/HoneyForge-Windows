"""Restore a checked private backup into an empty, independent Compose installation."""
import argparse
import hashlib
import json
import subprocess
import tarfile
from pathlib import Path, PurePosixPath


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", required=True)
    parser.add_argument("--project", required=True)
    parser.add_argument("--backup", required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    source = Path(args.backup)
    manifest = json.loads((source / "manifest.json").read_text())
    if manifest["format"] != "honeyforge-backup-v1" or set(manifest["files"]) != {"database.dump", "evidence.tar"}:
        raise ValueError("Unsupported backup manifest")
    for name, expected in manifest["files"].items():
        path = source / name
        with path.open("rb") as file:
            if path.stat().st_size != expected["bytes"] or hashlib.file_digest(file, "sha256").hexdigest() != expected["sha256"]:
                raise ValueError("Backup checksum mismatch")
    with tarfile.open(source / "evidence.tar") as archive:
        for member in archive:
            path = PurePosixPath(member.name)
            if path.is_absolute() or ".." in path.parts or not (member.isdir() or member.isfile()):
                raise ValueError("Unsafe binary volume archive")
            if path.parts and path.parts[0] not in {"evidence", "keys"}:
                raise ValueError("Unexpected volume contents")
    command = ["docker", "compose", "--env-file", str(Path(args.env_file).resolve()), "-p", args.project,
        "-f", str(root / "compose.production.yml")]

    def compose(*parts, data=None):
        return subprocess.run([*command, *parts], input=data, check=True, capture_output=True).stdout

    active = compose("ps", "-q", "api").decode().strip()
    if not active:
        raise RuntimeError("Start the empty destination stack before restore")
    query = "SELECT (SELECT count(*) FROM profiles)+(SELECT count(*) FROM events)+(SELECT count(*) FROM hosts)+(SELECT count(*) FROM integration_tokens);"
    if compose("exec", "-T", "postgres", "psql", "-U", "honeyforge", "-d", "honeyforge", "-Atc", query).strip() != b"0":
        raise ValueError("Destination has application data; restore refused")
    users = compose("exec", "-T", "postgres", "psql", "-U", "honeyforge", "-d", "honeyforge", "-Atc", "SELECT count(*) FROM users;").strip()
    if users != b"1":
        raise ValueError("Destination user setup is not empty")
    mounts = json.loads(subprocess.check_output(["docker", "inspect", "--format", "{{json .Mounts}}", active]))
    volume = next(m["Name"] for m in mounts if m["Destination"] == "/var/lib/honeyforge" and m["Type"] == "volume")
    helper = ["docker", "run", "--rm", "--network", "none", "--cap-drop", "ALL", "--user", "10001:10001",
        "--security-opt", "no-new-privileges:true", "--mount", f"type=volume,src={volume},dst=/evidence", "postgres:17.7-alpine"]
    if subprocess.check_output([*helper, "find", "/evidence/evidence", "-type", "f", "-print", "-quit"]).strip():
        raise ValueError("Destination evidence volume is not empty")
    compose("stop", "api")
    # Resume only after both stores restore successfully. Failed restore remains
    # offline; restart would publish an inconsistent database/volume combination.
    with (source / "database.dump").open("rb") as file:
        result = subprocess.run([*command, "exec", "-T", "postgres", "pg_restore", "-U", "honeyforge", "-d", "honeyforge",
            "--clean", "--if-exists", "--exit-on-error"], stdin=file, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if result.returncode:
            raise RuntimeError("Database restore failed; destination API remains stopped")
    with (source / "evidence.tar").open("rb") as file:
        result = subprocess.run([*helper[:3], "-i", *helper[3:], "tar", "--no-same-owner", "-C", "/evidence", "-xf", "-"],
            stdin=file, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if result.returncode:
            raise RuntimeError("Binary restore failed; destination API remains stopped")
    compose("start", "api")
    compose("up", "-d", "--no-build", "--wait", "api")
    compose("restart", "management")
    print("Both stores restored. Use source installation credentials; rotate copied agent/integration keys before concurrent operation.")


if __name__ == "__main__":
    main()
