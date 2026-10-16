"""Crash-resumable client identity. Private keys stay on the trusted sensor."""
import json
import re
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

from honeyforge.infrastructure.certificates import atomic


class AgentIdentity:
    def __init__(self, directory):
        self.directory = Path(directory) / 'client-identities'
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.current_path, self.pending_path = self.directory / 'current.json', self.directory / 'pending.json'

    def _read(self, pointer):
        if not pointer.exists():
            return None
        value = json.loads(pointer.read_text())
        if not re.fullmatch(r'[a-f0-9]{32}', value['version']):
            raise ValueError('Invalid private identity pointer')
        return self.directory / value['version']

    def current(self):
        directory = self._read(self.current_path)
        if not directory:
            return None
        return (directory / 'certificate.pem', directory / 'key.pem')

    def _pending(self):
        directory = self._read(self.pending_path)
        if directory:
            return directory
        version = uuid4().hex
        directory = self.directory / version
        directory.mkdir(mode=0o700)
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        csr = x509.CertificateSigningRequestBuilder().subject_name(x509.Name([
            x509.NameAttribute(NameOID.COMMON_NAME, 'asset-sync')])).sign(key, hashes.SHA256())
        atomic(directory / 'key.pem', key.private_bytes(serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        atomic(directory / 'request.pem', csr.public_bytes(serialization.Encoding.PEM))
        atomic(self.pending_path, json.dumps({'version': version}).encode())
        return directory

    def ensure(self, host_id, request, install, force=False):
        current = self.current()
        if not force and not self.pending_path.exists() and current:
            certificate = x509.load_pem_x509_certificate(current[0].read_bytes())
            if certificate.not_valid_after_utc - datetime.now(UTC) > timedelta(hours=6):
                return False
        pending = self._pending()
        certificate_path = pending / 'certificate.pem'
        if not certificate_path.exists():
            result = request('POST', '/agent/v1/certificates/issue', json={'csr': (pending / 'request.pem').read_text()})
            certificate = x509.load_pem_x509_certificate(result['certificate_pem'].encode())
            key = serialization.load_pem_private_key((pending / 'key.pem').read_bytes(), password=None)
            if certificate.public_key().public_numbers() != key.public_key().public_numbers():
                raise ValueError('Issued certificate differs from the requested key')
            san = certificate.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
            if 'urn:asset-sync:host:' + host_id not in san.get_values_for_type(x509.UniformResourceIdentifier):
                raise ValueError('Issued certificate belongs to another sensor')
            atomic(certificate_path, result['certificate_pem'].encode())
            atomic(pending / 'authority.pem', result['authority_pem'].encode(), 0o644)
        # Atomic pointer means a crash cannot combine the new certificate with the old private key.
        atomic(self.current_path, json.dumps({'version': pending.name}).encode())
        install(certificate_path, pending / 'key.pem')
        result = request('POST', '/agent/v1/certificates/confirm', json={})
        if result['state'] != 'active':
            raise ValueError('Certificate activation was not confirmed')
        self.pending_path.unlink()
        return True
