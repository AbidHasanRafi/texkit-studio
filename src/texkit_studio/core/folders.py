"""Folder browsing for "Open folder…". Browsers can't hand a page a real disk path,
so the server lists directories itself."""

from __future__ import annotations

import os
import string
import subprocess
import sys
from pathlib import Path

from .. import config
from .safefs import is_hidden

_INVALID_NAME = set('<>:"/\\|?*')


def _has_tex(folder: Path) -> bool:
    try:
        with os.scandir(folder) as it:
            for i, e in enumerate(it):
                if i > 300:
                    break
                if e.name.lower().endswith(".tex"):
                    return True
    except OSError:
        pass
    return False


def browse(path: str | None) -> dict:
    folder = Path(path).expanduser() if path else Path.home()
    folder = folder.resolve()
    if not folder.is_dir():
        raise FileNotFoundError(f"Not a folder: {folder}")
    entries = []
    try:
        with os.scandir(folder) as it:
            for e in it:
                try:
                    if e.is_dir() and not is_hidden(e.name):
                        entries.append({"name": e.name, "path": e.path, "hasTex": _has_tex(Path(e.path))})
                except OSError:
                    continue
    except PermissionError:
        raise PermissionError(f"You don't have permission to open {folder}")
    entries.sort(key=lambda x: x["name"].lower())
    crumbs = [{"name": p.name or str(p), "path": str(p)} for p in reversed([folder, *folder.parents])]
    return {
        "path": str(folder),
        "name": folder.name or str(folder),
        "parent": str(folder.parent) if folder.parent != folder else None,
        "hasTex": _has_tex(folder),
        "crumbs": crumbs,
        "entries": entries,
    }


def shortcuts() -> dict:
    home = Path.home()
    places = [{"name": "Home", "path": str(home), "icon": "home"}]
    for name, icon in (("Documents", "file"), ("Desktop", "monitor"), ("Downloads", "download")):
        p = home / name
        if p.is_dir():
            places.append({"name": name, "path": str(p), "icon": icon})
    drives = []
    if os.name == "nt":
        for letter in string.ascii_uppercase:
            d = f"{letter}:\\"
            if os.path.exists(d):
                drives.append({"name": f"{letter}:", "path": d, "icon": "drive"})
    else:
        drives.append({"name": "Computer", "path": "/", "icon": "drive"})
    recent = [{"name": Path(p).name or p, "path": p, "icon": "clock"} for p in config.recent_folders()]
    return {"places": places, "drives": drives, "recent": recent}


def make_folder(parent: str, name: str) -> Path:
    name = name.strip()
    if not name or name in {".", ".."} or any(c in _INVALID_NAME for c in name):
        raise ValueError("That isn't a valid folder name.")
    target = Path(parent).expanduser().resolve() / name
    target.mkdir(parents=False, exist_ok=False)
    return target


def reveal(path: Path) -> None:
    """Show a file or folder in Explorer / Finder / the Linux file manager."""
    if os.name == "nt":
        if path.is_file():
            subprocess.Popen(["explorer", "/select,", str(path)])
        else:
            os.startfile(str(path))  # type: ignore[attr-defined]
    elif sys.platform == "darwin":
        subprocess.Popen(["open", "-R", str(path)] if path.is_file() else ["open", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(path if path.is_dir() else path.parent)])
