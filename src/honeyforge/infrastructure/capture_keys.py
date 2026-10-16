import base64
import hashlib
import json
import os
from pathlib import Path

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from honeyforge.sensors.sealed_capture import canonical


class CaptureKeys:
    def __init__(self, directory):
        self.directory = Path(directory)
        self._key = None
        self._public = None

    def ensure(self):
        if self._key is not None:
            return self._key
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        path = self.directory / "capture-private.pem"
        if not path.exists():
            key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
            content = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption())
            # Atomic publication of a complete key; concurrent startup never replaces it.
            temporary = self.directory / f".key-{os.getpid()}-{os.urandom(6).hex()}"
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                with os.fdopen(fd, "wb") as target:
                    target.write(content)
                    target.flush()
                    os.fsync(target.fileno())
                try:
                    os.link(temporary, path)
                except FileExistsError:
                    pass
            finally:
                temporary.unlink(missing_ok=True)
        if path.stat().st_mode & 0o077:
            raise ValueError("Capture private key must have mode 0600")
        self._key = serialization.load_pem_private_key(path.read_bytes(), password=None)
        return self._key

    def public(self):
        if self._public is not None:
            return dict(self._public)
        key = self.ensure().public_key()
        pem = key.public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
        self._public = {"key_id": hashlib.sha256(pem).hexdigest(), "public_key": pem.decode()}
        return dict(self._public)

    def decrypt(self, envelope, expected_context=None):
        if set(envelope) != {"version", "key_id", "context", "wrapped_key", "nonce", "ciphertext"}:
            raise ValueError("Unexpected envelope fields")
        if set(envelope["context"]) != {"capture_id", "host_id", "deployment_id", "generation", "event_id", "source_session_id", "event_type"}:
            raise ValueError("Unexpected capture context")
        if envelope["key_id"] != self.public()["key_id"] or envelope["version"] != 1:
            raise ValueError("Unknown capture key or envelope version")
        if expected_context and any(envelope["context"].get(k) != v for k, v in expected_context.items()):
            raise ValueError("Capture scope does not match its event")
        def decode(value):
            return base64.b64decode(value, validate=True)
        if len(envelope["ciphertext"]) > 33000:
            raise ValueError("Capture exceeds budget")
        key = self.ensure().decrypt(decode(envelope["wrapped_key"]),
            padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None))
        content = AESGCM(key).decrypt(decode(envelope["nonce"]), decode(envelope["ciphertext"]),
            canonical(envelope["context"]))
        return json.loads(content)
