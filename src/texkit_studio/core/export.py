"""The Download menu: project ZIP and Word (.docx) via Pandoc. (PDF is the build output.)"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import zipfile
from functools import lru_cache
from pathlib import Path

from ..engine.tectonic import no_window
from .safefs import is_hidden

# Font selection only matters for the PDF, and Pandoc's TeX reader can't follow the \if...\fi chains people
# use to pick a font, so those lines are blanked (not deleted, so error line numbers still match the source).
_FONT_SETUP = re.compile(
    r"\\(?:IfFontExistsTF|IfFontExists|newfontfamily|setmainfont|setsansfont|setmonofont|setmathfont|"
    r"setCJK\w*font|babelfont|defaultfontfeatures)\b"
)
_NEWIF = re.compile(r"^\s*\\newif\s*\\if(\w+)")
_BIB = re.compile(r"\\(?:bibliography|addbibresource)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}")


class ExportError(RuntimeError):
    pass


def zip_project(root: Path, out: Path) -> Path:
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".part")
    with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if not is_hidden(d)]
            for name in filenames:
                if is_hidden(name):
                    continue
                path = Path(dirpath) / name
                zf.write(path, path.relative_to(root).as_posix())
    os.replace(tmp, out)
    return out


@lru_cache(maxsize=1)
def pandoc_path() -> str | None:
    found = shutil.which("pandoc")
    if found:
        return found
    try:
        import pypandoc  # provided by pypandoc-binary, which bundles pandoc

        return pypandoc.get_pandoc_path()
    except Exception:
        return None


def _for_pandoc(text: str) -> str:
    """Blank font-setup lines, and the \\newif flags only those lines used, so Pandoc doesn't choke on them."""
    lines = text.split("\n")
    drop = {i for i, ln in enumerate(lines) if _FONT_SETUP.search(ln.split("%", 1)[0])}
    flags = {m.group(1) for i in drop for m in re.finditer(r"\\if(\w+)", lines[i])}
    for i, ln in enumerate(lines):
        m = _NEWIF.match(ln)
        if m and m.group(1) in flags:
            drop.add(i)
    return "\n".join("" if i in drop else ln for i, ln in enumerate(lines))


def to_docx(root: Path, main_rel: str, out: Path) -> tuple[Path, list[str]]:
    pandoc = pandoc_path()
    if not pandoc:
        raise ExportError("Word export needs Pandoc, which couldn't be found. Reinstall texkit-studio, or install Pandoc.")
    main = root / main_rel
    text = main.read_text(encoding="utf-8", errors="replace")
    bibs: list[Path] = []
    for group in _BIB.findall(text):
        for name in group.split(","):
            name = name.strip()
            for cand in (main.parent / name, main.parent / f"{name}.bib", root / name, root / f"{name}.bib"):
                if cand.is_file() and cand.suffix == ".bib":
                    bibs.append(cand)
                    break
    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = [pandoc, "--from", "latex", "--to", "docx", "--output", str(out),
           "--resource-path", os.pathsep.join([str(main.parent), str(root)])]
    for bib in bibs:
        cmd += ["--citeproc", "--bibliography", str(bib)]
    try:
        proc = subprocess.run(cmd, cwd=main.parent, input=_for_pandoc(text), capture_output=True, text=True,
                              encoding="utf-8", errors="replace", timeout=180, **no_window())
    except subprocess.TimeoutExpired as exc:
        raise ExportError("Word conversion took too long and was stopped.") from exc
    if proc.returncode != 0 or not out.is_file():
        lines = [ln.strip() for ln in (proc.stderr or proc.stdout).splitlines() if ln.strip() and ln.strip() != "^"]
        detail = " ".join(lines[:4])  # keep the leading "Error at <file> (line, column)" so the problem can be found
        hint = " Usually a missing closing brace or \\end{...} near that line." if "unexpected end of input" in detail else ""
        raise ExportError(f"Pandoc couldn't convert this document to Word. {detail}{hint}")
    warnings = [line for line in proc.stderr.splitlines() if line.strip()]
    return out, warnings
