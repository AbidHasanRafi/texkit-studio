"""Compile the current folder: one compile at a time, newest request wins.

The built-in engine (Tectonic) goes first. A document that needs more than it can give (an index,
minted, PSTricks, a newer LaTeX kernel, ...) is built with an installed TeX distribution when there is
one, and the better of the two results is kept.
"""

from __future__ import annotations

import asyncio
import os
import re
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

from ..config import build_dir
from ..core import history, project
from ..core.project import detect_main, magic_root
from ..engine import offline as offline_mod
from ..engine import system_tex, tectonic
from ..synctex.index import SyncIndex
from . import eps, friendly, logparse, needs

if TYPE_CHECKING:
    from ..core.studio import Studio


class _Cancelled(Exception):
    """A newer compile request replaced this one."""


@dataclass
class _Attempt:
    """One try at building the document with one engine."""

    engine: str  # "tectonic", or the installed engine's name (pdflatex, xelatex, lualatex)
    run_dir: Path
    first_line: int  # where this attempt's output starts in CompileService.lines
    produced: bool = False
    cancelled: bool = False
    offline: bool = False
    log_text: str = ""
    errors: int = 0
    issues: list[logparse.Issue] = field(default_factory=list)
    eps_report: eps.EpsReport = field(default_factory=eps.EpsReport)


class CompileService:
    def __init__(self, studio: Studio) -> None:
        self.studio = studio
        self._run_lock = threading.Lock()
        self._proc: subprocess.Popen | None = None
        self._gen = 0
        self.last: dict | None = None
        self.rev = 0
        self.lines: list[str] = []
        self.running = False
        self._sync: tuple | None = None
        self._bbl_dir: Path | None = None  # build folder of the engine whose result we kept

    # ── public ──────────────────────────────────────────────────────────
    async def compile(self, active: str | None = None, clean: bool = False, main: str | None = None) -> dict:
        """Compile the folder's main file (or `main`, or the root named by `active`'s % !TEX root)."""
        self._gen += 1
        gen = self._gen
        self._kill()
        return await asyncio.to_thread(self._run, gen, active, clean, main)

    def cancel(self) -> None:
        self._gen += 1
        self._kill()

    def reset(self) -> None:
        """Forget results when the folder changes."""
        self.cancel()
        self.last = None
        self.lines = []

    def output_pdf(self) -> Path:
        return build_dir(self.studio.root) / "output.pdf"

    def log_path(self) -> Path:
        return build_dir(self.studio.root) / "output.log"

    # ── internals ───────────────────────────────────────────────────────
    def _kill(self) -> None:
        proc = self._proc
        if proc and proc.poll() is None:
            try:
                proc.kill()
            except OSError:
                pass

    def _issue(self, title: str, explanation: str) -> dict:
        return {"severity": "error", "category": "engine", "raw": title, "title": title, "explanation": explanation}

    @staticmethod
    def _wrapper(bdir: Path, main_path: Path) -> Path:
        """The file Tectonic compiles: `\\input{texkit-prelude}`, then `\\input` of the real main file.

        The wrapper has the main file's name, so the job name and every output file are unchanged.
        Returns `main_path` itself (no prelude) when disabled, or when its path has a `%` or `#`,
        which can't be passed through `\\input`.
        """
        target = main_path.resolve().as_posix()
        if (os.environ.get("TEXKIT_NO_PRELUDE") or any(c in target for c in "%#")
                or not (tectonic.TEX_DIR / "texkit-prelude.tex").is_file()):
            return main_path
        wdir = bdir / "wrap"
        wdir.mkdir(parents=True, exist_ok=True)
        wrapper = wdir / main_path.name
        wrapper.write_text(f'\\input{{texkit-prelude}}\n\\input{{"\\detokenize{{{target}}}"}}\n', encoding="utf-8")
        return wrapper

    @staticmethod
    def _eps_issues(report: eps.EpsReport, log_text: str) -> list[logparse.Issue]:
        """One warning per EPS image that the document used and that is only a placeholder in the PDF."""
        issues = []
        log = log_text.replace("\n", "")  # TeX wraps long lines; the name we look for may be split
        for rel in report.placeholders:
            if f"{rel[:-4]}{eps.SUFFIX}" not in log:
                continue  # in the folder but never included (a template's spare logos)
            name = rel.rsplit("/", 1)[-1]
            stem = name[:-4]
            how = (f"Ghostscript is installed but couldn't convert it. Export the image as a PDF named {stem}{eps.SUFFIX} "
                   "next to it." if report.ghostscript else
                   "TexKit Studio can't draw EPS images itself. Install Ghostscript (Windows: winget install "
                   "ArtifexSoftware.GhostScript, macOS: brew install ghostscript, Linux: sudo apt install ghostscript) "
                   f"and compile again, or export the image as a PDF named {stem}{eps.SUFFIX} next to it.")
            issues.append(logparse.Issue(
                "warning", "graphics", f"EPS image replaced by a placeholder: {rel}",
                title=f"{name} is a blank placeholder in the PDF",
                explanation=f"The compile succeeded, but this EPS image couldn't be converted, so its space is left grey. {how}"))
        return issues

    def _finish(self, result: dict) -> dict:
        self.running = False
        self.last = result
        self.studio.publish_threadsafe({"type": "compile.finished", **result})
        return result

    def _run(self, gen: int, active: str | None, clean: bool, main_override: str | None) -> dict:
        with self._run_lock:
            if gen != self._gen:
                return {"status": "cancelled"}
            root = self.studio.root
            started = time.monotonic()
            self.running = True
            self.lines = []
            main = main_override or magic_root(root, active) or detect_main(root)
            if not main:
                return self._finish({
                    "status": "failed", "durationMs": 0, "rev": self.rev, "hasPdf": False, "main": None,
                    "issues": [self._issue("No main document found",
                                           "Create a .tex file with \\documentclass and \\begin{document}, "
                                           "or right-click a file and choose \"Set as main file\".")],
                })
            self.studio.publish_threadsafe({"type": "compile.started", "main": main})

            last_pct = -1

            def progress(done: int, total: int) -> None:
                nonlocal last_pct
                pct = int(done * 100 / total) if total else 0
                if pct != last_pct:
                    last_pct = pct
                    self.studio.publish_threadsafe({"type": "engine.progress", "done": done, "total": total})

            bdir = build_dir(root)
            if clean and bdir.exists():
                shutil.rmtree(bdir, ignore_errors=True)
            bdir.mkdir(parents=True, exist_ok=True)
            main_path = root / main
            stem = main_path.stem

            settings = project.load_settings(root)
            try:
                scanned = needs.scan(root)
            except Exception:  # scanning is advice only; never stop a compile for it
                scanned = needs.Scan()
            found = needs.detect(scanned)
            toolchain = system_tex.find()
            mode = str(os.environ.get("TEXKIT_ENGINE") or settings.get("engine") or "auto").lower()
            shell = bool(settings.get("shellEscape")) or os.environ.get("TEXKIT_SHELL_ESCAPE") == "1"
            exe: Path | None = None
            engine_error = ""
            if not (mode == "system" and toolchain):  # no need to fetch the built-in engine if it won't be used
                try:
                    exe = tectonic.ensure(progress)
                except tectonic.EngineError as exc:
                    engine_error = str(exc)

            plan = self._plan(mode, exe is not None, toolchain is not None, bool(found))
            if not plan:
                return self._finish({"status": "failed", "durationMs": 0, "rev": self.rev, "hasPdf": False,
                                     "main": main, "issues": [self._issue("LaTeX engine unavailable", engine_error)]})

            attempts: list[_Attempt] = []
            for name in plan:
                first = len(self.lines)
                if name == "tectonic":
                    attempt = self._attempt_tectonic(gen, exe, bdir, main_path, first)
                else:
                    attempt = self._attempt_system(gen, toolchain, scanned, bdir, main_path, first, shell)
                if attempt.cancelled:
                    self.running = False
                    self.studio.publish_threadsafe({"type": "compile.cancelled"})
                    return {"status": "cancelled"}
                attempt.issues = self._issues_for(root, main, attempt)
                attempts.append(attempt)
                if attempt.produced and not attempt.errors:
                    break
                # Keep going only when another engine could plausibly do better.
                if name == "tectonic" and attempt.produced and not self._engine_limited(attempt.issues):
                    break
            best = min(enumerate(attempts), key=lambda ia: (not ia[1].produced, ia[1].errors, ia[0]))[1]

            if best.produced:
                shutil.copyfile(best.run_dir / f"{stem}.pdf", bdir / "output.pdf")
                synctex = best.run_dir / f"{stem}.synctex.gz"
                if synctex.is_file():
                    shutil.copyfile(synctex, bdir / "output.synctex.gz")
                self.rev += 1
            self._bbl_dir = best.run_dir
            if best.log_text:
                (bdir / "output.log").write_text(best.log_text, encoding="utf-8")

            issues = list(best.issues)
            if best.engine == "tectonic":
                issues.extend(self._eps_issues(best.eps_report, best.log_text))
            else:
                issues.append(logparse.Issue(
                    "info", "engine", f"Compiled with {best.engine} from your TeX installation",
                    title=f"Compiled with {best.engine} from your TeX installation",
                    explanation="This document needs more than the built-in engine offers, so TexKit Studio used the TeX "
                                "distribution installed on this computer."))
            other = next((a for a in attempts if a is not best and a.engine != "tectonic"), None)
            why = next((i.title or i.raw for i in other.issues if i.severity == "error"), None) if other else None
            issues.extend(self._needs_issues(found, best, toolchain is not None, shell, why))
            issues.sort(key=lambda i: {"error": 0, "warning": 1, "info": 2}[i.severity])
            errors = sum(i.severity == "error" for i in issues)
            status = "failed" if not best.produced else ("errors" if errors else "ok")
            if best.produced:
                try:
                    history.snapshot(root)  # automatic version history; never blocks a compile
                except OSError:
                    pass
            return self._finish({
                "status": status,
                "durationMs": int((time.monotonic() - started) * 1000),
                "rev": self.rev,
                "hasPdf": (bdir / "output.pdf").is_file(),
                "main": main,
                "offline": best.offline,
                "engine": best.engine,
                "issues": [i.to_dict() for i in issues],
            })

    # ── engines ─────────────────────────────────────────────────────────
    @staticmethod
    def _plan(mode: str, have_tectonic: bool, have_system: bool, needs_system: bool) -> list[str]:
        """Engines to try, in order. The built-in one first, unless the document needs an installed TeX."""
        if mode == "system" and have_system:
            return ["system"]
        if mode == "tectonic" or (mode == "system" and not have_system):
            return ["tectonic"] if have_tectonic else []
        order = ["system", "tectonic"] if needs_system else ["tectonic", "system"]
        return [e for e in order if (e == "tectonic" and have_tectonic) or (e == "system" and have_system)]

    # Errors that point at the built-in engine's limits rather than at a mistake in the document.
    _LIMITS = re.compile(
        r"File `[^']+\.(?:sty|cls|def|cfg|fd|clo|bst)' not found|requires LaTeX|NewTaggingSocket|NewSocket|"
        r"AssignStructureRole|NewStructureName|program not found|terminal input forbidden|-shell-escape|"
        r"Package fontspec Error: The font|image inclusion failed|Unknown graphics extension|Biber|runsystem|"
        r"Undefined control sequence.*\\(?:pdf|PDF)",
        re.I)

    def _engine_limited(self, issues: list[logparse.Issue]) -> bool:
        return any(i.severity == "error" and self._LIMITS.search(i.raw) for i in issues)

    def _issues_for(self, root: Path, main: str, attempt: _Attempt) -> list[logparse.Issue]:
        lines = self.lines[attempt.first_line:]
        if attempt.engine != "tectonic":
            lines = [system_tex.normalize(ln) for ln in lines]
        issues = friendly.explain_all(logparse.parse(root, main, lines, attempt.log_text,
                                                     from_log=attempt.engine != "tectonic"))
        if not attempt.produced and not any(i.severity == "error" for i in issues):
            tail = [ln for ln in lines if ln.startswith(("error:", "!"))][-3:] or lines[-3:]
            issues.insert(0, logparse.Issue("error", "engine", " ".join(tail) or "Compile failed",
                                            title="The document couldn't be compiled"))
            friendly.explain(issues[0])
        attempt.errors = sum(i.severity == "error" for i in issues)
        return issues

    def _attempt_tectonic(self, gen: int, exe: Path, bdir: Path, main_path: Path, first: int) -> _Attempt:
        run_dir = bdir / "run"
        run_dir.mkdir(parents=True, exist_ok=True)
        stem = main_path.stem
        pdf = run_dir / f"{stem}.pdf"
        attempt = _Attempt("tectonic", run_dir, first)
        # Tectonic can't embed .eps files; give each one a PDF stand-in (see compile/eps.py).
        eps_dir = bdir / "eps"
        try:
            attempt.eps_report = eps.prepare(main_path.parent, eps_dir)
        except Exception as exc:  # preparing images must never stop a compile
            self.lines.append(f"note: couldn't prepare EPS images: {exc}")
        # Compile a small wrapper that loads our prelude (compat fixes for pdfLaTeX-era templates), then
        # your file. Your folder goes on the search path so every relative path resolves as before.
        source = self._wrapper(bdir, main_path)
        search = [eps_dir] if source == main_path else [main_path.parent, eps_dir]
        for only_cached in (False, True):
            cmd = tectonic.command(exe, source, run_dir, only_cached=only_cached, search_paths=search)
            cmd[1:1] = ["--color", "never", "-Z", "continue-on-errors"]
            started = time.time()
            try:
                self._stream(cmd, main_path.parent, tectonic.environment() or None)
            except OSError as exc:
                self.lines.append(f"error: Couldn't start the LaTeX engine: {exc}")
                return attempt
            if gen != self._gen:
                attempt.cancelled = True
                return attempt
            attempt.produced = pdf.is_file() and pdf.stat().st_mtime >= started - 2
            # No internet? Try again using only the packages already downloaded.
            if attempt.produced or only_cached or not offline_mod.is_network_failure(self.lines[first:]):
                break
            attempt.offline = True
            self.lines.append("note: no internet connection; retrying with cached packages only")
        attempt.log_text = self._read_log(run_dir, stem)
        return attempt

    def _attempt_system(self, gen: int, tc: system_tex.Toolchain, scanned: needs.Scan, bdir: Path,
                        main_path: Path, first: int, shell: bool) -> _Attempt:
        engine = system_tex.choose_engine(tc, needs.pick_engine(scanned)) or "pdflatex"
        run_dir = bdir / "run-system"
        run_dir.mkdir(parents=True, exist_ok=True)
        stem = main_path.stem
        pdf = run_dir / f"{stem}.pdf"
        attempt = _Attempt(f"{engine}", run_dir, first)
        self.lines.append(f"note: compiling with {engine} from your TeX installation")
        started = time.time()

        def stream(cmd: list[str], cwd: Path, env: dict[str, str] | None) -> None:
            if gen != self._gen:
                raise _Cancelled
            self._stream(cmd, cwd, env)

        try:
            system_tex.run(tc, engine, main_path, run_dir, stream, shell_escape=shell,
                           auto_install=bool(project.load_settings(self.studio.root).get("autoInstall")))
        except _Cancelled:
            attempt.cancelled = True
            return attempt
        except OSError as exc:
            self.lines.append(f"error: Couldn't start {engine}: {exc}")
            return attempt
        if gen != self._gen:
            attempt.cancelled = True
            return attempt
        attempt.produced = pdf.is_file() and pdf.stat().st_mtime >= started - 2
        attempt.log_text = self._read_log(run_dir, stem)
        return attempt

    @staticmethod
    def _read_log(run_dir: Path, stem: str) -> str:
        log_file = run_dir / f"{stem}.log"
        return log_file.read_text(encoding="utf-8", errors="replace") if log_file.is_file() else ""

    def _needs_issues(self, found: list[needs.Need], best: _Attempt, have_system: bool, shell: bool,
                      system_failure: str | None = None) -> list[logparse.Issue]:
        """Tell the user what the document uses that its engine couldn't provide, and how to fix that."""
        issues = []
        for need in found:
            if best.engine == "tectonic":
                fix = ("Install a TeX distribution (TeX Live or MiKTeX; on Windows: winget install MiKTeX.MiKTeX) and "
                       "TexKit Studio will use it automatically for this document." if not have_system else
                       f"Your TeX installation was tried too and failed: {system_failure or 'see the log'}.")
                severity = "error" if not best.produced or best.errors else "warning"
                issues.append(logparse.Issue(
                    severity, "engine", f"{need.summary}: {need.consequence}",
                    title=f"Needs more than the built-in engine: {need.summary}",
                    explanation=f"This document uses {need.summary}, but {need.consequence}. {fix}"))
            elif need.shell_escape and not shell:
                issues.append(logparse.Issue(
                    "warning", "engine", f"{need.summary} needs permission to run programs",
                    title=f"{need.summary} needs permission to run programs",
                    explanation='TexKit Studio doesn\'t let documents run programs unless you allow it for this folder. To allow it, '
                                'add "shellEscape": true to .texkit/project.json, then compile again. Only do this for documents you trust.'))
        return issues

    def _stream(self, cmd: list[str], cwd: Path, env: dict[str, str] | None = None) -> None:
        """Run the engine, forwarding its output to the browser in small batches."""
        proc = subprocess.Popen(
            cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace", bufsize=1,
            env={**os.environ, **env} if env else None, **tectonic.no_window(),
        )
        self._proc = proc
        batch: list[str] = []
        last_flush = time.monotonic()
        assert proc.stdout is not None
        for line in proc.stdout:
            line = line.rstrip("\n")
            self.lines.append(line)
            batch.append(line)
            if time.monotonic() - last_flush > 0.1:
                self.studio.publish_threadsafe({"type": "compile.log", "lines": batch})
                batch, last_flush = [], time.monotonic()
        if batch:
            self.studio.publish_threadsafe({"type": "compile.log", "lines": batch})
        proc.wait()
        self._proc = None

    # ── SyncTeX ─────────────────────────────────────────────────────────
    def sync_index(self) -> SyncIndex | None:
        path = build_dir(self.studio.root) / "output.synctex.gz"
        if not path.is_file():
            return None
        key = (str(self.studio.root), path.stat().st_mtime)
        if self._sync and self._sync[0] == key:
            return self._sync[1]
        index = SyncIndex.load(path, self.studio.root)
        self._sync = (key, index)
        return index

    def bbl_path(self) -> Path | None:
        main = detect_main(self.studio.root)
        if not main:
            return None
        folder = self._bbl_dir or build_dir(self.studio.root) / "run"
        p = folder / f"{Path(main).stem}.bbl"
        return p if p.is_file() else None
