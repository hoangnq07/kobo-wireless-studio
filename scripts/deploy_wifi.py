#!/usr/bin/env python3
"""Deploy built webfiles.lua to a Kobo e-reader via Wi-Fi HTTP (:8080) or USB drive.

Usage:
    python -X utf8 scripts/deploy_wifi.py --host 192.168.1.188
    python -X utf8 scripts/deploy_wifi.py --usb F:\\
"""

import argparse
import hashlib
import os
import subprocess
import urllib.request
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
LUA_PATH = ROOT_DIR / "dist" / "kobo_overlay" / ".adds" / "tools" / "webfiles.lua"


def deploy_usb(drive: Path, lua_bytes: bytes, local_sha: str) -> bool:
    if not (drive / ".kobo" / "version").exists():
        return False
    dst = drive / ".adds" / "tools" / "webfiles.lua"
    dst.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(dst), os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_BINARY", 0))
    try:
        pos = 0
        while pos < len(lua_bytes):
            pos += os.write(fd, lua_bytes[pos:])
        os.fsync(fd)
    finally:
        os.close(fd)
    assert hashlib.sha256(dst.read_bytes()).hexdigest() == local_sha
    print(f"[DEPLOYED VIA USB {drive}] {len(lua_bytes):,} bytes (SHA256={local_sha[:16]}...)")
    return True


def discover_kobo_ip(preferred_host: str | None) -> str:
    candidates: list[str] = []
    if preferred_host:
        candidates.append(preferred_host)
    try:
        r = subprocess.run(["arp", "-a"], capture_output=True, text=True, timeout=4)
        for line in r.stdout.splitlines():
            # Common Kobo / Netronix OUI prefixes (58:b0:d4, e8:ab:fa, 00:0b:6c, etc.)
            parts = line.split()
            if len(parts) >= 2 and parts[0][0].isdigit():
                if any(oui in line.lower() for oui in ("58-b0-d4", "58:b0:d4", "e8-ab-fa", "e8:ab:fa")):
                    if parts[0] not in candidates:
                        candidates.append(parts[0])
    except Exception:
        pass

    for ip in candidates:
        try:
            with urllib.request.urlopen(f"http://{ip}:8080/api/list?dir=/.adds/tools", timeout=2.5) as resp:
                if resp.status == 200:
                    return ip
        except Exception:
            pass
    return ""


def main() -> None:
    parser = argparse.ArgumentParser(description="Deploy Kobo Wireless Studio over Wi-Fi or USB.")
    parser.add_argument("--host", default=os.environ.get("KOBO_HOST", ""), help="Kobo LAN IP (e.g. 192.168.1.188)")
    parser.add_argument("--usb", default="", help="Optional mounted Kobo USB drive (e.g. F:\\)")
    args = parser.parse_args()

    lua_bytes = LUA_PATH.read_bytes()
    local_sha = hashlib.sha256(lua_bytes).hexdigest()

    if args.usb and deploy_usb(Path(args.usb), lua_bytes, local_sha):
        return

    ip = discover_kobo_ip(args.host or None)
    if not ip:
        raise SystemExit(
            "[OFFLINE] Could not reach Kobo Web Studio on port 8080. "
            "Turn on Wi-Fi + 'Chép sách Wi-Fi (Bật/Tắt)' on Kobo and pass --host <IP>."
        )

    req = urllib.request.Request(
        f"http://{ip}:8080/api/upload?dir=/.adds/tools&name=webfiles.lua",
        data=lua_bytes,
        method="POST",
        headers={
            "Content-Type": "application/octet-stream",
            "Content-Length": str(len(lua_bytes)),
        },
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        print(f"[UPLOADED TO http://{ip}:8080] HTTP {r.status}: {r.read().decode('utf-8')}")

    with urllib.request.urlopen(f"http://{ip}:8080/api/download?path=/.adds/tools/webfiles.lua", timeout=10) as r:
        remote_bytes = r.read()

    remote_sha = hashlib.sha256(remote_bytes).hexdigest()
    assert remote_sha == local_sha, f"SHA-256 mismatch: {remote_sha} != {local_sha}"
    print(f"[VERIFIED 100%] Live SHA-256 matches on Kobo ({len(remote_bytes):,} bytes): {remote_sha}")

    try:
        rel_req = urllib.request.Request(f"http://{ip}:8080/api/reload", data=b"", method="POST")
        with urllib.request.urlopen(rel_req, timeout=5) as rr:
            print(f"[HOT-RELOADED IN RAM] {rr.read().decode('utf-8')}")
    except Exception:
        print("[NOTE] Restart 'Chép sách Wi-Fi (Bật/Tắt)' once on Kobo to load the new server.")


if __name__ == "__main__":
    main()
