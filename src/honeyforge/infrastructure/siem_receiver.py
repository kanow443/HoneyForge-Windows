"""Reference pull receiver: atomic event deduplication and cursor persistence."""
import argparse
import json
import sqlite3
from pathlib import Path
from urllib.parse import urlsplit

import httpx


class Receiver:
    def __init__(self, path, origin):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.db = sqlite3.connect(path)
        path.chmod(0o600)
        self.db.executescript("""
            PRAGMA journal_mode=WAL;
            PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY CHECK(id=1),origin TEXT NOT NULL,cursor INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,sequence INTEGER NOT NULL,body TEXT NOT NULL);
        """)
        with self.db:
            self.db.execute("INSERT OR IGNORE INTO state VALUES(1,?,0)", (origin,))
        if self.db.execute("SELECT origin FROM state WHERE id=1").fetchone()[0] != origin:
            raise ValueError("Use a separate receiver state for each API origin")

    def cursor(self):
        return self.db.execute("SELECT cursor FROM state WHERE id=1").fetchone()[0]

    def accept(self, page, expected_cursor):
        if page["format"] != "honeyforge-ecs-events-v1" or page["reset_required"] or page["next_cursor"] < expected_cursor:
            raise ValueError("Receiver requires explicit reconciliation after an API stream reset")
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            if self.cursor() != expected_cursor:
                raise ValueError("Receiver cursor changed; poll again")
            for event in page["items"]:
                self.db.execute("INSERT OR IGNORE INTO events VALUES(?,?,?)",
                    (event["event"]["id"], event["event"]["sequence"], json.dumps(event, ensure_ascii=False)))
            self.db.execute("UPDATE state SET cursor=? WHERE id=1", (page["next_cursor"],))

    def close(self):
        self.db.close()


def run():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api", required=True)
    parser.add_argument("--token-file", required=True)
    parser.add_argument("--state", required=True)
    parser.add_argument("--max-pages", type=int, default=20)
    args = parser.parse_args()
    url = urlsplit(args.api)
    if url.scheme != "https" and not (url.scheme == "http" and url.hostname in {"127.0.0.1", "localhost", "::1"}):
        parser.error("Use HTTPS outside the local lab")
    if url.username or url.password or url.query or url.fragment or not 1 <= args.max_pages <= 1000:
        parser.error("Invalid API origin or page budget")
    token_path = Path(args.token_file)
    if token_path.stat().st_mode & 0o077:
        parser.error("Integration credential file must be private (mode 600)")
    token = token_path.read_text().strip()
    receiver = Receiver(args.state, args.api.rstrip("/"))
    try:
        has_more = False
        with httpx.Client(base_url=args.api, headers={"Authorization": "Bearer " + token}, trust_env=False, timeout=10) as client:
            for _ in range(args.max_pages):
                cursor = receiver.cursor()
                response = client.get("/integration/v1/events", params={"after": cursor})
                response.raise_for_status()
                page = response.json()
                receiver.accept(page, cursor)
                has_more = page["has_more"]
                if not has_more:
                    break
        count = receiver.db.execute("SELECT count(*) FROM events").fetchone()[0]
        print(json.dumps({"stored_events": count, "cursor": receiver.cursor(), "has_more": has_more, "page_budget_exhausted": has_more, "storage": "local-receiver; downstream SIEM receipt is separate"}))
    finally:
        receiver.close()
