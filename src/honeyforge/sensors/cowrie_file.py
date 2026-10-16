"""Export one hash-addressed sample from the private tmpfs; never execute it."""
import hashlib
import os
import re
import stat
import sys


def run():
    checksum = sys.argv[1]
    if not re.fullmatch(r"[0-9a-f]{64}", checksum):
        raise ValueError("Invalid evidence checksum")
    descriptor = os.open("/cowrie/cowrie-git/var/lib/cowrie/downloads/" + checksum, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "rb") as file:
        info = os.fstat(file.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > 10 * 1024 * 1024:
            raise ValueError("Expected a bounded regular evidence file")
        content = file.read(10 * 1024 * 1024 + 1)
        if not content or len(content) > 10 * 1024 * 1024 or hashlib.sha256(content).hexdigest() != checksum:
            raise ValueError("Evidence checksum mismatch")
    sys.stdout.buffer.write(content)


if __name__ == "__main__":
    run()
