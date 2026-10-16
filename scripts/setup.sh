#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
mkdir -p .runtime
chmod 700 .runtime
if [ ! -f .env ]; then
  python3 - <<'PY'
from pathlib import Path
import secrets
db, password = secrets.token_urlsafe(24), secrets.token_urlsafe(18)
text = Path('.env.example').read_text().replace('replace-this', db).replace('replace-with-a-long-random-password', password).replace('replace-proxy-secret', secrets.token_hex(32))
Path('.env').write_text(text)
Path('.env').chmod(0o600)
Path('.runtime/access.txt').write_text('Username: operator\nPassword: '+password+'\nLocal UI: http://localhost:5173\n')
Path('.runtime/access.txt').chmod(0o600)
PY
fi
uv sync --extra dev
docker compose up -d --wait postgres
uv run alembic upgrade head
uv run hf-admin init

uv run python - <<'PY'
from honeyforge.infrastructure.certificates import CertificateService
from honeyforge.infrastructure.settings import settings
from honeyforge.infrastructure.database import Database
CertificateService(Database(settings.database_url), settings)
PY
