"""Compile with a TeX distribution installed on this computer (TeX Live, MiKTeX, MacTeX, TinyTeX).

TexKit Studio's own engine, Tectonic, is small and needs nothing installed, but it can't run external
programs, has no Biber or makeindex, and ships a fixed (older) set of packages. When a document needs
more, and a full distribution is installed, we use that instead, with the same build folder and the
same SyncTeX, log and PDF outputs, so the rest of the app can't tell the difference.

We drive the engine ourselves (engine, BibTeX or Biber, makeindex, re-run until references settle)
rather than through latexmk, which needs Perl and isn't present on every Windows installation.
"""

from __future__ import annotations

import glob
import os
import re
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

ENGINES = ("pdflatex", "xelatex", "lualatex")
MAX_PASSES = 5
# Tools run from the project folder write into the build folder, which TeX's default
# "paranoid" file policy refuses; the build folder is ours, so allow it.
TOOL_ENV = {"openout_any": "a", "openin_any": "a"}
_RERUN = re.compile(r"Rerun to get|Label\(s\) may have changed|Please \(re\)run|Rerun LaTeX")
_FILE_LINE = re.compile(r"^(?:\./)?(?P<file>[^\s:][^:]*\.(?:tex|sty|cls|clo|def|cfg|bbl|aux|bib)):(?P<line>\d+): (?P<msg>.+)$")

Stream = Callable[[list[str], Path, "dict[str, str] | None"], None]


@dataclass
class Toolchain:
    tools: dict[str, str] = field(default_factory=dict)  # name -> executable path

    def tool(self, name: str) -> str | None:
        return self.tools.get(name)


def _search_dirs() -> list[str]:
    dirs: list[str] = []
    env = os.environ.get("TEXKIT_TEXBIN")
    if env:
        dirs.append(env)
    home = Path.home()
    if os.name == "nt":
        local = os.environ.get("LOCALAPPDATA", "")
        for base in (os.environ.get("ProgramFiles", ""), os.environ.get("ProgramW6432", ""), os.environ.get("ProgramFiles(x86)", "")):
            if base:
                dirs += [str(Path(base) / "MiKTeX" / "miktex" / "bin" / "x64")]
        dirs += [str(Path(local) / "Programs" / "MiKTeX" / "miktex" / "bin" / "x64"),
                 str(Path(os.environ.get("APPDATA", "")) / "TinyTeX" / "bin" / "windows")]
        for pattern in ("C:/texlive/*/bin/windows", "C:/texlive/*/bin/win64"):
            dirs += sorted(glob.glob(pattern), reverse=True)
    else:
        dirs += ["/Library/TeX/texbin", "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", str(home / ".TinyTeX" / "bin" / "x86_64-linux")]
        for pattern in ("/usr/local/texlive/*/bin/*", str(home / "Library" / "TinyTeX" / "bin" / "*")):
            dirs += sorted(glob.glob(pattern), reverse=True)
    return dirs


def find() -> Toolchain | None:
    """The installed TeX tools, or None when there's no LaTeX engine at all."""
    dirs = [d for d in _search_dirs() if d and Path(d).is_dir()]
    path = os.pathsep.join(dirs + [os.environ.get("PATH", "")])
    tools: dict[str, str] = {}
    for name in (*ENGINES, "bibtex", "biber", "makeindex", "makeglossaries"):
        found = shutil.which(name, path=path)
        if found:
            tools[name] = found
    return Toolchain(tools) if any(e in tools for e in ENGINES) else None


def choose_engine(tc: Toolchain, wanted: str) -> str | None:
    """`wanted` if installed, else any installed engine (xelatex and lualatex both run pdflatex documents)."""
    if tc.tool(wanted):
        return wanted
    order = {"pdflatex": ("xelatex", "lualatex"), "xelatex": ("lualatex", "pdflatex"), "lualatex": ("xelatex", "pdflatex")}
    return next((e for e in order[wanted] if tc.tool(e)), None)


def normalize(line: str) -> str:
    """Rewrite `./main.tex:12: Undefined control sequence.` as Tectonic would, so one parser reads both."""
    m = _FILE_LINE.match(line.strip())
    return f"error: {m['file']}:{m['line']}: {m['msg']}" if m else line


def run(tc: Toolchain, engine: str, main: Path, outdir: Path, stream: Stream, *,
        shell_escape: bool = False, auto_install: bool = False) -> None:
    """Build `main` into `outdir`: engine, bibliography, index, then re-runs until nothing changes.

    `auto_install` lets MiKTeX download missing packages. Off by default: MiKTeX would otherwise open
    a dialog asking permission, and an automated compile can't answer it.
    """
    cwd = main.parent
    stem = main.stem
    outdir.mkdir(parents=True, exist_ok=True)
    base = [tc.tools[engine], "-interaction=nonstopmode", "-file-line-error", "-synctex=1", f"-output-directory={outdir}"]
    if "miktex" in tc.tools[engine].lower():
        base.insert(1, "--enable-installer" if auto_install else "--disable-installer")
    if shell_escape:
        base.append("-shell-escape")
    base.append(main.name)
    stream(base, cwd, TOOL_ENV)
    ran_tools = _post_process(tc, outdir, stem, cwd, stream)
    passes = 1
    while passes < MAX_PASSES:
        log = outdir / f"{stem}.log"
        text = log.read_text(encoding="utf-8", errors="replace") if log.is_file() else ""
        if not (ran_tools or _RERUN.search(text)):
            break  # nothing new to pick up: references are settled
        stream(base, cwd, TOOL_ENV)
        passes += 1
        ran_tools = False


def _tool_env(project: Path) -> dict[str, str]:
    """Environment for the helper tools. They run in the build folder (several refuse to write anywhere
    else, MiKTeX's makeindex among them), so tell them where to find the project's .bib, .bst and .ist files.
    The trailing separator keeps each tool's own default search path."""
    search = f"{project}{os.pathsep}"
    return {**TOOL_ENV, "BIBINPUTS": search, "BSTINPUTS": search, "INDEXSTYLE": search, "TEXINPUTS": search}


def _post_process(tc: Toolchain, outdir: Path, stem: str, project: Path, stream: Stream) -> bool:
    """Run the bibliography, index and glossary tools the first pass asked for. True if any ran."""
    ran = False
    env = _tool_env(project)
    aux = outdir / f"{stem}.aux"
    aux_text = aux.read_text(encoding="utf-8", errors="replace") if aux.is_file() else ""
    if (outdir / f"{stem}.bcf").is_file() and tc.tool("biber"):
        stream([tc.tools["biber"], stem], outdir, env)
        ran = True
    elif "\\bibdata" in aux_text and tc.tool("bibtex"):
        stream([tc.tools["bibtex"], stem], outdir, env)
        ran = True
    idx = outdir / f"{stem}.idx"
    if idx.is_file() and idx.stat().st_size and tc.tool("makeindex"):
        stream([tc.tools["makeindex"], "-q", f"{stem}.idx"], outdir, env)
        ran = True
    if (outdir / f"{stem}.nlo").is_file() and tc.tool("makeindex"):
        stream([tc.tools["makeindex"], "-q", f"{stem}.nlo", "-s", "nomencl.ist", "-o", f"{stem}.nls"], outdir, env)
        ran = True
    if tc.tool("makeglossaries") and any((outdir / f"{stem}{ext}").is_file() for ext in (".glo", ".acn")):
        stream([tc.tools["makeglossaries"], stem], outdir, env)
        ran = True
    return ran
