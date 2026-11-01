"""Locate, download and run the Tectonic engine.

Lookup order: $TEXKIT_TECTONIC, a binary bundled in the wheel (platform wheels),
a previously downloaded copy in the user data folder, then `tectonic` on PATH.
If none is found, `ensure()` downloads the pinned release and verifies its SHA-256.
"""

from __future__ import annotations

import hashlib
import io
import os
import platform
import shutil
import stat
import subprocess
import sys
import tarfile
import urllib.request
import zipfile
from pathlib import Path
from typing import Callable

from ..config import ENGINE_DIR

VERSION = "0.17.0"
_BASE = f"https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40{VERSION}/"

# (os, machine) -> (asset name, sha256)
ASSETS: dict[tuple[str, str], tuple[str, str]] = {
    ("windows", "x86_64"): (
        f"tectonic-{VERSION}-x86_64-pc-windows-msvc.zip",
        "f61ce51f0b0ade1015b7de7ef368541c5424e9756ecbd0d7af97d6d48030845f",
    ),
    ("darwin", "arm64"): (
        f"tectonic-{VERSION}-aarch64-apple-darwin.tar.gz",
        "a3f1cac7c5678f01661a92212f58480ae3b0634115d880dbc59e2953ded45667",
    ),
    ("darwin", "x86_64"): (
        f"tectonic-{VERSION}-x86_64-apple-darwin.tar.gz",
        "7c90ef5b6ddb1eb1937e4337add5237b79338e4b9676459fa91187d24d6cdf80",
    ),
    ("linux", "x86_64"): (
        f"tectonic-{VERSION}-x86_64-unknown-linux-musl.tar.gz",
        "8533d07f9ccbd7a65824b9e0459041bca34af1eb33daba48f59215593753a3b7",
    ),
    ("linux", "arm64"): (
        f"tectonic-{VERSION}-aarch64-unknown-linux-musl.tar.gz",
        "b10954a95404f3ab2328d2fa59a5ebab8e657f893fab096f98be8db7c0c979b8",
    ),
}

EXE = "tectonic.exe" if os.name == "nt" else "tectonic"
BUNDLED = Path(__file__).resolve().parent.parent / "bin" / EXE
DOWNLOADED = ENGINE_DIR / f"tectonic-{VERSION}" / EXE


class EngineError(RuntimeError):
    pass


def platform_key() -> tuple[str, str]:
    system = {"win32": "windows", "darwin": "darwin"}.get(sys.platform, "linux")
    machine = platform.machine().lower()
    machine = {"amd64": "x86_64", "x64": "x86_64", "aarch64": "arm64"}.get(machine, machine)
    if system == "windows" and machine == "arm64":
        machine = "x86_64"  # runs under emulation
    return system, machine


def find() -> Path | None:
    env = os.environ.get("TEXKIT_TECTONIC")
    candidates = [Path(env)] if env else []
    candidates += [BUNDLED, DOWNLOADED]
    for path in candidates:
        if path.is_file():
            return path
    on_path = shutil.which("tectonic")
    return Path(on_path) if on_path else None


def version(path: Path) -> str | None:
    try:
        out = subprocess.run(
            [str(path), "--version"], capture_output=True, text=True, timeout=20, **_no_window()
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return out.stdout.strip().split()[-1] if out.returncode == 0 and out.stdout.strip() else None


def ensure(progress: Callable[[int, int], None] | None = None) -> Path:
    """Return a usable Tectonic binary, downloading the pinned release if needed."""
    found = find()
    if found:
        return found
    key = platform_key()
    if key not in ASSETS:
        raise EngineError(
            f"No prebuilt LaTeX engine for {key[0]}/{key[1]}. "
            "Install Tectonic yourself (https://tectonic-typesetting.github.io) and make sure it's on PATH."
        )
    binary = fetch_binary(key, progress)
    DOWNLOADED.parent.mkdir(parents=True, exist_ok=True)
    tmp = DOWNLOADED.with_suffix(".part")
    tmp.write_bytes(binary)
    tmp.chmod(tmp.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    os.replace(tmp, DOWNLOADED)
    return DOWNLOADED


def fetch_binary(key: tuple[str, str], progress: Callable[[int, int], None] | None = None) -> bytes:
    """Download the pinned release for `key`, verify its SHA-256, and return the executable's bytes.
    Also used by scripts/build_wheels.py to bundle the engine into platform wheels."""
    name, sha256 = ASSETS[key]
    exe = "tectonic.exe" if key[0] == "windows" else "tectonic"
    try:
        with urllib.request.urlopen(_BASE + name, timeout=60) as resp:
            total = int(resp.headers.get("Content-Length") or 0)
            buf = io.BytesIO()
            while chunk := resp.read(256 * 1024):
                buf.write(chunk)
                if progress:
                    progress(buf.tell(), total)
    except OSError as exc:
        raise EngineError(
            "Couldn't download the LaTeX engine. Check your internet connection and try again "
            f"(this is needed once). Details: {exc}"
        ) from exc
    data = buf.getvalue()
    if hashlib.sha256(data).hexdigest() != sha256:
        raise EngineError("The downloaded LaTeX engine failed its checksum test, so it wasn't installed.")
    if name.endswith(".zip"):
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            member = next(n for n in zf.namelist() if n.rsplit("/", 1)[-1] == exe)
            return zf.read(member)
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tf:
        member = next(m for m in tf.getmembers() if m.name.rsplit("/", 1)[-1] == exe)
        return tf.extractfile(member).read()


def command(exe: Path, main: Path, outdir: Path, *, only_cached: bool = False) -> list[str]:
    cmd = [
        str(exe),
        "--synctex",
        "--keep-logs",
        "--keep-intermediates",
        "--untrusted",
        "--outdir",
        str(outdir),
    ]
    if only_cached:
        cmd.append("--only-cached")
    cmd.append(str(main))
    return cmd


def _no_window() -> dict:
    """Keep Windows from flashing a console window for each subprocess."""
    if os.name == "nt":
        return {"creationflags": subprocess.CREATE_NO_WINDOW}
    return {}


no_window = _no_window
