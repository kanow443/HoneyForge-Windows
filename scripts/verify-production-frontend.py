"""Compare the served HTTPS frontend and every gateway asset with the accepted local build."""
import argparse
import hashlib
import json
import ssl
import subprocess
import tempfile
from datetime import UTC, datetime
from pathlib import Path

import httpx


def digest(directory):
    checksum = hashlib.sha256()
    files = sorted(path for path in directory.rglob("*") if path.is_file())
    for path in files:
        checksum.update(path.relative_to(directory).as_posix().encode())
        checksum.update(path.read_bytes())
    return checksum.hexdigest(), len(files)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", default="hf-prod-acceptance-a")
    parser.add_argument("--origin", default="https://localhost:19443")
    parser.add_argument("--ca-file", default=".runtime/production-acceptance/ca-a.crt")
    parser.add_argument("--dist", default="apps/web/dist")
    parser.add_argument("--output", default="docs/evidence/backend/final-build.json")
    args = parser.parse_args()
    local = Path(args.dist)
    expected, count = digest(local)
    assert count and local.joinpath("index.html").is_file()
    with tempfile.TemporaryDirectory(prefix="hf-frontend-verify-") as directory:
        exported = Path(directory)
        subprocess.run(["docker", "cp", args.project + "-gateway-1:/srv/.", directory],
            check=True, capture_output=True)
        actual, actual_count = digest(exported)
        assert actual == expected and actual_count == count, "Gateway differs from accepted frontend build"
    with httpx.Client(base_url=args.origin, verify=ssl.create_default_context(cafile=args.ca_file),
        trust_env=False) as client:
        response = client.get("/traps/new")
        response.raise_for_status()
        assert response.content == local.joinpath("index.html").read_bytes()
    proof = {"at": datetime.now(UTC).isoformat(), "project": args.project,
        "scope": "All static gateway files and real trusted HTTPS deep link; auth/UI behavior checked separately",
        "frontend_dist_sha256": expected, "file_count": count, "exact_gateway_files_match": True,
        "exact_https_index_match": True, "passed": True}
    Path(args.output).write_text(json.dumps(proof, indent=2) + "\n")
    print(json.dumps(proof))


if __name__ == "__main__":
    main()
