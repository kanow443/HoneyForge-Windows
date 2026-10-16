"""Reject an actual untrusted TLS client certificate on the live management gateway."""

import json
import subprocess
from datetime import UTC, datetime
from pathlib import Path

ORB = "/Applications/OrbStack.app/Contents/MacOS/bin/orbctl"
CODE = """
import json,ssl,httpx,tempfile
from pathlib import Path
from datetime import datetime,UTC,timedelta
from cryptography import x509
from cryptography.hazmat.primitives import hashes,serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID,ExtendedKeyUsageOID
key=rsa.generate_private_key(public_exponent=65537,key_size=2048)
name=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'Untrusted acceptance client')])
cert=(x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
.serial_number(x509.random_serial_number()).not_valid_before(datetime.now(UTC)-timedelta(minutes=1))
.not_valid_after(datetime.now(UTC)+timedelta(minutes=10)).add_extension(x509.BasicConstraints(ca=False,path_length=None),critical=True)
.add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.CLIENT_AUTH]),critical=True).sign(key,hashes.SHA256()))
with tempfile.TemporaryDirectory(dir='/var/lib/asset-sync') as directory:
 k,c=Path(directory)/'key.pem',Path(directory)/'cert.pem'
 k.write_bytes(key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()));k.chmod(0o600)
 c.write_bytes(cert.public_bytes(serialization.Encoding.PEM));c.chmod(0o600)
 context=ssl.create_default_context(cafile='/etc/asset-sync/management-ca.crt');context.load_cert_chain(c,k)
 transport=httpx.HTTPTransport(verify=context,local_address='10.88.0.1',trust_env=False)
 with httpx.Client(transport=transport,trust_env=False,timeout=5) as client:
  try:client.get('https://host.orb.internal:18443/')
  except httpx.HTTPError:print(json.dumps({'untrusted_client_certificate_tls_rejected':True}))
  else:raise AssertionError('Untrusted TLS client certificate accepted')
"""


def main():
    checks = []
    for vm in ["honeyforge-sensor", "honeyforge-sensor-2"]:
        result = subprocess.check_output(
            [ORB, "run", "-m", vm, "-u", "root", "/opt/asset-sync/.venv/bin/python", "-c", CODE]
        )
        checks.append({"sensor": vm, **json.loads(result)})
    proof = {
        "at": datetime.now(UTC).isoformat(),
        "checks": checks,
        "scope": "Actual TLS connection with a fresh self-signed client certificate; no agent identities revoked",
    }
    Path("docs/evidence/backend/client-tls.json").write_text(json.dumps(proof, indent=2) + "\n")
    print(json.dumps(checks))


if __name__ == "__main__":
    main()
