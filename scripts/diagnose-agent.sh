#!/usr/bin/env bash
set -euo pipefail
cd /opt/asset-sync
/opt/asset-sync/.venv/bin/python - <<'PY' > /home/honeyforge/agent-diagnostic.json
import json
import sqlite3
import time

from honeyforge.agent.main import Agent
from honeyforge.infrastructure.settings import Settings

agent = Agent(Settings(_env_file='/etc/asset-sync/agent.env'))
credentials = json.loads(agent.credentials_path.read_text())
agent.http.headers['Authorization'] = 'Bearer ' + credentials['key']
result = {}
try:
    start = time.monotonic()
    response = agent.http.get(agent.config.agent_route_prefix + '/runtimes', timeout=15)
    result['management_status'] = response.status_code
    result['management_seconds'] = round(time.monotonic() - start, 2)
except Exception as error:
    result['management_error_type'] = type(error).__name__
    result['management_error'] = str(error)[:200]

path = agent.state / 'outbox.sqlite3'
result['spool_bytes'] = path.stat().st_size if path.exists() else None
if path.exists():
    with sqlite3.connect(f'file:{path}?mode=ro', uri=True, timeout=10) as db:
        for table in ('outbox', 'seen', 'quarantine'):
            start = time.monotonic()
            result[table + '_rows'] = db.execute('SELECT count(*) FROM ' + table).fetchone()[0]
            result[table + '_count_seconds'] = round(time.monotonic() - start, 2)
print(json.dumps(result, sort_keys=True))
PY
chown honeyforge:honeyforge /home/honeyforge/agent-diagnostic.json
chmod 0600 /home/honeyforge/agent-diagnostic.json
echo 'Agent diagnostic saved.'
