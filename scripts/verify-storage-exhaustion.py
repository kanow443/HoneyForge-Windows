"""Real bounded tmpfs exhaustion: never fill the workstation or production evidence volume."""
import json
import subprocess
from datetime import UTC, datetime
from pathlib import Path

program = '''import errno,hashlib,json,os
from pathlib import Path
root=Path('/proof')
old=root/'accepted.bin'; data=b'Accepted evidence'
old.write_bytes(data); expected=hashlib.sha256(data).hexdigest()
error=None
try:
 with (root/'incoming.part').open('wb') as stream:
  stream.write(b'x'*131072); stream.flush(); os.fsync(stream.fileno())
except OSError as failure:error=failure.errno
print(json.dumps({'errno':error,'actual_enospc':error==errno.ENOSPC,'accepted_sha256_unchanged':hashlib.sha256(old.read_bytes()).hexdigest()==expected,'accepted_bytes':len(old.read_bytes())}))
assert error==errno.ENOSPC and old.read_bytes()==data
'''
result = subprocess.run(['docker', 'run', '--rm', '-i', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--user', '10001:10001', '--entrypoint', 'python', '--tmpfs', '/proof:rw,nosuid,nodev,noexec,size=64k,uid=10001,gid=10001,mode=0700',
    'honeyforge-tcp:0.1.0', '-'], input=program, text=True, capture_output=True, check=True)
proof = {'at': datetime.now(UTC).isoformat(), 'measurement': 'Actual 64 KiB tmpfs ENOSPC in isolated non-root container',
    'checks': json.loads(result.stdout), 'boundary': 'OS failure verified independently; API503/no-offset-advance/retry is covered by test_storage_failure.py. No production disk was filled.'}
Path('docs/evidence/backend/storage-exhaustion.json').write_text(json.dumps(proof, indent=2) + '\n')
print(json.dumps(proof, indent=2))
