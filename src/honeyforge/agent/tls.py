"""TLS chain/name validation plus pre-request SPKI pin verification."""
import base64
import hashlib
import hmac
import socket
import ssl
from urllib.parse import urlsplit

from cryptography import x509
from cryptography.hazmat.primitives import serialization


def spki_pin(certificate_der):
    public = x509.load_der_x509_certificate(certificate_der).public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    return 'sha256/' + base64.b64encode(hashlib.sha256(public).digest()).decode()


def parse_pins(value):
    pins = tuple(part.strip() for part in value.split(',') if part.strip())
    if len(pins) > 2:
        raise ValueError('Use at most two server pins during certificate rotation')
    for pin in pins:
        if not pin.startswith('sha256/') or len(base64.b64decode(pin[7:], validate=True)) != 32:
            raise ValueError('Invalid server SPKI pin')
    return pins


class PinnedContext(ssl.SSLContext):
    def __new__(cls, cafile=None, pins=()):
        return super().__new__(cls, ssl.PROTOCOL_TLS_CLIENT)

    def __init__(self, cafile=None, pins=()):
        self.pins = pins
        self.minimum_version = ssl.TLSVersion.TLSv1_2
        self.check_hostname = True
        self.verify_mode = ssl.CERT_REQUIRED
        self.load_verify_locations(cafile=cafile) if cafile else self.load_default_certs()

    def wrap_socket(self, *args, **kwargs):
        connection = super().wrap_socket(*args, **kwargs)
        if self.pins:
            actual = spki_pin(connection.getpeercert(binary_form=True))
            if not any(hmac.compare_digest(actual, pin) for pin in self.pins):
                connection.close()
                raise ssl.SSLCertVerificationError('Management server SPKI pin mismatch')
        return connection


def discover_pin(url, ca_file):
    """Bootstrap from an explicitly trusted CA; never TOFU or disable validation."""
    parsed = urlsplit(url)
    if parsed.scheme != 'https' or not parsed.hostname:
        raise ValueError('Pin discovery requires HTTPS')
    context = ssl.create_default_context(cafile=ca_file)
    with socket.create_connection((parsed.hostname, parsed.port or 443), timeout=10) as raw:
        with context.wrap_socket(raw, server_hostname=parsed.hostname) as connection:
            return spki_pin(connection.getpeercert(binary_form=True))
