"""Bounded output capture independent of Cowrie; deterministic limits and explicit loss events."""
import codecs
import time


class OutputCapture:
    def __init__(self, emit, schedule, budget=256 * 1024, pending_limit=64 * 1024, frame_limit=16 * 1024):
        self.emit, self.schedule = emit, schedule
        self.budget, self.pending_limit, self.frame_limit = budget, pending_limit, frame_limit
        self.buffer = bytearray()
        self.total = self.dropped = 0
        self.pending = None
        self.first_at = None
        self.decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        self.truncated = False
        self.closed = False

    def add(self, data):
        if self.closed or not data:
            return
        allowed = max(0, min(len(data), self.budget - self.total, self.pending_limit - len(self.buffer)))
        if allowed:
            if not self.buffer:
                self.first_at = time.time()
            self.buffer.extend(data[:allowed])
            self.total += allowed
        self.dropped += len(data) - allowed
        if self.pending is None:
            self.pending = self.schedule(0.1, self.flush)

    def flush(self, final=False):
        if self.pending is not None and self.pending.active():
            self.pending.cancel()
        self.pending = None
        while self.buffer:
            data = bytes(self.buffer[:self.frame_limit])
            del self.buffer[:self.frame_limit]
            text = self.decoder.decode(data)
            if text:
                self.emit("honeyforge.terminal.output", "Captured terminal output", text=text,
                    time=self.first_at or time.time(), capture="shell-output", byte_count=len(data))
            if not final:
                break
        if self.dropped and not self.truncated:
            self.truncated = True
            self.emit("honeyforge.terminal.truncated", "Terminal capture limit reached", capture="shell-output",
                message="Terminal output capture was truncated by the per-channel byte or pending-buffer quota",
                capture_limit_bytes=self.budget, pending_limit_bytes=self.pending_limit)
        if self.buffer:
            self.pending = self.schedule(0.1, self.flush)
        elif final:
            text = self.decoder.decode(b"", final=True)
            if text:
                self.emit("honeyforge.terminal.output", "Captured terminal output", text=text,
                    time=self.first_at or time.time(), capture="shell-output", byte_count=0)

    def close(self):
        if self.closed:
            return
        self.flush(final=True)
        self.closed = True
