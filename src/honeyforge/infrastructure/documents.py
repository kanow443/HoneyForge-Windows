"""Checksums over the exact Pydantic JSON representation returned by the API."""
import hashlib
import json


def canonical_document(model, data):
    normalized = model.model_validate({**data, "sha256": ""}).model_dump(mode="json")
    del normalized["sha256"]
    encoded = json.dumps(normalized, sort_keys=True, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode()
    return {**normalized, "sha256": hashlib.sha256(encoded).hexdigest()}
