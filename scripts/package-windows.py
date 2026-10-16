"""Build a source-only Windows distribution; never include runtime state or existing archives."""
import hashlib
import io
import json
import stat
import subprocess
import zipfile
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOP = {"src", "apps", "infra", "scripts", "tests", "docs", "deliverables", "packages"}
ROOT_FILES = {"README.md", "README_WINDOWS.md", "LICENSE", "pyproject.toml", "uv.lock", "alembic.ini",
    "compose.yml", "compose.production.yml", "compose.windows.yml", "compose.geo.yml",
    "compose.management-local.yml", ".env.example", ".dockerignore", ".gitignore", ".gitattributes",
    "START_WINDOWS.cmd", "INSTALL_PREREQUISITES.cmd", "setup-windows.sh"}
EXCLUDED = {".git", ".runtime", ".venv", "node_modules", "dist", "__pycache__", ".pytest_cache",
    ".ruff_cache", "test-results", "playwright-report", ".DS_Store"}


def sources():
    names = subprocess.check_output(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=ROOT)
    result = []
    for name in sorted(set(names.decode().split("\0")) - {""}):
        path = Path(name)
        if (path.parts[0] not in TOP and name not in ROOT_FILES) or any(p in EXCLUDED for p in path.parts):
            continue
        if path.suffix in {".zip", ".pyc"} or path.name == ".env" or path.is_absolute() or ".." in path.parts:
            continue
        if path.parts[0] == "deliverables" and path.suffix not in {".pptx", ".docx", ".pdf", ".md"}:
            continue
        full = ROOT / path
        if not full.is_file() or full.is_symlink():
            continue
        result.append(path)
    return result


def put(archive, name, data, executable=False):
    item = zipfile.ZipInfo(name, datetime.now(UTC).timetuple()[:6])
    item.compress_type = zipfile.ZIP_DEFLATED
    item.external_attr = (stat.S_IFREG | (0o755 if executable else 0o644)) << 16
    archive.writestr(item, data)


def main():
    files = sources()
    required = {"START_WINDOWS.cmd", "README_WINDOWS.md", "setup-windows.sh", "compose.windows.yml",
        "scripts/windows/install-sensor-ubuntu.sh", "scripts/windows/HoneyForge.ps1",
        "scripts/windows/Restore.ps1", "scripts/windows/Backup.ps1", "uv.lock", "apps/web/package-lock.json"}
    missing = required - {str(f) for f in files}
    if missing:
        raise RuntimeError(f"Required distribution files missing: {sorted(missing)}")
    sensor = io.BytesIO()
    with zipfile.ZipFile(sensor, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in files:
            if path.parts[0] in {"src", "infra", "scripts"} or str(path) in {"pyproject.toml", "uv.lock", "alembic.ini", ".dockerignore"}:
                put(archive, str(path), (ROOT/path).read_bytes(), path.suffix == ".sh")
    sensor_data = sensor.getvalue()
    public_geo = {}
    for kind in ('city', 'asn'):
        base = ROOT / '.runtime/geo-final' / f'dbip-{kind}-lite'
        report = json.loads(base.with_suffix('.json').read_text())
        data = base.with_suffix('.mmdb').read_bytes()
        if hashlib.sha256(data).hexdigest() != report['sha256'] or not report.get('publisher_sha1'):
            raise RuntimeError('Only publisher-verified public databases may be packaged')
        public_geo[f'data/geo/dbip-{kind}-lite.mmdb'] = data
        public_geo[f'data/geo/dbip-{kind}-lite.json'] = base.with_suffix('.json').read_bytes()
    public_geo['data/geo/LICENSE.txt'] = b'DB-IP City and ASN Lite. Copyright DB-IP. CC BY 4.0. Attribution: https://db-ip.com . License: https://creativecommons.org/licenses/by/4.0/ . Original data, no modifications. Release metadata and SHA256 are provided next to each database.\n'

    manifest = {"format": "honeyforge-windows-source-v1", "created_at": datetime.now(UTC).isoformat(),
        "source_commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "includes_uncommitted_packaging_changes": True,
        "runtime_data_included": False, "windows_runtime_acceptance": "Not executed on a Windows PC",
        "files": {}}
    target = ROOT / "deliverables/HoneyForge-Windows-2026.10.11.zip"
    target.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in files:
            data = (ROOT/path).read_bytes()
            name = str(path)
            manifest["files"][name] = {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}
            put(archive, "HoneyForge-Windows/"+name, data, path.suffix == ".sh")
        for name, data in public_geo.items():
            manifest['files'][name] = {'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}
            put(archive, 'HoneyForge-Windows/' + name, data)
        manifest['public_geo_data_included'] = True
        manifest["files"]["sensor-source.zip"] = {"sha256": hashlib.sha256(sensor_data).hexdigest(), "bytes": len(sensor_data)}
        put(archive, "HoneyForge-Windows/sensor-source.zip", sensor_data)
        put(archive, "HoneyForge-Windows/PACKAGE_MANIFEST.json", json.dumps(manifest, ensure_ascii=False, indent=2).encode())
    with zipfile.ZipFile(target) as archive:
        if archive.testzip():
            raise RuntimeError("ZIP integrity check failed")
        for name, entry in manifest["files"].items():
            data = archive.read("HoneyForge-Windows/"+name)
            if hashlib.sha256(data).hexdigest() != entry["sha256"]:
                raise RuntimeError(f"Manifest mismatch: {name}")
    with target.open("rb") as file:
        digest = hashlib.file_digest(file, "sha256").hexdigest()
    target.with_suffix(".zip.sha256").write_text(digest+"  "+target.name+"\n")
    print(json.dumps({"archive": str(target), "bytes": target.stat().st_size,
        "files": len(manifest["files"]), "sha256": digest}, indent=2))


if __name__ == "__main__":
    main()
