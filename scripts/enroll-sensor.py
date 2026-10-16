"""Register once without shell-sourcing configuration or exposing the token in argv."""
import argparse
from pathlib import Path

from honeyforge.agent.main import Agent
from honeyforge.infrastructure.settings import Settings


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--token-file", required=True)
    parser.add_argument("--env-file", default="/etc/asset-sync/agent.env")
    args = parser.parse_args()
    token = Path(args.token_file)
    if token.stat().st_mode & 0o077:
        parser.error("Enrollment token file must have mode 0600")
    config = Settings(_env_file=args.env_file)
    if (Path(config.agent_state_dir) / "credentials.json").exists():
        parser.error("This sensor already has an identity; enrollment would discard its history")
    agent = Agent(config)
    try:
        agent.enroll(token.read_text().strip())
    finally:
        agent.http.close()
    token.unlink()
    print("Registered; one-time token removed. Start asset-sync.service.")


if __name__ == "__main__":
    main()
