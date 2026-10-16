"""Bounded local read benchmark; never extrapolate its measurements to a cloud SLA."""
import json
import math
import ssl
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path

import httpx


def main():
    private = Path(".runtime/production-acceptance")
    environment = dict(line.split("=", 1) for line in (private / "stack-a.env").read_text().splitlines())
    context = ssl.create_default_context(cafile=str(private / "ca-a.crt"))
    results = []
    with httpx.Client(base_url=environment["HF_PUBLIC_ORIGIN"], verify=context, trust_env=False, timeout=10) as client:
        login = client.post("/api/v1/auth/login", json={"username": environment["HF_ADMIN_USERNAME"], "password": environment["HF_ADMIN_PASSWORD"]})
        login.raise_for_status()
        client.headers["X-CSRF-Token"] = login.json()["csrf_token"]

        def request(_):
            started = time.monotonic()
            try:
                response = client.get("/api/v1/profiles")
                success = response.status_code == 200 and isinstance(response.json(), list)
            except (httpx.HTTPError, ValueError):
                success = False
            return (time.monotonic() - started) * 1000, success

        for concurrency, count in ((2, 100), (8, 300)):
            started = time.monotonic()
            with ThreadPoolExecutor(max_workers=concurrency) as pool:
                values = list(pool.map(request, range(count)))
            duration = time.monotonic() - started
            latencies = sorted(value[0] for value in values)
            results.append({"concurrency": concurrency, "requests": count, "duration_seconds": round(duration, 3),
                "requests_per_second": round(count / duration, 2), "failures": sum(not value[1] for value in values),
                "p50_ms": round(latencies[math.ceil(count * 0.5) - 1], 2),
                "p95_ms": round(latencies[math.ceil(count * 0.95) - 1], 2), "p99_ms": round(latencies[math.ceil(count * 0.99) - 1], 2)})
        soak_started, failures, count = time.monotonic(), 0, 0
        while time.monotonic() - soak_started < 30:
            _, success = request(None)
            failures += not success
            count += 1
            time.sleep(0.25)
        client.post("/api/v1/auth/logout").raise_for_status()
    evidence = {"at": datetime.now(UTC).isoformat(), "scope": "Local Docker Desktop/OrbStack on Apple Silicon; HTTPS read-only profiles API on a small acceptance database. No ingestion, UI render or external SLA measurement.",
        "method": "nearest-rank quantiles of individual HTTP requests; pool queue wait excluded", "stages": results,
        "soak": {"duration_seconds": round(time.monotonic() - soak_started, 3), "requests": count, "failures": failures}}
    Path("docs/evidence/backend/production-benchmark.json").write_text(json.dumps(evidence, indent=2) + "\n")
    print(json.dumps(evidence, ensure_ascii=False))
    assert not any(row["failures"] for row in results) and failures == 0


if __name__ == "__main__":
    main()
