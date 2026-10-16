"""Bounded, verified downloads of publicly redistributable DB-IP Lite databases."""
import argparse
import gzip
import hashlib
import json
import os
import re
import tempfile
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path

import httpx
import maxminddb

ATTRIBUTION = {'provider': 'DB-IP', 'url': 'https://db-ip.com',
    'license': 'CC BY 4.0', 'license_url': 'https://creativecommons.org/licenses/by/4.0/'}
MAX_COMPRESSED = 200 * 1024 * 1024
MAX_EXPANDED = 350 * 1024 * 1024


def fetch_database(url, compressed, client):
    # Small independently validated ranges also work through size-limited lab gateways.
    # Parallelism and total bytes are bounded; a failed range never replaces active data.
    head = client.head(url)
    head.raise_for_status()
    total = int(head.headers.get("content-length", "0"))
    if not 0 < total <= MAX_COMPRESSED:
        raise ValueError("Missing or excessive Content-Length")
    etag = head.headers.get("etag")
    block = 16384

    def fetch(offset):
        end = min(total, offset + block) - 1
        for attempt in range(3):
            try:
                result = client.get(url + f"?part={offset}", headers={"Range": f"bytes={offset}-{end}", "Connection": "close"})
                result.raise_for_status()
                if result.status_code != 206 or result.headers.get("content-range") != f"bytes {offset}-{end}/{total}":
                    raise ValueError("Server did not honor the validated range")
                if len(result.content) != end - offset + 1 or (etag and result.headers.get("etag") != etag):
                    raise ValueError("Download changed or range is incomplete")
                return offset, result.content
            except httpx.HTTPError:
                if attempt == 2:
                    raise
        raise AssertionError("Unreachable")

    with compressed.open("w+b") as output, ThreadPoolExecutor(max_workers=16) as executor:
        for offset, content in executor.map(fetch, range(0, total, block)):
            output.seek(offset)
            output.write(content)
        output.flush()
        os.fsync(output.fileno())
    return total


def publisher_checksum(kind, month, client):
    page = client.get(f'https://db-ip.com/db/download/ip-to-{kind}-lite')
    page.raise_for_status()
    # The last checksum is the MMDB format, the first is CSV. Tie it to the requested release.
    section = page.text[page.text.rfind('SHA1SUM'):]
    match = re.search(r'<dd[^>]*>\s*([0-9a-f]{40})\s*</dd>', section)
    if not match or f'dbip-{kind}-lite-{month}.mmdb.gz' not in section:
        raise ValueError('No publisher checksum for the requested MMDB release')
    return match.group(1)


def fetch_mirror(kind, compressed, candidate, client):
    # Mirrors only deliver bytes. They are never trusted without the publisher's own checksum.
    if kind != 'city':
        raise ValueError('Only an original City mirror is supported')
    url = 'https://cdn.jsdelivr.net/npm/dbip-city-lite/dbip-city-lite.mmdb.gz'
    target = compressed
    received = 0
    with client.stream('GET', url) as response:
        response.raise_for_status()
        with target.open('wb') as output:
            for chunk in response.iter_bytes(65536):
                received += len(chunk)
                if received > MAX_COMPRESSED:
                    raise ValueError('Mirror exceeds the download budget')
                output.write(chunk)
    return url, received


def download(kind, month, directory, client):
    """Validate the entire candidate before atomically replacing a working reader file."""
    if kind not in {'city', 'asn'} or not re.fullmatch(r'20\d\d-(0[1-9]|1[0-2])', month):
        raise ValueError('Use city/asn and a YYYY-MM release')
    directory.mkdir(parents=True, exist_ok=True)
    url = f'https://download.db-ip.com/free/dbip-{kind}-lite-{month}.mmdb.gz'
    target = directory / f'dbip-{kind}-lite.mmdb'
    with tempfile.TemporaryDirectory(prefix='.geo-update-', dir=directory) as temporary:
        compressed, candidate = Path(temporary) / 'download.gz', Path(temporary) / 'candidate.mmdb'
        source_url = url
        expected_sha1 = None
        try:
            expected_sha1 = publisher_checksum(kind, month, client)
        except (ValueError, httpx.HTTPError):
            pass
        def expand_and_hash():
            expanded, digest, legacy_digest = 0, hashlib.sha256(), hashlib.sha1()
            expanded_path = Path(temporary) / 'verified.mmdb'
            with gzip.open(compressed, 'rb') as source, expanded_path.open('wb') as output:
                while chunk := source.read(65536):
                    expanded += len(chunk)
                    if expanded > MAX_EXPANDED:
                        raise ValueError('Expanded database exceeds storage budget')
                    output.write(chunk)
                    digest.update(chunk)
                    legacy_digest.update(chunk)
                output.flush()
                os.fsync(output.fileno())
            if expected_sha1 and legacy_digest.hexdigest() != expected_sha1:
                raise ValueError('Database does not match the original DB-IP publisher checksum')
            return expanded_path, expanded, digest

        if expected_sha1 and kind == 'city':
            try:
                source_url, received = fetch_mirror(kind, compressed, candidate, client)
                expanded_path, expanded, digest = expand_and_hash()
            except (ValueError, OSError, httpx.HTTPError):
                received = fetch_database(url, compressed, client)
                source_url = url
                expanded_path, expanded, digest = expand_and_hash()
        else:
            received = fetch_database(url, compressed, client)
            expanded_path, expanded, digest = expand_and_hash()
        candidate = expanded_path
        with maxminddb.open_database(candidate) as reader:
            metadata = reader.metadata()
            if kind.lower() not in metadata.database_type.lower() or metadata.node_count < 1000:
                raise ValueError('Wrong database type or non-production-sized database')
            built_at = datetime.fromtimestamp(metadata.build_epoch, UTC)
            if built_at > datetime.now(UTC):
                raise ValueError('Database is dated in the future')
            # Sanity check two well-known public prefixes; do not use this as accuracy proof.
            if not any(reader.get(ip) for ip in ('8.8.8.8', '1.1.1.1')):
                raise ValueError('Database has no records for public validation prefixes')
            report = {**ATTRIBUTION, 'release': month, 'download_url': url,
                'downloaded_at': datetime.now(UTC).isoformat(), 'built_at': built_at.isoformat(),
                'database_type': metadata.database_type, 'sha256': digest.hexdigest(),
                'publisher_sha1': expected_sha1, 'source_url': source_url,
                'size_bytes': expanded, 'compressed_bytes': received}
        os.chmod(candidate, 0o644)
        os.replace(candidate, target)
        manifest = Path(temporary) / 'manifest.json'
        manifest.write_text(json.dumps(report, indent=2) + '\n')
        os.replace(manifest, target.with_suffix('.json'))
        return report


def run():
    parser = argparse.ArgumentParser(description='Install/update DB-IP City and ASN Lite (CC BY 4.0)')
    parser.add_argument('--directory', default='.runtime/geo')
    parser.add_argument('--month', default=datetime.now(UTC).strftime('%Y-%m'))
    args = parser.parse_args()
    # HTTPS verification always enabled; no credentials or attacker-controlled download URL.
    with httpx.Client(timeout=httpx.Timeout(15, connect=10), follow_redirects=False, trust_env=False) as client:
        reports = {kind: download(kind, args.month, Path(args.directory), client) for kind in ('city', 'asn')}
    print(json.dumps(reports, indent=2))


if __name__ == '__main__':
    run()
