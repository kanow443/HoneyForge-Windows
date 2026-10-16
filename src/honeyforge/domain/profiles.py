from pathlib import PurePosixPath
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, field_validator, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class DecoyFile(StrictModel):
    path: str = Field(min_length=1, max_length=160)
    content: str = Field(max_length=8192)

    @field_validator("path")
    @classmethod
    def safe_path(cls, value: str) -> str:
        path = PurePosixPath(value)
        if not value.startswith("/") or ".." in path.parts or "\\" in value or "\x00" in value:
            raise ValueError("Use an absolute decoy path without traversal or backslashes")
        if not any(value.startswith(prefix) for prefix in ("/home/", "/var/www/", "/opt/decoy/")):
            raise ValueError("Decoy paths must be inside /home, /var/www or /opt/decoy")
        return str(path)


class Limits(StrictModel):
    memory_mb: int = Field(default=128, ge=64, le=512)
    cpu: float = Field(default=0.5, ge=0.1, le=2)
    pids: int = Field(default=64, ge=32, le=256)


class BaseProfile(StrictModel):
    schema_version: Literal[1] = 1
    hostname: str = Field(default="files-stage-02", pattern=r"^[a-zA-Z0-9][a-zA-Z0-9.-]{0,62}$")
    persona: str = Field(default="Asset Operations", min_length=1, max_length=80)
    decoy_files: list[DecoyFile] = Field(default_factory=list, max_length=12)
    limits: Limits = Field(default_factory=Limits)

    @field_validator("persona")
    @classmethod
    def plain_text(cls, value: str) -> str:
        if any(ord(c) < 32 for c in value):
            raise ValueError("Control characters are not allowed")
        return value

    @field_validator("decoy_files")
    @classmethod
    def unique_paths(cls, files: list[DecoyFile]) -> list[DecoyFile]:
        if len({f.path for f in files}) != len(files):
            raise ValueError("Decoy paths must be unique")
        return files


class HttpProfile(BaseProfile):
    adapter: Literal["http"] = "http"
    template: Literal["asset-console", "file-vault"] = "asset-console"
    server_banner: str = Field(default="nginx", pattern=r"^[A-Za-z0-9 ./_-]{1,64}$")


class SshProfile(BaseProfile):
    adapter: Literal["cowrie"] = "cowrie"
    ssh_banner: str = Field(default="SSH-2.0-OpenSSH_8.9p1 Ubuntu-3", pattern=r"^SSH-2\.0-[A-Za-z0-9 ._-]{1,80}$")
    download_mode: Literal["blocked", "fixture"] = "blocked"


class DecoyAccount(StrictModel):
    username: str = Field(pattern=r"^[A-Za-z0-9_.-]{1,64}$")
    password: str = Field(default="hackathon-demo", pattern=r"^[A-Za-z0-9_.@-]{8,128}$")


class Recording(StrictModel):
    capture_credentials: bool = True
    http_payload_bytes: int = Field(default=8192, ge=0, le=8192)
    shell_output_bytes: int = Field(default=262144, ge=16384, le=1048576)


class Beacon(StrictModel):
    interval_seconds: float = Field(default=5, ge=1, le=60)
    jitter_ratio: float = Field(default=0.2, ge=0.1, le=0.5)


class Realism(StrictModel):
    response_min_ms: int = Field(default=30, ge=0, le=500)
    response_max_ms: int = Field(default=120, ge=0, le=1000)
    auth_min_ms: int = Field(default=180, ge=0, le=1000)
    auth_max_ms: int = Field(default=420, ge=0, le=1500)

    @model_validator(mode="after")
    def ordered_ranges(self):
        if self.response_min_ms > self.response_max_ms or self.auth_min_ms > self.auth_max_ms:
            raise ValueError("Minimum response delay cannot exceed maximum")
        return self


class ProfileOptions(StrictModel):
    recommended_port: int = Field(default=18080, ge=1024, le=65535)
    decoy_accounts: list[DecoyAccount] = Field(default_factory=lambda: [DecoyAccount(username="root")], min_length=1, max_length=8)
    recording: Recording = Field(default_factory=Recording)
    beacon: Beacon = Field(default_factory=Beacon)
    realism: Realism = Field(default_factory=Realism)

    @field_validator("decoy_accounts")
    @classmethod
    def unique_accounts(cls, values):
        if len({v.username for v in values}) != len(values):
            raise ValueError("Decoy usernames must be unique")
        return values


class HttpProfileV2(HttpProfile, ProfileOptions):
    schema_version: Literal[2] = 2


class SshProfileV2(SshProfile, ProfileOptions):
    schema_version: Literal[2] = 2
    recommended_port: int = Field(default=2222, ge=1024, le=65535)


class TcpBannerProfile(BaseProfile, ProfileOptions):
    schema_version: Literal[2] = 2
    adapter: Literal["tcp-banner"] = "tcp-banner"
    recommended_port: int = Field(default=2223, ge=1024, le=65535)
    banner: str = Field(default="SSH-2.0-OpenSSH_8.9p1", min_length=1, max_length=256)
    response: str = Field(default="Protocol mismatch.", max_length=256)

    @field_validator("banner", "response")
    @classmethod
    def plain_banner(cls, value):
        if any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise ValueError("Use a single line without control characters")
        return value


LegacyProfileConfig = Annotated[HttpProfile | SshProfile, Field(discriminator="adapter")]
ModernProfileConfig = Annotated[HttpProfileV2 | SshProfileV2 | TcpBannerProfile, Field(discriminator="adapter")]


class ProfileService(StrictModel):
    key: str = Field(pattern=r"^[a-z][a-z0-9-]{0,23}$")
    port: int = Field(ge=1024, le=65535)
    config: ModernProfileConfig


class BundleProfile(StrictModel):
    schema_version: Literal[3] = 3
    adapter: Literal["bundle"] = "bundle"
    hostname: str = Field(default="files-stage-02", pattern=r"^[a-zA-Z0-9][a-zA-Z0-9.-]{0,62}$")
    persona: str = Field(default="Asset Operations", min_length=1, max_length=80)
    services: list[ProfileService] = Field(min_length=2, max_length=8)

    @model_validator(mode="after")
    def unique_services(self):
        if len({s.key for s in self.services}) != len(self.services):
            raise ValueError("Service keys must be unique")
        if len({s.port for s in self.services}) != len(self.services):
            raise ValueError("Service ports must be unique")
        if any(ord(c) < 32 for c in self.persona):
            raise ValueError("Control characters are not allowed")
        return self


ProfileConfig = LegacyProfileConfig | ModernProfileConfig | BundleProfile


def validate_profile(value):
    return TypeAdapter(ProfileConfig).validate_python({"schema_version": 1, **value})


def interaction_level(adapter: str) -> str:
    return {"tcp-banner": "low", "http": "medium", "cowrie": "medium", "bundle": "mixed"}[adapter]


def runtime_config(config: dict, service_key: str | None = None) -> dict:
    """Resolve one immutable version into a service config without rewriting its hash."""
    if config["adapter"] != "bundle":
        if service_key is not None:
            raise ValueError("A single-service profile has no service key")
        return config
    service = next((s for s in config["services"] if s["key"] == service_key), None)
    if service is None:
        raise ValueError("Service key is absent from this version")
    return {**service["config"], "hostname": config["hostname"], "persona": config["persona"],
        "recommended_port": service["port"]}
