"""Shared server state: the current folder, event broadcasting, compile service, watcher."""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

from fastapi import WebSocket

from .. import config
from ..compile.service import CompileService
from .safefs import is_hidden


class Studio:
    def __init__(self, root: Path, token: str, port: int = 0) -> None:
        self.root = root.resolve()
        self.token = token
        self.port = port
        self.loop: asyncio.AbstractEventLoop | None = None
        self.clients: set[WebSocket] = set()
        self.compiler = CompileService(self)
        self.offline_running = False
        self._own_writes: dict[str, float] = {}
        self._watch_task: asyncio.Task | None = None
        self._watch_stop: asyncio.Event | None = None

    # ── hosts allowed to reach the API (DNS-rebinding protection) ───────
    @property
    def allowed_hosts(self) -> set[str]:
        return {f"127.0.0.1:{self.port}", f"localhost:{self.port}", "testserver"}

    # ── folder ──────────────────────────────────────────────────────────
    async def set_root(self, path: Path) -> None:
        path = path.expanduser().resolve()
        if not path.is_dir():
            raise FileNotFoundError(f"Not a folder: {path}")
        self.root = path
        config.add_recent(path)
        self.compiler.reset()
        await self.start_watcher()
        await self.publish({"type": "root.changed", "root": str(path), "name": path.name or str(path)})

    # ── events ──────────────────────────────────────────────────────────
    async def publish(self, msg: dict) -> None:
        data = json.dumps(msg)
        for ws in list(self.clients):
            try:
                await ws.send_text(data)
            except Exception:
                self.clients.discard(ws)

    def publish_threadsafe(self, msg: dict) -> None:
        if self.loop and not self.loop.is_closed():
            asyncio.run_coroutine_threadsafe(self.publish(msg), self.loop)

    # ── file watcher ────────────────────────────────────────────────────
    def mark_written(self, path: Path) -> None:
        self._own_writes[str(path)] = time.monotonic()

    async def start_watcher(self) -> None:
        await self.stop_watcher()
        self._watch_stop = asyncio.Event()
        self._watch_task = asyncio.create_task(self._watch(self.root, self._watch_stop))

    async def stop_watcher(self) -> None:
        if self._watch_stop:
            self._watch_stop.set()
        if self._watch_task:
            try:
                await asyncio.wait_for(self._watch_task, timeout=2)
            except (asyncio.TimeoutError, asyncio.CancelledError, Exception):
                self._watch_task.cancel()
        self._watch_task = None

    async def _watch(self, root: Path, stop: asyncio.Event) -> None:
        try:
            from watchfiles import awatch
        except ImportError:
            return
        try:
            async for changes in awatch(root, stop_event=stop, debounce=400, recursive=True):
                now = time.monotonic()
                paths = []
                for _change, raw in changes:
                    p = Path(raw)
                    try:
                        rel = p.relative_to(root)
                    except ValueError:
                        continue
                    if any(is_hidden(part) for part in rel.parts):
                        continue
                    if now - self._own_writes.get(str(p), 0) < 2.0:
                        continue
                    paths.append(rel.as_posix())
                if paths:
                    await self.publish({"type": "fs.changed", "paths": sorted(set(paths))})
        except Exception:
            pass  # a vanished folder or a platform quirk must never take the server down
