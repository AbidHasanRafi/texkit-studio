"""Find out, before compiling, what a project needs beyond the built-in engine.

Tectonic runs no external programs and has a fixed set of packages. Some documents can't compile
there however it's configured: minted runs Pygments, svg runs Inkscape, an index needs makeindex,
PSTricks needs PostScript tools. This module reads the project's .tex/.cls/.sty files for those
signs, so the compile service can use an installed TeX distribution for them (see
engine/system_tex.py) and, when there isn't one, say what is missing instead of failing mysteriously.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path

from ..core.safefs import is_hidden

MAX_FILES = 300
MAX_BYTES = 1_000_000
_PACKAGE = re.compile(r"\\(?:usepackage|RequirePackage)\s*(?:\[(?P<opts>[^\]]*)\])?\s*\{(?P<names>[^}]*)\}")
_CLASS = re.compile(r"\\(?:documentclass|LoadClass)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}")
_MAGIC_ENGINE = re.compile(r"^%\s*!\s*TeX\s+(?:TS-)?program\s*=\s*(\w+)", re.I | re.M)


@dataclass
class Scan:
    packages: set[str] = field(default_factory=set)
    options: dict[str, str] = field(default_factory=dict)  # package -> its option string
    text: str = ""  # all source, comments removed
    magic_engine: str | None = None  # from "% !TEX program = xelatex"


@dataclass
class Need:
    key: str
    summary: str  # what the document uses
    consequence: str  # what goes wrong in the built-in engine
    shell_escape: bool = False  # the system engine must also be allowed to run programs


def _strip_comments(text: str) -> str:
    return re.sub(r"(?<!\\)%.*", "", text)


def _read(path: Path) -> str | None:
    try:
        return path.read_bytes()[:MAX_BYTES].decode("utf-8", errors="replace")
    except OSError:
        return None


def scan(folder: Path) -> Scan:
    """Read every .tex file, plus the project's own .cls/.sty files that are actually loaded.

    A folder can hold library files nobody loads (tcolorbox ships a minted library, for example);
    those must not count. So local classes and packages are followed from the names the documents use.
    """
    result = Scan()
    texts: list[str] = []
    local: dict[str, list[Path]] = {}  # file name without extension -> project .cls/.sty files
    seen = 0
    for dirpath, dirnames, filenames in os.walk(folder):
        dirnames[:] = [d for d in dirnames if not is_hidden(d)]
        for name in filenames:
            lower = name.lower()
            if not lower.endswith((".tex", ".cls", ".sty")):
                continue
            seen += 1
            if seen > MAX_FILES:
                break
            path = Path(dirpath) / name
            if lower.endswith(".tex"):
                raw = _read(path)
                if raw is None:
                    continue
                if not result.magic_engine:
                    m = _MAGIC_ENGINE.search(raw[:3000])
                    if m:
                        result.magic_engine = m.group(1).lower()
                texts.append(_strip_comments(raw))
            else:
                local.setdefault(path.stem, []).append(path)

    pending = list(texts)
    visited: set[str] = set()
    all_text = list(texts)
    while pending:
        text = pending.pop()
        names: list[str] = []
        for m in _PACKAGE.finditer(text):
            for pkg in (p.strip() for p in m.group("names").split(",")):
                if pkg:
                    names.append(pkg)
                    if m.group("opts"):
                        result.options[pkg] = result.options.get(pkg, "") + "," + m.group("opts")
        names += [n.strip() for m in _CLASS.finditer(text) for n in m.group(1).split(",") if n.strip()]
        for name in names:
            result.packages.add(name)
            stem = name.replace("\\", "/").rsplit("/", 1)[-1]
            stem = stem[:-4] if stem.lower().endswith((".sty", ".cls")) else stem
            if stem in visited:
                continue
            visited.add(stem)
            for path in local.get(stem, []):
                raw = _read(path)
                if raw is not None:
                    stripped = _strip_comments(raw)
                    all_text.append(stripped)
                    pending.append(stripped)
    result.text = "\n".join(all_text)
    return result


def detect(s: Scan) -> list[Need]:
    """What this project needs that the built-in engine can't provide."""
    needs: list[Need] = []
    pk, text = s.packages, s.text

    def add(key: str, summary: str, consequence: str, shell: bool = False) -> None:
        needs.append(Need(key, summary, consequence, shell))

    if "minted" in pk:
        add("minted", "minted (highlighted code)", "it can't run Pygments, so the document stops with an error", True)
    if "svg" in pk or "\\includesvg" in text:
        add("svg", "the svg package (\\includesvg)", "it can't run Inkscape, so the images are missing and the document stops", True)
    if any(p in pk for p in ("pythontex", "sagetex", "gnuplottex", "dot2texi", "pst-pdf", "auto-pst-pdf", "pstool")):
        add("external", "a package that runs an external program (pythontex, sagetex, gnuplottex, ...)",
            "those programs can't run in the built-in engine", True)
    if any(p == "pstricks" or p.startswith("pst-") for p in pk):
        add("pstricks", "PSTricks drawings", "the built-in engine has no PSTricks, so the drawings fail")
    if "\\tikzexternalize" in text:
        add("tikzexternal", "TikZ externalization", "it runs programs to cache figures, which the built-in engine doesn't allow", True)
    if "\\write18" in text:
        add("write18", "\\write18 (shell commands)", "documents can't run programs in the built-in engine", True)
    if re.search(r"\\(?:makeindex|printindex)\b", text):
        add("index", "an index (\\printindex)", "makeindex doesn't run, so the index comes out empty")
    if re.search(r"\\(?:makeglossaries|printglossar(?:y|ies))\b", text):
        add("glossary", "a glossary (\\printglossaries)", "makeglossaries doesn't run, so the glossary comes out empty")
    if re.search(r"\\(?:makenomenclature|printnomenclature)\b", text):
        add("nomencl", "a nomenclature list", "makeindex doesn't run, so the list comes out empty")
    if "biblatex-apa" in pk or re.search(r"\bstyle\s*=\s*apa\b", s.options.get("biblatex", "")):
        add("biber", "biblatex with the apa style", "it needs Biber, which the built-in engine can't run")
    return needs


def pick_engine(s: Scan) -> str:
    """Which TeX engine an installed distribution should use: pdflatex, xelatex or lualatex."""
    if s.magic_engine in ("pdflatex", "xelatex", "lualatex"):
        return s.magic_engine
    if {"luacode", "luatexja", "luatextra", "lualatex-math"} & s.packages or "\\directlua" in s.text:
        return "lualatex"
    if {"fontspec", "unicode-math", "xeCJK", "ctex", "polyglossia", "xltxtra", "mathspec"} & s.packages:
        return "xelatex"
    return "pdflatex"
