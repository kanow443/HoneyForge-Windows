"""Private agent CA and two-phase certificate rotation with five minute overlap."""
import hashlib
import os
import secrets
from datetime import timedelta
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
from sqlalchemy import select

from honeyforge.domain.errors import DomainError
from honeyforge.infrastructure.models import AgentCertificate, Host, now
from honeyforge.infrastructure.projections import record


def atomic(path, content, mode=0o600, exclusive=False):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.parent / ('.' + path.name + '-' + secrets.token_hex(8))
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        if exclusive:
            try:
                os.link(temporary, path)
            except FileExistsError:
                pass
        else:
            temporary.replace(path)
        # Windows cannot open a directory with os.open; the file itself was fsynced above.
        if os.name != 'nt':
            directory_fd = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
    finally:
        temporary.unlink(missing_ok=True)


class AgentAuthority:
    def __init__(self, directory, public_directory):
        self.directory, self.public_directory = Path(directory), Path(public_directory)
        self.key, self.certificate = None, None

    def ensure(self):
        if self.key:
            return
        root = self.directory / 'agent-authority'
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        key_path, certificate_path = root / 'private.pem', root / 'ca.pem'
        if not key_path.exists():
            if certificate_path.exists():
                raise RuntimeError('Original agent authority private key is required')
            key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
            atomic(key_path, key.private_bytes(serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8, serialization.NoEncryption()), exclusive=True)
        key = serialization.load_pem_private_key(key_path.read_bytes(), password=None)
        if not certificate_path.exists():
            name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'Asset Management Authority')])
            certificate = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
                .serial_number(x509.random_serial_number()).not_valid_before(now() - timedelta(minutes=5))
                .not_valid_after(now() + timedelta(days=3650))
                .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
                .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=False, key_encipherment=False,
                    data_encipherment=False, key_agreement=False, key_cert_sign=True, crl_sign=True,
                    encipher_only=False, decipher_only=False), critical=True)
                .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
                .sign(key, hashes.SHA256()))
            atomic(certificate_path, certificate.public_bytes(serialization.Encoding.PEM), 0o644, exclusive=True)
        certificate = x509.load_pem_x509_certificate(certificate_path.read_bytes())
        if certificate.public_key().public_numbers() != key.public_key().public_numbers():
            raise RuntimeError('Agent authority certificate and key differ')
        self.public_directory.mkdir(parents=True, exist_ok=True, mode=0o755)
        atomic(self.public_directory / 'ca.pem', certificate.public_bytes(serialization.Encoding.PEM), 0o644)
        self.key, self.certificate = key, certificate

    def issue(self, host_id, csr):
        self.ensure()
        key = csr.public_key()
        subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'asset-sync-' + host_id)])
        certificate = (x509.CertificateBuilder().subject_name(subject).issuer_name(self.certificate.subject)
            .public_key(key).serial_number(x509.random_serial_number()).not_valid_before(now() - timedelta(minutes=1))
            .not_valid_after(now() + timedelta(hours=24))
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.CLIENT_AUTH]), critical=True)
            .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=False, key_encipherment=True,
                data_encipherment=False, key_agreement=False, key_cert_sign=False, crl_sign=False,
                encipher_only=False, decipher_only=False), critical=True)
            .add_extension(x509.SubjectAlternativeName([x509.UniformResourceIdentifier('urn:asset-sync:host:' + host_id)]), critical=False)
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(self.key.public_key()), critical=False)
            .sign(self.key, hashes.SHA256()))
        return certificate


class CertificateService:
    def __init__(self, database, config):
        self.database, self.config = database, config
        self.authority = AgentAuthority(config.capture_key_dir, config.agent_ca_public_dir or str(Path(config.capture_key_dir) / "agent-authority" / "public"))
        self.authority.ensure()

    @staticmethod
    def parse_csr(pem):
        try:
            csr = x509.load_pem_x509_csr(pem.encode())
            if not csr.is_signature_valid or not isinstance(csr.public_key(), rsa.RSAPublicKey) or csr.public_key().key_size < 2048:
                raise ValueError('Unsupported or invalid CSR')
            public = csr.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
            return csr, hashlib.sha256(public).hexdigest()
        except Exception:
            raise DomainError('invalid_certificate_request', 'A valid signed RSA2048+ CSR is required', 422) from None

    def issue(self, host_id, pem, fingerprint=None):
        csr, public_hash = self.parse_csr(pem)
        with self.database.unit_of_work() as u:
            u.lock_write()
            host = u.repo.get(Host, host_id)
            if not host or host.revoked_at:
                raise DomainError('invalid_agent_key', 'Invalid agent identity', 401)
            prior = u.repo.find(AgentCertificate, host_id=host_id, public_key_hash=public_hash)
            confirmed = u.session.scalar(select(AgentCertificate.id).where(AgentCertificate.host_id == host_id, AgentCertificate.confirmed_at.is_not(None)).limit(1))
            permitted = u.session.scalar(select(AgentCertificate.id).where(AgentCertificate.host_id == host_id,
                AgentCertificate.fingerprint == fingerprint, AgentCertificate.state.in_(['pending', 'active', 'overlap']),
                AgentCertificate.revoked_at.is_(None), AgentCertificate.accept_until > now(), AgentCertificate.expires_at > now()))
            if confirmed and not permitted:
                raise DomainError('agent_certificate_required', 'Current agent certificate is required for rotation', 401)
            if prior and prior.state in {'pending', 'active'} and prior.expires_at > now():
                return self._issuance(prior)
            if prior:
                raise DomainError('fresh_certificate_key_required', 'Use a fresh key for the next certificate', 409)
            pending = u.session.scalar(select(AgentCertificate.id).where(AgentCertificate.host_id == host_id,
                AgentCertificate.state == 'pending', AgentCertificate.expires_at > now()).limit(1))
            if pending:
                raise DomainError('certificate_rotation_pending', 'Complete the existing pending rotation first', 409)
            certificate = self.authority.issue(host_id, csr)
            row = u.repo.add(AgentCertificate(host_id=host_id, public_key_hash=public_hash,
                fingerprint=certificate.fingerprint(hashes.SHA256()).hex(),
                certificate_pem=certificate.public_bytes(serialization.Encoding.PEM).decode(),
                serial=str(certificate.serial_number), state='pending', expires_at=certificate.not_valid_after_utc,
                accept_until=certificate.not_valid_after_utc))
            u.audit('agent:' + host_id, 'certificate.issued', row.id, {'fingerprint': row.fingerprint})
            u.emit('certificate.changed', {'host_id': host_id})
            return self._issuance(row)

    def _issuance(self, row):
        return {**record(row), 'authority_pem': self.authority.certificate.public_bytes(serialization.Encoding.PEM).decode(),
            'overlap_seconds': 300, 'confirmation_required': row.state == 'pending'}

    def authorize(self, host_id, fingerprint):
        if not fingerprint:
            raise DomainError('agent_certificate_required', 'Agent certificate is required', 401)
        with self.database.sessions() as s:
            row = s.scalar(select(AgentCertificate).where(AgentCertificate.host_id == host_id,
                AgentCertificate.fingerprint == fingerprint))
            if not row or row.revoked_at or row.state == 'revoked' or row.expires_at <= now() or row.accept_until <= now():
                raise DomainError('agent_certificate_rejected', 'Agent certificate is invalid, expired or revoked', 401)
            return row.id

    def confirm(self, host_id, fingerprint):
        self.authorize(host_id, fingerprint)
        with self.database.unit_of_work() as u:
            u.lock_write()
            row = u.repo.find(AgentCertificate, host_id=host_id, fingerprint=fingerprint)
            if row.revoked_at or row.accept_until <= now() or row.expires_at <= now():
                raise DomainError('agent_certificate_rejected', 'Certificate cannot be confirmed', 401)
            if row.state == 'pending':
                if row.revoked_at or row.accept_until <= now():
                    raise DomainError('agent_certificate_rejected', 'Certificate cannot be confirmed', 401)
                for old in u.session.scalars(select(AgentCertificate).where(AgentCertificate.host_id == host_id,
                    AgentCertificate.state.in_(['active', 'overlap']), AgentCertificate.id != row.id)):
                    old.state = 'overlap'
                    old.accept_until = min(old.accept_until, now() + timedelta(seconds=300))
                row.state, row.confirmed_at = 'active', now()
                u.audit('agent:' + host_id, 'certificate.confirmed', row.id, {'overlap_seconds': 300})
                u.emit('certificate.changed', {'host_id': host_id})
            return record(row)

    def revoke(self, actor, certificate_id):
        with self.database.unit_of_work() as u:
            u.lock_write()
            row = u.repo.get(AgentCertificate, certificate_id)
            if not row:
                raise DomainError('not_found', 'Certificate was not found', 404)
            if row.revoked_at is None:
                row.state, row.revoked_at, row.accept_until = 'revoked', now(), now()
                u.audit(actor, 'certificate.revoked', row.id)
                u.emit('certificate.changed', {'host_id': row.host_id})
            return record(row)

    def list(self, host_id):
        with self.database.sessions() as s:
            return [record(r) for r in s.scalars(select(AgentCertificate).where(AgentCertificate.host_id == host_id)
                .order_by(AgentCertificate.created_at.desc()).limit(100))]
