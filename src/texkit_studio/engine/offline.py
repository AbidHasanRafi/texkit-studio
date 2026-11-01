"""Prepare for offline use: compile every built-in template once so the engine caches
every package they need. Afterwards those documents compile with no internet."""

from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path
from typing import Callable

from ..core import templates
from . import tectonic


def prepare(progress: Callable[[int, int, str], None] | None = None) -> list[dict]:
    exe = tectonic.ensure()
    items = templates.list_templates()
    results = []
    with tempfile.TemporaryDirectory(prefix="texkit-offline-") as tmp:
        for i, t in enumerate(items):
            if progress:
                progress(i, len(items), t["name"])
            folder = Path(tmp) / t["id"]
            main = templates.apply(t["id"], folder)
            out = folder / "_out"
            out.mkdir()
            cmd = tectonic.command(exe, folder / main, out)
            cmd[1:1] = ["--color", "never", "-Z", "continue-on-errors"]
            proc = subprocess.run(cmd, cwd=folder, capture_output=True, text=True, encoding="utf-8",
                                  errors="replace", timeout=900, **tectonic.no_window())
            ok = (out / Path(main).with_suffix(".pdf").name).is_file()
            results.append({"template": t["name"], "ok": ok, "detail": "" if ok else proc.stdout[-400:] + proc.stderr[-400:]})
    if progress:
        progress(len(items), len(items), "done")
    return results


def is_network_failure(lines: list[str]) -> bool:
    text = "\n".join(lines[-60:]).lower()
    return any(s in text for s in ("failed to download", "network", "dns error", "error sending request",
                                   "timed out", "connection refused", "could not resolve"))
