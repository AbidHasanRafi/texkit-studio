"""Safe file access inside the current folder: path confinement, atomic writes, hashes."""

from __future__ import annotations

import hashlib
import os
import tempfile
from pathlib import Path, PurePosixPath

TEXT_EXTENSIONS = {
    ".tex", ".bib", ".sty", ".cls", ".bst", ".bbx", ".cbx", ".lbx", ".dtx", ".ins", ".ltx", ".cfg",
    ".def", ".clo", ".fd", ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".yaml", ".yml",
    ".xml", ".tikz", ".pgf", ".py", ".r", ".m", ".sh", ".bat", ".ps1", ".gitignore", ".latexmkrc",
    ".rst", ".org", ".dat", ".log", ".toml", ".ini", ".html", ".css", ".js",
}
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".bmp", ".eps", ".tif", ".tiff"}
HIDDEN_NAMES = {".git", ".texkit", ".svn", ".hg", "__pycache__", ".DS_Store", "Thumbs.db", "desktop.ini", ".venv", "node_modules"}
MAX_TEXT_BYTES = 5 * 1024 * 1024


class PathError(ValueError):
    pass


def resolve_in(root: Path, rel: str) -> Path:
    """Resolve a project-relative POSIX path and refuse anything outside `root`."""
    rel = (rel or "").replace("\\", "/").strip()
    pure = PurePosixPath(rel)
    if pure.is_absolute() or (pure.parts and ":" in pure.parts[0]) or ".." in pure.parts:
        raise PathError(f"Path must stay inside the folder: {rel}")
    target = (root / pure).resolve()
    if target != root and root not in target.parents:
        raise PathError(f"Path must stay inside the folder: {rel}")
    return target


def to_rel(root: Path, path: Path) -> str:
    return path.resolve().relative_to(root).as_posix()


def content_hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:20]


def atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".~", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        if path.exists():
            try:
                os.chmod(tmp, path.stat().st_mode)
            except OSError:
                pass
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def file_kind(path: Path) -> str:
    ext = path.suffix.lower()
    if ext == ".tex":
        return "tex"
    if ext == ".bib":
        return "bib"
    if ext == ".pdf":
        return "pdf"
    if ext in IMAGE_EXTENSIONS:
        return "image"
    if ext in TEXT_EXTENSIONS or path.name in TEXT_EXTENSIONS:
        return "text"
    try:
        with path.open("rb") as fh:
            head = fh.read(4096)
        if b"\0" not in head:
            head.decode("utf-8")
            return "text"
    except (OSError, UnicodeDecodeError):
        pass
    return "binary"


def is_hidden(name: str) -> bool:
    return name in HIDDEN_NAMES or name.startswith(".~") or (name.startswith(".") and name not in {".latexmkrc"})
