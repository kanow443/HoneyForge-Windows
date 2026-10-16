"""Configure a pinned Cowrie image using synthetic, validated profile fields."""
import configparser
import json
import os
import pickle
import stat
import time
from pathlib import Path, PurePosixPath

from cowrie.scripts.fsctl import A_CONTENTS, A_NAME, A_TYPE, T_DIR, T_FILE

root = Path("/cowrie/cowrie-git")
os.chdir(root)
profile = json.loads(os.environ["PROFILE_CONFIG"])
for name in ("etc", "var/log/cowrie", "var/lib/cowrie", "var/lib/cowrie/tty", "var/lib/cowrie/downloads"):
    (root / name).mkdir(parents=True, exist_ok=True)

# This pickle comes from the pinned upstream image, never from an attacker or uploaded profile.
with (root / "src/cowrie/data/fs.pickle").open("rb") as file:
    filesystem = pickle.load(file)


def directory(parts):
    current = filesystem
    for part in parts:
        match = next((x for x in current[A_CONTENTS] if x[A_NAME] == part), None)
        if match is None:
            match = [part, T_DIR, 0, 0, 4096, stat.S_IFDIR | 0o755, time.time(), [], None, None]
            current[A_CONTENTS].append(match)
        if match[A_TYPE] != T_DIR:
            raise ValueError("Decoy parent is not a directory")
        current = match
    return current


extra_files = [{"path": item["path"], "content": item["content"]} for item in json.loads(os.environ.get("DECOY_TOKENS", "[]")) if item["kind"] == "file"]
for item in profile.get("decoy_files", []) + extra_files:
    path = PurePosixPath(item["path"])
    if ".." in path.parts or not any(str(path).startswith(p) for p in ("/home/", "/var/www/", "/opt/decoy/")):
        raise ValueError("Invalid decoy path")
    content = item["content"].encode()
    parent = directory(path.parts[1:-1])
    parent[A_CONTENTS] = [f for f in parent[A_CONTENTS] if f[A_NAME] != path.name]
    parent[A_CONTENTS].append([path.name, T_FILE, 0, 0, len(content), stat.S_IFREG | 0o644,
        time.time(), content, None, None])

# The v2 default banner represents Ubuntu 22.04; align the emulated system identity.
# These are fixed trusted templates, never arbitrary host paths requested by an attacker.
if profile.get("schema_version") == 2:
    system_files = {
        "/etc/os-release": 'PRETTY_NAME="Ubuntu 22.04.5 LTS"\nNAME="Ubuntu"\nVERSION_ID="22.04"\nID=ubuntu\nID_LIKE=debian\n',
        "/etc/issue": "Ubuntu 22.04.5 LTS\n",
        "/etc/hostname": profile["hostname"] + "\n",
    }
    for name, text in system_files.items():
        path, content = PurePosixPath(name), text.encode()
        parent = directory(path.parts[1:-1])
        parent[A_CONTENTS] = [f for f in parent[A_CONTENTS] if f[A_NAME] != path.name]
        parent[A_CONTENTS].append([path.name, T_FILE, 0, 0, len(content), stat.S_IFREG | 0o644,
            time.time(), content, None, None])

with (root / "var/lib/cowrie/profile-fs.pickle").open("wb") as file:
    pickle.dump(filesystem, file)

config = configparser.ConfigParser(interpolation=None)
config["honeypot"] = {"hostname": profile["hostname"], "backend": "shell", "logtype": "plain",
    "ttylog": "false", "idle_timeout": "120", "authentication_timeout": "30",
    "interactive_timeout": "1800" if profile.get("schema_version") == 2 else "300",
    "download_limit_size": "10485760"}
config["shell"] = {"filesystem": str(root / "var/lib/cowrie/profile-fs.pickle")}
if profile.get("schema_version") == 2:
    config["shell"].update(kernel_name="Linux", kernel_version="5.15.0-121-generic",
        kernel_build_string="#131-Ubuntu SMP", hardware_platform="x86_64", operating_system="GNU/Linux")
config["ssh"] = {"version": profile["ssh_banner"], "sftp_enabled": "true", "forwarding": "false",
    "listen_endpoints": "tcp:2222:interface=0.0.0.0"}
config["telnet"] = {"enabled": "false"}
config["output_jsonlog"] = {"enabled": "true", "logfile": "/proc/self/fd/1"}
with (root / "etc/cowrie.cfg").open("w") as file:
    config.write(file)
# Synthetic teaching login, not an operator or host credential.
accounts = profile.get("decoy_accounts")
(root / "etc/userdb.txt").write_text("".join(f'{a["username"]}:x:{a["password"]}\n' for a in accounts)
    if accounts else "root:x:!wrong\nroot:x:*\nadmin:x:*\n")
os.execv("/cowrie/cowrie-env/bin/python3", ["/cowrie/cowrie-env/bin/python3", "/app/cowrie_runtime.py"])
