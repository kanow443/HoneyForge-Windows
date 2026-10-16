import hashlib
import json
import secrets

from argon2 import PasswordHasher
from argon2.exceptions import VerificationError

password_hasher = PasswordHasher()


def secret() -> str:
    return secrets.token_urlsafe(32)


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def config_digest(value: dict) -> str:
    return digest(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")))


def verify_password(encoded: str, value: str) -> bool:
    try:
        return password_hasher.verify(encoded, value)
    except VerificationError:
        return False


SENSITIVE_KEYS = {"password", "passwd", "authorization", "cookie", "token", "secret", "api_key"}


def sanitize(value, depth=0):
    if depth > 8:
        return "[depth limit]"
    if isinstance(value, dict):
        return {str(k)[:100]: "[redacted]" if any(s in str(k).lower() for s in SENSITIVE_KEYS)
            else sanitize(v, depth + 1) for k, v in list(value.items())[:100]}
    if isinstance(value, list):
        return [sanitize(v, depth + 1) for v in value[:100]]
    if isinstance(value, str):
        return "".join(c for c in value[:8192] if c in "\n\t" or ord(c) >= 32)
    return value
