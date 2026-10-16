import base64
import socket
import ssl
import threading
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

from honeyforge.agent.tls import PinnedContext, parse_pins, spki_pin


def test_pin_rejects_before_sending_credentials_and_accepts_overlap(tmp_path):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'localhost')])
    cert = x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key()).serial_number(
        x509.random_serial_number()).not_valid_before(datetime.now(UTC) - timedelta(minutes=1)).not_valid_after(
        datetime.now(UTC) + timedelta(days=1)).add_extension(x509.SubjectAlternativeName([x509.DNSName('localhost')]), False).add_extension(
        x509.BasicConstraints(ca=True, path_length=None), True).sign(key, hashes.SHA256())
    ca = tmp_path / 'ca.pem'
    ca.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    private = tmp_path / 'key.pem'
    private.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    server_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    server_context.load_cert_chain(ca, private)
    listener = socket.socket()
    listener.bind(('127.0.0.1', 0))
    listener.listen(3)
    received = []

    def serve():
        for _ in range(3):
            raw, _ = listener.accept()
            try:
                with server_context.wrap_socket(raw, server_side=True) as connection:
                    data = connection.recv(8192)
                    received.append(data)
                    if data:
                        connection.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK')
            except (ssl.SSLError, BrokenPipeError, ConnectionResetError):
                received.append(b'')
        listener.close()

    thread = threading.Thread(target=serve, daemon=True)
    thread.start()
    pin = spki_pin(cert.public_bytes(serialization.Encoding.DER))
    wrong = 'sha256/' + base64.b64encode(bytes(32)).decode()
    url = f'https://localhost:{listener.getsockname()[1]}/'
    with httpx.Client(transport=httpx.HTTPTransport(verify=PinnedContext(str(ca), (wrong,))), trust_env=False) as client:
        with pytest.raises(httpx.ConnectError, match='SPKI pin mismatch'):
            client.get(url, headers={'Authorization': 'Bearer secret-that-must-not-be-sent'})
    for pins in ((pin,), (wrong, pin)):
        with httpx.Client(transport=httpx.HTTPTransport(verify=PinnedContext(str(ca), pins)), trust_env=False) as client:
            assert client.get(url).status_code == 200
    thread.join(timeout=5)
    assert len(received) == 3 and received[0] == b'' and all(b'secret-that-must-not-be-sent' not in data for data in received)
    with pytest.raises(ValueError):
        parse_pins('sha256/bad')
