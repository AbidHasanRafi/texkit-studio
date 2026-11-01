"""FastAPI application: JSON API under /api, the web UI as static files at /."""

from __future__ import annotations

import asyncio
import re
import sys
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from send2trash import send2trash

from .. import config
from .._meta import DIST_NAME, PRODUCT_NAME, TAGLINE, __version__
from ..config import build_dir
from ..core import analysis, export, folders, formatter, history, project, templates, tools
from ..core.safefs import MAX_TEXT_BYTES, PathError, atomic_write, content_hash, file_kind, resolve_in
from ..core.studio import Studio
from ..engine import offline, tectonic
from .security import COOKIE, GuardMiddleware

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
NO_STORE = {"Cache-Control": "no-store"}


# ── request bodies ──────────────────────────────────────────────────────
class PathBody(BaseModel):
    path: str


class WriteBody(BaseModel):
    path: str
    content: str
    baseHash: str | None = None
    force: bool = False


class CreateBody(BaseModel):
    path: str
    type: str = "file"  # "file" | "dir"


class MoveBody(BaseModel):
    from_: str = Field(alias="from")
    to: str


class CompileBody(BaseModel):
    active: str | None = None
    clean: bool = False


class MkdirBody(BaseModel):
    parent: str
    name: str


class TemplateBody(BaseModel):
    id: str
    parent: str | None = None  # where to create the new folder
    name: str | None = None  # new folder name; omit to fill the current folder
    here: bool = False


class RevealBody(BaseModel):
    path: str | None = None


class RestoreBody(BaseModel):
    id: str
    path: str


class LookupBody(BaseModel):
    id: str


class AddCitationBody(BaseModel):
    bibtex: str
    file: str | None = None


class FormatBody(BaseModel):
    path: str
    content: str
    indent: int = Field(2, ge=0, le=8)
    alignTables: bool = True


def create_app(studio: Studio) -> FastAPI:
    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        studio.loop = asyncio.get_running_loop()
        await studio.start_watcher()
        yield
        studio.compiler.cancel()
        await studio.stop_watcher()

    app = FastAPI(title=PRODUCT_NAME, version=__version__, lifespan=lifespan, docs_url=None, redoc_url=None)
    app.add_middleware(GuardMiddleware, studio=studio)

    @app.exception_handler(PathError)
    async def _path_error(_r, exc):
        return JSONResponse({"detail": str(exc)}, status_code=400)

    @app.exception_handler(FileNotFoundError)
    async def _not_found(_r, exc):
        return JSONResponse({"detail": str(exc) or "Not found"}, status_code=404)

    @app.exception_handler(PermissionError)
    async def _forbidden(_r, exc):
        return JSONResponse({"detail": str(exc) or "Permission denied"}, status_code=403)

    @app.exception_handler(FileExistsError)
    async def _exists(_r, exc):
        return JSONResponse({"detail": str(exc) or "Already exists"}, status_code=409)

    def rel_path(rel: str) -> Path:
        return resolve_in(studio.root, rel)

    # ── auth & meta ─────────────────────────────────────────────────────
    @app.get("/auth")
    async def auth(token: str):
        if token != studio.token:
            raise HTTPException(401, "That link has expired. Run the texkit command again.")
        resp = RedirectResponse("/", status_code=303)
        resp.set_cookie(COOKIE, studio.token, httponly=True, samesite="strict")
        return resp

    @app.get("/api/health")
    async def health():
        return {"ok": True, "app": DIST_NAME}

    @app.get("/api/session")
    async def session():
        root = studio.root
        main = await asyncio.to_thread(project.detect_main, root)
        last = studio.compiler.last
        return {
            "product": PRODUCT_NAME, "tagline": TAGLINE, "version": __version__, "platform": sys.platform,
            "root": str(root), "name": root.name or str(root), "mainFile": main,
            "home": str(Path.home()), "recent": config.recent_folders(),
            "engine": {"installed": tectonic.find() is not None, "version": tectonic.VERSION},
            "compile": last, "compiling": studio.compiler.running,
            "hasPdf": studio.compiler.output_pdf().is_file(), "rev": studio.compiler.rev,
        }

    @app.post("/api/session/root")
    async def change_root(body: PathBody):
        await studio.set_root(Path(body.path))
        return {"root": str(studio.root)}

    # ── folders (Open folder… dialog) ───────────────────────────────────
    @app.get("/api/fs/browse")
    async def browse(path: str | None = None):
        return await asyncio.to_thread(folders.browse, path)

    @app.get("/api/fs/shortcuts")
    async def shortcuts():
        return await asyncio.to_thread(folders.shortcuts)

    @app.post("/api/fs/mkdir")
    async def mkdir(body: MkdirBody):
        try:
            made = folders.make_folder(body.parent, body.name)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        return {"path": str(made)}

    @app.post("/api/system/reveal")
    async def reveal(body: RevealBody):
        target = rel_path(body.path) if body.path else studio.root
        await asyncio.to_thread(folders.reveal, target)
        return {"ok": True}

    # ── project files ───────────────────────────────────────────────────
    @app.get("/api/tree")
    async def tree():
        return {"root": str(studio.root), "tree": await asyncio.to_thread(project.tree, studio.root),
                "mainFile": await asyncio.to_thread(project.detect_main, studio.root)}

    @app.get("/api/file")
    async def read_file(path: str):
        p = rel_path(path)
        if not p.is_file():
            raise FileNotFoundError(f"No such file: {path}")
        kind = file_kind(p)
        if kind not in ("tex", "bib", "text"):
            return {"path": path, "kind": kind, "size": p.stat().st_size}
        if p.stat().st_size > MAX_TEXT_BYTES:
            return {"path": path, "kind": "binary", "size": p.stat().st_size, "tooLarge": True}
        data = p.read_bytes()
        read_only = False
        try:
            text = data.decode("utf-8-sig")
        except UnicodeDecodeError:
            text, read_only = data.decode("latin-1"), True
        return {"path": path, "kind": kind, "content": text, "hash": content_hash(data), "readOnly": read_only}

    @app.get("/api/raw")
    async def raw(path: str):
        p = rel_path(path)
        if not p.is_file():
            raise FileNotFoundError(f"No such file: {path}")
        return FileResponse(p, headers=NO_STORE)

    @app.put("/api/file")
    async def write_file(body: WriteBody):
        p = rel_path(body.path)
        if p.exists() and not p.is_file():
            raise HTTPException(400, "That path is a folder.")
        current = p.read_bytes() if p.is_file() else None
        if current is not None and body.baseHash and not body.force and content_hash(current) != body.baseHash:
            return JSONResponse({"detail": "The file changed on disk.", "conflict": True,
                                 "hash": content_hash(current)}, status_code=409)
        bom = b"\xef\xbb\xbf" if current and current.startswith(b"\xef\xbb\xbf") else b""
        content = body.content
        if current and b"\r\n" in current and "\r\n" not in content:
            content = content.replace("\n", "\r\n")  # the editor uses \n; keep the file's Windows line endings
        data = bom + content.encode("utf-8")
        studio.mark_written(p)
        await asyncio.to_thread(atomic_write, p, data)
        return {"hash": content_hash(data)}

    @app.post("/api/file/create")
    async def create(body: CreateBody):
        p = rel_path(body.path)
        if p.exists():
            raise FileExistsError(f"{body.path} already exists")
        studio.mark_written(p)
        if body.type == "dir":
            p.mkdir(parents=True)
        else:
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(b"")
        return {"path": body.path}

    @app.post("/api/file/move")
    async def move(body: MoveBody):
        src, dst = rel_path(body.from_), rel_path(body.to)
        if not src.exists():
            raise FileNotFoundError(f"No such file: {body.from_}")
        if dst.exists():
            raise FileExistsError(f"{body.to} already exists")
        dst.parent.mkdir(parents=True, exist_ok=True)
        src.rename(dst)
        settings = project.load_settings(studio.root)
        if settings.get("mainFile") == body.from_:
            project.save_settings(studio.root, {**settings, "mainFile": body.to})
        return {"path": body.to}

    @app.post("/api/file/delete")
    async def delete(body: PathBody):
        p = rel_path(body.path)
        if p == studio.root:
            raise HTTPException(400, "Can't delete the project folder itself.")
        if not p.exists():
            raise FileNotFoundError(f"No such file: {body.path}")
        await asyncio.to_thread(send2trash, str(p))  # recoverable from the OS trash
        return {"ok": True}

    @app.post("/api/file/upload")
    async def upload(dir: str = Form(""), files: list[UploadFile] = File(...)):
        target_dir = rel_path(dir)
        saved = []
        for f in files:
            name = Path(f.filename or "upload").name
            dest = resolve_in(studio.root, f"{dir}/{name}" if dir else name)
            studio.mark_written(dest)
            await asyncio.to_thread(atomic_write, dest, await f.read())
            saved.append(dest.relative_to(studio.root).as_posix())
        return {"saved": saved, "dir": target_dir.relative_to(studio.root).as_posix() if target_dir != studio.root else ""}

    @app.post("/api/project/main")
    async def set_main(body: PathBody):
        p = rel_path(body.path)
        if not p.is_file() or p.suffix.lower() != ".tex":
            raise HTTPException(400, "The main file must be a .tex file.")
        settings = project.load_settings(studio.root)
        project.save_settings(studio.root, {**settings, "mainFile": body.path})
        return {"mainFile": body.path}

    # ── templates ───────────────────────────────────────────────────────
    @app.get("/api/templates")
    async def list_templates():
        root = studio.root
        has_tex = bool(await asyncio.to_thread(project.tex_files, root, 2))
        return {"templates": templates.list_templates(), "currentHasTex": has_tex,
                "defaultParent": str(root.parent if has_tex else root)}

    @app.post("/api/templates/apply")
    async def apply_template(body: TemplateBody):
        if body.here:
            dest = studio.root
        else:
            if not body.name or not body.parent:
                raise HTTPException(400, "Give the new project a name.")
            parent = Path(body.parent).expanduser().resolve()
            try:
                dest = folders.make_folder(str(parent), body.name)
            except ValueError as exc:
                raise HTTPException(400, str(exc))
        main = await asyncio.to_thread(templates.apply, body.id, dest)
        if dest != studio.root:
            await studio.set_root(dest)
        return {"root": str(dest), "mainFile": main}

    # ── compile ─────────────────────────────────────────────────────────
    @app.post("/api/compile")
    async def compile_(body: CompileBody):
        return await studio.compiler.compile(body.active, body.clean)

    @app.post("/api/compile/cancel")
    async def cancel():
        studio.compiler.cancel()
        return {"ok": True}

    @app.get("/api/output.pdf")
    async def output_pdf():
        pdf = studio.compiler.output_pdf()
        if not pdf.is_file():
            raise FileNotFoundError("Nothing compiled yet.")
        return FileResponse(pdf, media_type="application/pdf", headers=NO_STORE)

    @app.get("/api/log")
    async def log():
        path = studio.compiler.log_path()
        text = path.read_text(encoding="utf-8", errors="replace") if path.is_file() else ""
        return {"output": "\n".join(studio.compiler.lines), "log": text}

    # ── Download menu ───────────────────────────────────────────────────
    def download_name(ext: str) -> str:
        return f"{studio.root.name or 'document'}.{ext}"

    @app.get("/api/export/pdf")
    async def export_pdf():
        pdf = studio.compiler.output_pdf()
        if not pdf.is_file():
            await studio.compiler.compile()
        if not pdf.is_file():
            raise HTTPException(409, "The document couldn't be compiled, so there's no PDF yet. Check the issues panel.")
        return FileResponse(pdf, media_type="application/pdf", filename=download_name("pdf"), headers=NO_STORE)

    @app.get("/api/export/zip")
    async def export_zip():
        out = build_dir(studio.root) / "export" / download_name("zip")
        await asyncio.to_thread(export.zip_project, studio.root, out)
        return FileResponse(out, media_type="application/zip", filename=download_name("zip"), headers=NO_STORE)

    @app.get("/api/export/docx")
    async def export_docx():
        main = await asyncio.to_thread(project.detect_main, studio.root)
        if not main:
            raise HTTPException(409, "There's no main .tex file to convert.")
        out = build_dir(studio.root) / "export" / download_name("docx")
        try:
            path, _warnings = await asyncio.to_thread(export.to_docx, studio.root, main, out)
        except export.ExportError as exc:
            raise HTTPException(500, str(exc))
        return FileResponse(path, filename=download_name("docx"), headers=NO_STORE,
                            media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document")

    @app.get("/api/export/submission")
    async def export_submission():
        """A single flattened .tex with its .bbl and images: what arXiv and journals ask for."""
        main = await asyncio.to_thread(project.detect_main, studio.root)
        if not main:
            raise HTTPException(409, "There's no main .tex file to package.")
        result = await asyncio.to_thread(analysis.analyse, studio.root)
        bbl = studio.compiler.bbl_path()
        if result["bibliography"]["included"] and not bbl:
            await studio.compiler.compile()
            bbl = studio.compiler.bbl_path()
        name = f"{studio.root.name or 'document'}-submission.zip"
        out = build_dir(studio.root) / "export" / name
        await asyncio.to_thread(tools.submission_zip, studio.root, main, result, bbl, out)
        return FileResponse(out, media_type="application/zip", filename=name, headers=NO_STORE)

    # ── references, citations and the submission check ──────────────────
    @app.get("/api/analysis")
    async def get_analysis():
        return await asyncio.to_thread(analysis.analyse, studio.root)

    @app.get("/api/check")
    async def submission_check():
        root = studio.root
        result = await asyncio.to_thread(analysis.analyse, root)
        unused = await asyncio.to_thread(analysis.unused_files, root, result)
        abstract_words = None
        if result["main"]:
            text = await asyncio.to_thread(tools.flatten, root, result["main"])
            m = re.search(r"\\begin\{abstract\}(.*?)\\end\{abstract\}", text, re.S)
            if m:
                body = re.sub(r"\\[a-zA-Z]+\*?|[{}$%]", " ", m.group(1))
                abstract_words = len(re.findall(r"[^\W\d_][\w'’-]*|\d+", body))
        floats = [f for f in result["floats"] if f["depth"] == 0]
        return {
            "analysis": result,
            "compile": studio.compiler.last,
            "unusedFiles": unused,
            "stats": {
                "words": result["words"], "abstractWords": abstract_words,
                "figures": sum(f["kind"] == "figure" for f in floats), "tables": sum(f["kind"] == "table" for f in floats),
                "citations": len({c["key"] for c in result["cites"]}), "entries": len(result["bibliography"]["entries"]),
                "sections": [{"title": s["title"], "level": s["level"], "words": s["words"]} for s in result["sections"]],
            },
        }

    @app.post("/api/citations/lookup")
    async def citation_lookup(body: LookupBody):
        result = await asyncio.to_thread(analysis.analyse, studio.root)
        taken = {e["key"] for e in result["bibliography"]["entries"]}
        try:
            found = await asyncio.to_thread(tools.lookup, body.id, taken)
        except tools.LookupError_ as exc:
            raise HTTPException(400, str(exc))
        found["file"] = result["bibliography"]["files"][0] if result["bibliography"]["files"] else "references.bib"
        found["bibIncluded"] = result["bibliography"]["included"]
        return found

    @app.post("/api/citations/add")
    async def citation_add(body: AddCitationBody):
        rel = body.file or "references.bib"
        if not rel.endswith(".bib"):
            raise HTTPException(400, "Citations can only be added to a .bib file.")
        p = rel_path(rel)
        current = p.read_bytes() if p.is_file() else b""
        sep = b"" if not current or current.endswith(b"\n\n") else (b"\n" if current.endswith(b"\n") else b"\n\n")
        studio.mark_written(p)
        await asyncio.to_thread(atomic_write, p, current + sep + body.bibtex.strip().encode() + b"\n")
        return {"file": rel}

    # ── SyncTeX: click-to-jump ─────────────────────────────────────────
    @app.get("/api/synctex/forward")
    async def sync_forward(file: str, line: int):
        index = await asyncio.to_thread(studio.compiler.sync_index)
        hit = index.forward(file, line) if index else None
        if not hit:
            raise HTTPException(404, "That line isn't in the PDF yet. Compile, then try again.")
        return hit

    @app.get("/api/synctex/inverse")
    async def sync_inverse(page: int, x: float, y: float):
        index = await asyncio.to_thread(studio.compiler.sync_index)
        hit = index.inverse(page, x, y) if index else None
        if not hit:
            raise HTTPException(404, "Couldn't find the source for that spot.")
        return hit

    # ── history ─────────────────────────────────────────────────────────
    @app.get("/api/history")
    async def history_list():
        return {"snapshots": await asyncio.to_thread(history.list_snapshots, studio.root)}

    @app.get("/api/history/diff")
    async def history_diff(id: str, path: str):
        rel_path(path)
        return await asyncio.to_thread(history.diff, studio.root, id, path)

    @app.post("/api/history/restore")
    async def history_restore(body: RestoreBody):
        p = rel_path(body.path)
        studio.mark_written(p)
        await asyncio.to_thread(history.restore, studio.root, body.id, body.path)
        await studio.publish({"type": "fs.changed", "paths": [body.path]})
        return {"ok": True}

    @app.post("/api/history/snapshot")
    async def history_snapshot():
        snap = await asyncio.to_thread(history.snapshot, studio.root, "manual")
        return {"created": snap is not None}

    # ── formatting (like Prettier) ──────────────────────────────────────
    @app.post("/api/format")
    async def format_document(body: FormatBody):
        opts = formatter.Options(indent=body.indent, align_tables=body.alignTables)
        try:
            out = await asyncio.to_thread(formatter.format_text, body.content, body.path, opts)
        except formatter.FormatError as exc:
            raise HTTPException(400, str(exc))
        return {"content": out, "changed": out != body.content}

    # ── search, import, offline ─────────────────────────────────────────
    @app.get("/api/search")
    async def search(q: str, regex: bool = False, case: bool = False, whole: bool = False):
        try:
            return await asyncio.to_thread(tools.search, studio.root, q, regex=regex, case=case, whole=whole)
        except ValueError as exc:
            raise HTTPException(400, str(exc))

    @app.post("/api/import")
    async def import_zip(file: UploadFile = File(...), parent: str = Form(...)):
        parent_dir = Path(parent).expanduser().resolve()
        if not parent_dir.is_dir():
            raise HTTPException(400, "That location doesn't exist.")
        dest = tools.unique_folder(parent_dir, Path(file.filename or "project.zip").stem)
        try:
            await asyncio.to_thread(tools.import_zip, await file.read(), dest)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        await studio.set_root(dest)
        return {"root": str(dest)}

    @app.post("/api/system/prepare-offline")
    async def prepare_offline():
        if studio.offline_running:
            return {"started": False}
        studio.offline_running = True

        def run() -> None:
            try:
                results = offline.prepare(lambda i, n, name: studio.publish_threadsafe(
                    {"type": "offline.progress", "done": i, "total": n, "name": name}))
                studio.publish_threadsafe({"type": "offline.done", "results": results})
            except Exception as exc:  # report, never crash the server
                studio.publish_threadsafe({"type": "offline.done", "error": str(exc)})
            finally:
                studio.offline_running = False

        asyncio.get_running_loop().run_in_executor(None, run)
        return {"started": True}

    # ── live events ─────────────────────────────────────────────────────
    @app.websocket("/api/events")
    async def events(ws: WebSocket):
        await ws.accept()
        studio.clients.add(ws)
        try:
            while True:
                await ws.receive_text()
        except WebSocketDisconnect:
            pass
        finally:
            studio.clients.discard(ws)

    # ── web UI ──────────────────────────────────────────────────────────
    @app.middleware("http")
    async def no_cache_ui(request: Request, call_next):
        response = await call_next(request)
        if not request.url.path.startswith("/api/") and "/vendor/" not in request.url.path:
            response.headers.setdefault("Cache-Control", "no-cache")
        return response

    @app.get("/api/{rest:path}")
    async def api_404(rest: str):
        return PlainTextResponse("Not found", status_code=404)

    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="ui")
    return app
