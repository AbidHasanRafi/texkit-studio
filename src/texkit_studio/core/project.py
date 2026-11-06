"""The folder-as-project model: file tree, main-file detection, per-project settings."""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

from .._meta import PROJECT_DIR
from .safefs import atomic_write, file_kind, is_hidden

MAX_TREE_ENTRIES = 5000
_DOCCLASS = re.compile(r"^[^%\n]*\\documentclass", re.M)
_BEGIN_DOC = re.compile(r"^[^%\n]*\\begin\{document\}", re.M)
_MAGIC_ROOT = re.compile(r"^%\s*!\s*TeX\s+root\s*=\s*(.+?)\s*$", re.I | re.M)


def settings_path(root: Path) -> Path:
    return root / PROJECT_DIR / "project.json"


def load_settings(root: Path) -> dict:
    try:
        data = json.loads(settings_path(root).read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_settings(root: Path, settings: dict) -> None:
    data = {"version": 1, **settings}
    atomic_write(settings_path(root), (json.dumps(data, indent=2) + "\n").encode())


def tree(root: Path) -> list[dict]:
    count = 0

    def walk(folder: Path) -> list[dict]:
        nonlocal count
        try:
            entries = list(os.scandir(folder))
        except OSError:
            return []
        dirs, files = [], []
        for e in entries:
            if is_hidden(e.name):
                continue
            count += 1
            if count > MAX_TREE_ENTRIES:
                break
            rel = Path(e.path).relative_to(root).as_posix()
            try:
                if e.is_dir(follow_symlinks=False):
                    dirs.append({"name": e.name, "path": rel, "type": "dir", "children": walk(Path(e.path))})
                elif e.is_file():
                    p = Path(e.path)
                    files.append({"name": e.name, "path": rel, "type": "file", "kind": file_kind(p), "size": e.stat().st_size})
            except OSError:
                continue
        key = lambda n: n["name"].lower()  # noqa: E731
        return sorted(dirs, key=key) + sorted(files, key=key)

    return walk(root)


def tex_files(root: Path, max_depth: int = 4) -> list[str]:
    found = []
    for dirpath, dirnames, filenames in os.walk(root):
        depth = len(Path(dirpath).relative_to(root).parts)
        dirnames[:] = [d for d in dirnames if not is_hidden(d) and depth < max_depth]
        for name in filenames:
            if name.lower().endswith(".tex"):
                found.append((Path(dirpath) / name).relative_to(root).as_posix())
    return sorted(found, key=lambda p: (p.count("/"), p.lower()))


def is_document(path: Path) -> bool:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")[:200_000]
    except OSError:
        return False
    return bool(_DOCCLASS.search(text) and _BEGIN_DOC.search(text))


def main_candidates(root: Path) -> list[str]:
    return [rel for rel in tex_files(root) if is_document(root / rel)][:50]


def main_info(root: Path) -> dict:
    """The main file and how it was chosen.

    source is "chosen" (the user set it), "main.tex" (a complete main.tex exists) or "auto" (the first
    complete document: fewest folders deep, then alphabetical). `candidates` lists every complete
    document, so the UI can tell when the automatic pick was a guess.
    """
    configured = load_settings(root).get("mainFile")
    if isinstance(configured, str) and (root / configured).is_file():
        return {"file": configured, "source": "chosen", "candidates": [configured]}
    candidates = main_candidates(root)
    if (root / "main.tex").is_file() and is_document(root / "main.tex"):
        return {"file": "main.tex", "source": "main.tex", "candidates": candidates}
    return {"file": candidates[0] if candidates else None, "source": "auto" if candidates else None, "candidates": candidates}


def detect_main(root: Path) -> str | None:
    configured = load_settings(root).get("mainFile")
    if isinstance(configured, str) and (root / configured).is_file():
        return configured
    if (root / "main.tex").is_file() and is_document(root / "main.tex"):
        return "main.tex"
    candidates = main_candidates(root)
    return candidates[0] if candidates else None


def magic_root(root: Path, active_rel: str | None) -> str | None:
    """Honour `% !TEX root = ../main.tex` in the file being edited."""
    if not active_rel:
        return None
    active = root / active_rel
    try:
        head = active.read_text(encoding="utf-8", errors="replace")[:4000]
    except OSError:
        return None
    m = _MAGIC_ROOT.search(head)
    if not m:
        return None
    target = (active.parent / m.group(1).strip()).resolve()
    if target.is_file() and root in target.parents:
        return target.relative_to(root).as_posix()
    return None
