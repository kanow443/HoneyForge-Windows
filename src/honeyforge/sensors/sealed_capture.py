"""Public-key envelopes: no decryption key is present on a decoy or sensor."""
import base64
import json
import os
from uuid import uuid4

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def seal(public_pem, key_id, context, content):
    plaintext = canonical(content)
    if len(plaintext) > 24576:
        raise ValueError("Capture exceeds the bounded envelope budget")
    key = AESGCM.generate_key(bit_length=256)
    nonce = os.urandom(12)
    public = serialization.load_pem_public_key(public_pem.encode())
    ciphertext = AESGCM(key).encrypt(nonce, plaintext, canonical(context))
    wrapped = public.encrypt(key, padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None))
    def encode(value):
        return base64.b64encode(value).decode()
    return {"version": 1, "key_id": key_id, "context": context,
        "wrapped_key": encode(wrapped), "nonce": encode(nonce), "ciphertext": encode(ciphertext)}


def capture(content, event_id, source_session_id, event_type):
    pem = os.environ.get("CAPTURE_PUBLIC_KEY")
    if not pem:
        return None
    context = {"capture_id": str(uuid4()), "host_id": os.environ["CAPTURE_HOST_ID"],
        "deployment_id": os.environ["CAPTURE_DEPLOYMENT_ID"], "generation": os.environ["CAPTURE_GENERATION"],
        "event_id": event_id, "source_session_id": source_session_id, "event_type": event_type}
    return seal(pem, os.environ["CAPTURE_KEY_ID"], context, content)
