"""Pin the verified management server public key; preserve enrolment and all other settings."""
from pathlib import Path

from honeyforge.agent.tls import discover_pin
from honeyforge.infrastructure.settings import Settings

path = Path('/etc/asset-sync/agent.env')
config = Settings(_env_file=path)
pin = discover_pin(config.agent_api, config.agent_ca_file or None)
# Pin value is public, but the rest of agent.env stays private and is never printed.
lines = [line for line in path.read_text().splitlines() if not line.startswith('HF_AGENT_SERVER_SPKI_PINS=')]
path.write_text('\n'.join(lines + ['HF_AGENT_SERVER_SPKI_PINS=' + pin]) + '\n')
path.chmod(0o600)
print('Verified server public key pinned. Restart asset-sync to apply it.')
