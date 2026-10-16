from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="HF_", env_file=".env", extra="ignore")
    database_url: str = "postgresql+psycopg://honeyforge:honeyforge@127.0.0.1:55432/honeyforge"
    admin_username: str = "operator"
    admin_password: str = ""
    cookie_secure: bool = False
    public_origin: str = "http://localhost:5173"
    bind: str = "127.0.0.1"
    port: int = 8100
    agent_api: str = "http://127.0.0.1:8100"
    agent_route_prefix: str = Field(default="/assets/sync/v1", pattern=r"^/[A-Za-z0-9_/-]+$")
    agent_ca_file: str = ""
    agent_server_spki_pins: str = ""
    agent_cert_file: str = ""
    agent_key_file: str = ""
    agent_management_address: str = ""
    require_agent_mtls: bool = False
    sync_proxy_secret: str = ""
    agent_ca_public_dir: str = ""
    geo_city_db: str = ""
    geo_asn_db: str = ""
    agent_name: str = "Development sensor"
    agent_address: str = "127.0.0.1"
    agent_state_dir: str = ".runtime/agent"
    agent_bind: str = "127.0.0.1"
    allow_insecure_agent: bool = False
    http_image: str = "honeyforge-http:0.1.0"
    cowrie_image: str = "honeyforge-cowrie:0.1.0"
    tcp_image: str = "honeyforge-tcp:0.1.0"
    lease_seconds: int = 45
    heartbeat_seconds: int = 5
    offline_seconds: int = 30
    session_hours: int = 12
    event_retention_days: int = 7
    artifact_dir: str = ".runtime/evidence"
    capture_key_dir: str = ".runtime/keys"
    artifact_quota_bytes: int = Field(default=1024 * 1024 * 1024, ge=1024 * 1024)
    agent_artifact_quota_bytes: int = Field(default=512 * 1024 * 1024, ge=1024 * 1024)
    # Includes one maximum-sized final record; stays below the 16 MiB wire budget.
    pcap_segment_bytes: int = Field(default=4 * 1024 * 1024, ge=65536, le=15 * 1024 * 1024)
    pcap_segment_seconds: int = Field(default=30, ge=1, le=300)


settings = Settings()
