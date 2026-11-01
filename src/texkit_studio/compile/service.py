"""Run Tectonic for the current folder: one compile at a time, newest request wins."""

from __future__ import annotations

import asyncio
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import TYPE_CHECKING

from ..config import build_dir
from ..core import history
from ..core.project import detect_main, magic_root
from ..engine import offline as offline_mod
from ..engine import tectonic
from ..synctex.index import SyncIndex
from . import friendly, logparse

if TYPE_CHECKING:
    from ..core.studio import Studio


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

            try:
                exe = tectonic.ensure(progress)
            except tectonic.EngineError as exc:
                return self._finish({"status": "failed", "durationMs": 0, "rev": self.rev, "hasPdf": False,
                                     "main": main, "issues": [self._issue("LaTeX engine unavailable", str(exc))]})

            bdir = build_dir(root)
            if clean and bdir.exists():
                shutil.rmtree(bdir, ignore_errors=True)
            run_dir = bdir / "run"
            run_dir.mkdir(parents=True, exist_ok=True)
            main_path = root / main
            stem = main_path.stem
            pdf = run_dir / f"{stem}.pdf"
            offline = False
            for only_cached in (False, True):
                cmd = tectonic.command(exe, main_path, run_dir, only_cached=only_cached)
                cmd[1:1] = ["--color", "never", "-Z", "continue-on-errors"]
                attempt_started = time.time()
                try:
                    self._stream(cmd, main_path.parent)
                except OSError as exc:
                    return self._finish({"status": "failed", "durationMs": 0, "rev": self.rev, "hasPdf": False,
                                         "main": main, "issues": [self._issue("Couldn't start the LaTeX engine", str(exc))]})
                if gen != self._gen:
                    self.running = False
                    self.studio.publish_threadsafe({"type": "compile.cancelled"})
                    return {"status": "cancelled"}
                produced = pdf.is_file() and pdf.stat().st_mtime >= attempt_started - 2
                # No internet? Try again using only the packages already downloaded.
                if produced or only_cached or not offline_mod.is_network_failure(self.lines):
                    break
                offline = True
                self.lines.append("note: no internet connection; retrying with cached packages only")
            if produced:
                shutil.copyfile(pdf, bdir / "output.pdf")
                synctex = run_dir / f"{stem}.synctex.gz"
                if synctex.is_file():
                    shutil.copyfile(synctex, bdir / "output.synctex.gz")
                self.rev += 1
            log_text = ""
            log_file = run_dir / f"{stem}.log"
            if log_file.is_file():
                log_text = log_file.read_text(encoding="utf-8", errors="replace")
                shutil.copyfile(log_file, bdir / "output.log")

            issues = friendly.explain_all(logparse.parse(root, main, self.lines, log_text))
            if not produced and not any(i.severity == "error" for i in issues):
                tail = [ln for ln in self.lines if ln.startswith("error:")][-3:] or self.lines[-3:]
                issues.insert(0, logparse.Issue("error", "engine", " ".join(tail) or "Compile failed",
                                                title="The document couldn't be compiled"))
                friendly.explain(issues[0])
            errors = sum(i.severity == "error" for i in issues)
            status = "failed" if not produced else ("errors" if errors else "ok")
            if produced:
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
                "offline": offline,
                "issues": [i.to_dict() for i in issues],
            })

    def _stream(self, cmd: list[str], cwd: Path) -> None:
        """Run the engine, forwarding its output to the browser in small batches."""
        proc = subprocess.Popen(
            cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace", bufsize=1, **tectonic.no_window(),
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
        p = build_dir(self.studio.root) / "run" / f"{Path(main).stem}.bbl"
        return p if p.is_file() else None
