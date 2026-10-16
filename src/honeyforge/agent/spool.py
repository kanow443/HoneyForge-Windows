import json
import sqlite3
import threading
from pathlib import Path


class Spool:
    """Atomic collector cursor + durable outbox; bounded and restart-safe."""
    def __init__(self, path: Path, quota=256 * 1024 * 1024):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.quota = quota
        self.lock = threading.RLock()
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY, body TEXT NOT NULL, bytes INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS seen(id TEXT PRIMARY KEY, at REAL DEFAULT (unixepoch()));
            CREATE TABLE IF NOT EXISTS cursors(source TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS stats(name TEXT PRIMARY KEY, value INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS quarantine(id TEXT PRIMARY KEY, body TEXT NOT NULL, reason TEXT NOT NULL);
        """)
        path.chmod(0o600)

    def cursor(self, source, fallback="0"):
        with self.lock:
            row = self.db.execute("SELECT value FROM cursors WHERE source=?", (source,)).fetchone()
            return row[0] if row else fallback

    def seen(self, event_id):
        with self.lock:
            return self.db.execute("SELECT 1 FROM seen WHERE id=?", (event_id,)).fetchone() is not None

    def _increment(self, name, amount=1):
        self.db.execute("INSERT INTO stats(name,value) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=value+excluded.value", (name, amount))

    def collect(self, source: str, cursor: str, events: list[dict], parser_errors=0):
        with self.lock, self.db:
            size = self.db.execute("SELECT coalesce(sum(bytes),0) FROM outbox").fetchone()[0]
            for event in events:
                if self.db.execute("SELECT 1 FROM seen WHERE id=?", (event["event_id"],)).fetchone():
                    continue
                body = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
                count = len(body.encode())
                if size + count > self.quota:
                    self._increment("dropped_events")
                else:
                    self.db.execute("INSERT OR IGNORE INTO outbox VALUES(?,?,?)", (event["event_id"], body, count))
                    size += count
                self.db.execute("INSERT OR IGNORE INTO seen(id) VALUES(?)", (event["event_id"],))
            self.db.execute("INSERT INTO cursors VALUES(?,?) ON CONFLICT(source) DO UPDATE SET value=excluded.value", (source, cursor))
            self._increment("parser_errors", parser_errors)
            self.db.execute("DELETE FROM seen WHERE at < unixepoch()-86400 AND id NOT IN (SELECT id FROM outbox)")

    def batch(self):
        with self.lock:
            result, size = [], 0
            for row in self.db.execute("SELECT body,bytes FROM outbox ORDER BY rowid LIMIT 100"):
                if size + row[1] > 480000:
                    break
                result.append(json.loads(row[0]))
                size += row[1]
            return result

    def acknowledge(self, accepted, rejected):
        with self.lock, self.db:
            for item in rejected:
                row = self.db.execute("SELECT body FROM outbox WHERE id=?", (item["event_id"],)).fetchone()
                if row:
                    self.db.execute("INSERT OR REPLACE INTO quarantine VALUES(?,?,?)", (item["event_id"], row[0], item["reason"]))
                self.db.execute("DELETE FROM outbox WHERE id=?", (item["event_id"],))
            self.db.executemany("DELETE FROM outbox WHERE id=?", [(key,) for key in accepted])
            self.db.execute("DELETE FROM quarantine WHERE rowid NOT IN (SELECT rowid FROM quarantine ORDER BY rowid DESC LIMIT 1000)")

    def metrics(self):
        with self.lock:
            return {"queued_events": self.db.execute("SELECT count(*) FROM outbox").fetchone()[0],
                **dict(self.db.execute("SELECT name,value FROM stats"))}

    def increment(self, name, amount=1):
        with self.lock, self.db:
            self._increment(name, amount)
