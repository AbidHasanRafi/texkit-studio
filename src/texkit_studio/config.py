"""User-level paths and small persistent settings (recent folders, running instance)."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

from platformdirs import user_cache_path, user_data_path

from ._meta import APP_DIR_NAME

DATA_DIR = Path(os.environ.get("TEXKIT_DATA_DIR") or user_data_path(APP_DIR_NAME, appauthor=False))
CACHE_DIR = Path(os.environ.get("TEXKIT_CACHE_DIR") or user_cache_path(APP_DIR_NAME, appauthor=False))

RECENT_FILE = DATA_DIR / "recent.json"
INSTANCE_FILE = DATA_DIR / "instance.json"
ENGINE_DIR = DATA_DIR / "engine"
MAX_RECENT = 10


def build_dir(root: Path) -> Path:
    """Build output lives in the cache, keyed by folder, so project folders stay clean."""
    key = hashlib.sha256(str(root).lower().encode() if os.name == "nt" else str(root).encode()).hexdigest()[:16]
    return CACHE_DIR / "builds" / key


def _read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def _write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def recent_folders() -> list[str]:
    items = _read_json(RECENT_FILE, [])
    return [p for p in items if isinstance(p, str) and Path(p).is_dir()][:MAX_RECENT]


def add_recent(folder: Path) -> None:
    folder_s = str(folder)
    items = [p for p in recent_folders() if p != folder_s]
    _write_json(RECENT_FILE, [folder_s, *items][:MAX_RECENT])


def read_instance() -> dict | None:
    data = _read_json(INSTANCE_FILE, None)
    return data if isinstance(data, dict) else None


def write_instance(port: int, token: str) -> None:
    _write_json(INSTANCE_FILE, {"pid": os.getpid(), "port": port, "token": token})
    try:
        os.chmod(INSTANCE_FILE, 0o600)
    except OSError:
        pass


def clear_instance() -> None:
    data = read_instance()
    if data and data.get("pid") == os.getpid():
        INSTANCE_FILE.unlink(missing_ok=True)
