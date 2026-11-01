"""Automatic snapshots of a project's text files, so nothing is ever really lost.

A snapshot is taken after each successful compile (only when something changed) and
before any restore. File contents are stored once by hash, so snapshots are cheap.
History lives in the user data folder, not the project, so it never clutters Git.
"""

from __future__ import annotations

import difflib
import hashlib
import json
import os
import time
from pathlib import Path

from ..config import DATA_DIR
from .safefs import atomic_write, is_hidden

TEXT_SUFFIXES = {".tex", ".bib", ".sty", ".cls", ".bst", ".txt", ".md", ".cfg", ".tikz", ".csv"}
MAX_SNAPSHOTS = 100
MAX_FILE_BYTES = 2 * 1024 * 1024


def _dir(root: Path) -> Path:
    key = hashlib.sha256(str(root).lower().encode() if os.name == "nt" else str(root).encode()).hexdigest()[:16]
    return DATA_DIR / "history" / key


def _index(root: Path) -> list[dict]:
    try:
        return json.loads((_dir(root) / "index.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []


def _save_index(root: Path, items: list[dict]) -> None:
    atomic_write(_dir(root) / "index.json", json.dumps(items).encode())


def _current_files(root: Path) -> dict[str, bytes]:
    files = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not is_hidden(d)]
        for name in filenames:
            p = Path(dirpath) / name
            if p.suffix.lower() in TEXT_SUFFIXES and not is_hidden(name):
                try:
                    if p.stat().st_size <= MAX_FILE_BYTES:
                        files[p.relative_to(root).as_posix()] = p.read_bytes()
                except OSError:
                    continue
    return files


def snapshot(root: Path, reason: str = "compile") -> dict | None:
    """Record the current text files. Returns the new snapshot, or None if nothing changed."""
    root = root.resolve()
    items = _index(root)
    files = _current_files(root)
    blobs = _dir(root) / "blobs"
    blobs.mkdir(parents=True, exist_ok=True)
    manifest = {}
    for rel, data in files.items():
        h = hashlib.sha256(data).hexdigest()
        blob = blobs / h
        if not blob.exists():
            blob.write_bytes(data)
        manifest[rel] = h
    if items and items[-1]["files"] == manifest:
        return None
    prev = items[-1]["files"] if items else {}
    changed = sorted(p for p in set(manifest) | set(prev) if manifest.get(p) != prev.get(p))
    snap = {"id": f"{int(time.time() * 1000)}", "time": time.time(), "reason": reason, "files": manifest, "changed": changed}
    items.append(snap)
    if len(items) > MAX_SNAPSHOTS:
        items = items[-MAX_SNAPSHOTS:]
        live = {h for s in items for h in s["files"].values()}
        for blob in blobs.iterdir():
            if blob.name not in live:
                blob.unlink(missing_ok=True)
    _save_index(root, items)
    return snap


def list_snapshots(root: Path) -> list[dict]:
    items = _index(root.resolve())
    return [{"id": s["id"], "time": s["time"], "reason": s["reason"], "changed": s["changed"], "count": len(s["files"])}
            for s in reversed(items)]


def _blob(root: Path, snap_id: str, rel: str) -> str | None:
    for s in _index(root):
        if s["id"] == snap_id:
            h = s["files"].get(rel)
            if not h:
                return None
            return (_dir(root) / "blobs" / h).read_bytes().decode("utf-8", errors="replace")
    raise FileNotFoundError(f"No snapshot {snap_id}")


def diff(root: Path, snap_id: str, rel: str) -> dict:
    """Compare a file in a snapshot with the file as it is now."""
    root = root.resolve()
    old = _blob(root, snap_id, rel)
    p = root / rel
    new = p.read_text(encoding="utf-8", errors="replace") if p.is_file() else None
    a = (old or "").splitlines()
    b = (new or "").splitlines()
    rows = []
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(a=a, b=b, autojunk=False).get_opcodes():
        if tag == "equal":
            span = a[i1:i2]
            if len(span) > 6:  # keep a little context around changes
                rows += [{"t": "=", "a": i1 + k + 1, "text": s} for k, s in enumerate(span[:3])]
                rows.append({"t": "…", "text": f"{len(span) - 6} unchanged lines"})
                rows += [{"t": "=", "a": i2 - 3 + k + 1, "text": s} for k, s in enumerate(span[-3:])]
            else:
                rows += [{"t": "=", "a": i1 + k + 1, "text": s} for k, s in enumerate(span)]
        else:
            rows += [{"t": "-", "a": i1 + k + 1, "text": s} for k, s in enumerate(a[i1:i2])]
            rows += [{"t": "+", "b": j1 + k + 1, "text": s} for k, s in enumerate(b[j1:j2])]
    return {"path": rel, "existsThen": old is not None, "existsNow": new is not None, "rows": rows,
            "same": old == new}


def restore(root: Path, snap_id: str, rel: str) -> None:
    root = root.resolve()
    old = _blob(root, snap_id, rel)
    if old is None:
        raise FileNotFoundError(f"{rel} didn't exist in that snapshot")
    snapshot(root, reason="before restore")
    for s in _index(root):
        if s["id"] == snap_id:
            atomic_write(root / rel, (_dir(root) / "blobs" / s["files"][rel]).read_bytes())
            return
