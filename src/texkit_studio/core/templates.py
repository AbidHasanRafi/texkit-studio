"""Built-in starter templates (src/texkit_studio/templates/<id>/)."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

TEMPLATES_DIR = Path(__file__).resolve().parent.parent / "templates"


def list_templates() -> list[dict]:
    out = []
    for folder in sorted(TEMPLATES_DIR.iterdir()):
        meta_file = folder / "template.json"
        if not meta_file.is_file():
            continue
        meta = json.loads(meta_file.read_text(encoding="utf-8"))
        out.append({"id": folder.name, **meta})
    out.sort(key=lambda t: t.get("order", 99))
    return out


def apply(template_id: str, dest: Path) -> str:
    """Copy a template's files into `dest`. Never overwrites existing files. Returns the main file."""
    folder = TEMPLATES_DIR / template_id
    meta_file = folder / "template.json"
    if "/" in template_id or "\\" in template_id or not meta_file.is_file():
        raise FileNotFoundError(f"Unknown template: {template_id}")
    meta = json.loads(meta_file.read_text(encoding="utf-8"))
    files = folder / "files"
    clashes = [p.relative_to(files).as_posix() for p in files.rglob("*") if p.is_file() and (dest / p.relative_to(files)).exists()]
    if clashes:
        raise FileExistsError(f"These files already exist here: {', '.join(clashes[:5])}")
    dest.mkdir(parents=True, exist_ok=True)
    shutil.copytree(files, dest, dirs_exist_ok=True)
    return meta.get("mainFile", "main.tex")
