import gzip
from pathlib import Path

import httpx
import pytest

from honeyforge.infrastructure.geo_update import download, fetch_database


def test_range_change_is_rejected_and_existing_database_preserved(tmp_path):
    target = tmp_path / 'dbip-city-lite.mmdb'
    target.write_bytes(b'previous-valid-data')
    def mock(request):
        if request.method == 'HEAD':
            return httpx.Response(200, headers={'content-length': '20', 'etag': 'original'})
        return httpx.Response(206, headers={'content-range': 'bytes 0-19/20', 'etag': 'changed'}, content=b'x'*20)
    with httpx.Client(transport=httpx.MockTransport(mock)) as client:
        with pytest.raises(ValueError, match='changed'):
            download('city', '2026-10', tmp_path, client)
    assert target.read_bytes() == b'previous-valid-data'


def test_wrong_type_and_corrupt_gzip_cannot_replace_data(tmp_path):
    data = gzip.compress(Path('tests/fixtures/mmdb/GeoLite2-ASN-Test.mmdb').read_bytes())
    def mock(request):
        if request.method == 'HEAD':
            return httpx.Response(200, headers={'content-length': str(len(data))})
        return httpx.Response(206, headers={'content-range': f'bytes 0-{len(data)-1}/{len(data)}'}, content=data)
    with httpx.Client(transport=httpx.MockTransport(mock)) as client:
        with pytest.raises(ValueError, match='Wrong database'):
            download('city', '2026-10', tmp_path, client)
    assert not (tmp_path / 'dbip-city-lite.mmdb').exists()


def test_range_bounds_and_reassembly(tmp_path):
    content = bytes(range(256))*160
    def mock(request):
        if request.method == 'HEAD':
            return httpx.Response(200, headers={'content-length':str(len(content)), 'etag':'same'})
        start,end = map(int,request.headers['Range'][6:].split('-'))
        return httpx.Response(206, headers={'content-range':f'bytes {start}-{end}/{len(content)}','etag':'same'}, content=content[start:end+1])
    with httpx.Client(transport=httpx.MockTransport(mock)) as client:
        output=tmp_path/'candidate.gz'
        assert fetch_database('https://download.db-ip.com/test',output,client)==len(content)
    assert output.read_bytes()==content


def test_city_mirror_mismatch_falls_back_to_publisher_and_preserves_old(tmp_path, monkeypatch):
    import hashlib

    from honeyforge.infrastructure import geo_update
    calls = []
    raw = b'original publisher bytes'
    target = tmp_path / 'dbip-city-lite.mmdb'
    target.write_bytes(b'previous')
    monkeypatch.setattr(geo_update, 'publisher_checksum', lambda *args: hashlib.sha1(raw).hexdigest())
    def mirror(kind, compressed, candidate, client):
        compressed.write_bytes(gzip.compress(b'stale mirror'))
        return 'https://mirror.invalid', 1
    def publisher(url, compressed, client):
        calls.append(url)
        compressed.write_bytes(gzip.compress(raw))
        return 1
    monkeypatch.setattr(geo_update, 'fetch_mirror', mirror)
    monkeypatch.setattr(geo_update, 'fetch_database', publisher)
    with httpx.Client() as client, pytest.raises(Exception):
        # Correct publisher bytes here deliberately aren't an MMDB: must still not replace data.
        download('city', '2026-10', tmp_path, client)
    assert len(calls) == 1 and 'download.db-ip.com' in calls[0]
    assert target.read_bytes() == b'previous'
