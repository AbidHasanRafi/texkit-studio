"""Command line entry point.

    texkit                 open the studio on the current folder
    texkit PATH            open another folder (or the folder of a .tex file)
    texkit compile PATH    compile without the UI and print any problems
    texkit format [PATH]   tidy .tex and .bib files, like Prettier (--check for CI)
    texkit prepare-offline download packages so the templates compile offline
    texkit doctor          check that everything needed is in place
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import secrets
import socket
import sys
import threading
import urllib.request
import webbrowser
from pathlib import Path

from . import _term as term
from . import config
from ._meta import COMMAND, PRODUCT_NAME, TAGLINE, __version__

DEFAULT_PORT = 8765


def _print(msg: str = "") -> None:
    try:
        print(msg, flush=True)
    except UnicodeEncodeError:
        print(msg.encode("ascii", "replace").decode(), flush=True)


def _resolve_target(arg: str | None) -> Path:
    if arg:
        p = Path(arg).expanduser().resolve()
        if p.is_file() and p.suffix.lower() == ".tex":
            return p.parent
        if p.is_file() and p.suffix.lower() == ".zip":
            from .core import tools

            dest = tools.unique_folder(p.parent, p.stem)
            try:
                tools.import_zip(p.read_bytes(), dest)
            except ValueError as exc:
                raise SystemExit(f"{COMMAND}: {exc}")
            _print(f"Extracted {p.name} to {dest}")
            return dest
        if not p.is_dir():
            raise SystemExit(f"{COMMAND}: not a folder: {p}")
        return p
    cwd = Path.cwd().resolve()
    if cwd == Path.home().resolve():
        # Launched from a shortcut or a fresh terminal: reopen the last folder instead of $HOME.
        recent = config.recent_folders()
        if recent:
            return Path(recent[0])
    return cwd


def _port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def _pick_port(preferred: int) -> int:
    if _port_free(preferred):
        return preferred
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _running_instance() -> dict | None:
    inst = config.read_instance()
    if not inst:
        return None
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{inst['port']}/api/health", timeout=1.5) as resp:
            if json.loads(resp.read()).get("app") == "texkit-studio":
                return inst
    except Exception:
        pass
    return None


def _switch_running(inst: dict, folder: Path) -> bool:
    req = urllib.request.Request(
        f"http://127.0.0.1:{inst['port']}/api/session/root",
        data=json.dumps({"path": str(folder)}).encode(),
        headers={"Content-Type": "application/json", "Cookie": f"texkit_session={inst['token']}",
                 "Host": f"127.0.0.1:{inst['port']}"},
        method="POST",
    )
    try:
        urllib.request.urlopen(req, timeout=5).read()
        return True
    except Exception:
        return False


def serve(args: argparse.Namespace) -> int:
    folder = _resolve_target(args.path)
    inst = _running_instance()
    if inst:
        _switch_running(inst, folder)
        url = f"http://127.0.0.1:{inst['port']}/auth?token={inst['token']}"
        _print(f"\n  {term.mark('ok')} {term.bold(PRODUCT_NAME)} is {term.good('already running')} {term.dim('- switched it to your folder')}")
        _print(term.row("Folder", str(folder)))
        _print(term.row("Open", term.link(url)) + "\n")
        if not args.no_browser:
            webbrowser.open(url)
        return 0

    import uvicorn

    from .core.studio import Studio
    from .server.app import create_app

    port = _pick_port(args.port)
    token = secrets.token_urlsafe(32)
    studio = Studio(folder, token, port)
    config.add_recent(folder)
    app = create_app(studio)
    url = f"http://127.0.0.1:{port}/auth?token={token}"

    # Open browser tabs keep event streams alive; don't let them hold up Ctrl+C for long.
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", ws="auto",
                                           timeout_graceful_shutdown=2))

    def open_browser() -> None:
        while not server.started:
            if server.should_exit:
                return
            threading.Event().wait(0.05)
        if not args.no_browser:
            webbrowser.open(url)

    config.write_instance(port, token)
    title, version = PRODUCT_NAME, f"v{__version__}"
    gap = max(2, len(TAGLINE) - len(title) - len(version))
    _print("\n" + term.panel([
        (f"{title}{' ' * gap}{version}", f"{term.bold(term.accent(title))}{' ' * gap}{term.dim(version)}"),
        (TAGLINE, term.dim(TAGLINE)),
    ]) + "\n")
    _print(term.row("Folder", str(folder)))
    _print(term.row("Open", term.link(url)))
    _print(f"\n  {term.mark('ok')} {term.good('Ready.')} " + (
        "Your browser should open in a moment." if not args.no_browser else "Open the address above in your browser."))
    _print(f"  {term.dim('Press')} {term.bold('Ctrl+C')} {term.dim('to stop.')}\n")
    threading.Thread(target=open_browser, daemon=True).start()
    try:
        server.run()
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass  # Ctrl+C is the normal way to stop; uvicorn has already shut down cleanly
    finally:
        config.clear_instance()
    _print(f"\n  {term.mark('ok')} {term.bold(PRODUCT_NAME)} stopped. {term.dim('Your files are in ' + str(folder))}")
    _print(f"  {term.dim('Run')} {term.accent(COMMAND)} {term.dim('to open it again.')}\n")
    return 0


def compile_cmd(args: argparse.Namespace) -> int:
    from .core.studio import Studio

    from .core import project

    folder = _resolve_target(args.path)
    studio = Studio(folder, "cli")
    main = None
    if args.path and Path(args.path).suffix.lower() == ".tex":
        rel = Path(args.path).resolve().relative_to(folder).as_posix()
        # A full document compiles as itself; a chapter file follows its % !TEX root.
        main = rel if project.is_document(folder / rel) else project.magic_root(folder, rel)
    _print(f"\n  {term.mark('step')} Compiling {term.bold(str(main or project.detect_main(folder) or folder))} {term.dim('...')}\n")
    result = asyncio.run(studio.compiler.compile(main=main))
    return _report(result, studio)


def _report(result: dict, studio) -> int:
    for issue in result.get("issues", []):
        where = f"{issue.get('file', '')}:{issue['line']}" if issue.get("line") else issue.get("file", "")
        kind, label, colour = {"error": ("error", "error", term.bad), "warning": ("warn", "warning", term.warn),
                               "info": ("info", "note", term.accent)}[issue["severity"]]
        _print(f"  {term.mark(kind)} {colour(label)}  {term.dim(where + '  ') if where else ''}{issue.get('title') or issue['raw']}")
        if issue.get("explanation"):
            _print(f"      {term.dim(issue['explanation'])}")
    status = result.get("status")
    seconds = result.get("durationMs", 0) / 1000
    if status == "ok":
        _print(f"\n  {term.mark('ok')} {term.good('Compiled')} {term.dim(f'in {seconds:.1f}s')}")
    else:
        _print(f"\n  {term.mark('error')} {term.bad('Finished with problems')}")
    if result.get("hasPdf") and status in ("ok", "errors"):
        _print(term.row("PDF", str(studio.compiler.output_pdf()), 4))
    _print()
    return 0 if status == "ok" else 1


def prepare_offline(_args: argparse.Namespace) -> int:
    from .engine import offline

    _print(f"\n  {term.mark('step')} Downloading the LaTeX packages the built-in templates use, so they compile offline {term.dim('...')}\n")
    results = offline.prepare(lambda i, n, name: name != "done" and _print(f"  {term.dim(f'[{i + 1}/{n}]')} {name}"))
    failed = [r for r in results if not r["ok"]]
    for r in failed:
        _print(f"  {term.mark('error')} could not prepare {term.bold(r['template'])}: {term.dim(r['detail'].strip()[-200:])}")
    _print(f"\n  {term.mark('ok')} {term.good('Done.')} You can now compile these templates without internet.\n" if not failed
           else f"\n  {term.mark('warn')} {term.warn('Finished with problems.')}\n")
    return 1 if failed else 0


def doctor(_args: argparse.Namespace) -> int:
    from .compile.eps import find_ghostscript
    from .core.export import pandoc_path
    from .engine import tectonic
    from .engine.system_tex import find as find_system_tex

    ok = True
    _print(f"\n  {term.bold(term.accent(PRODUCT_NAME))} {term.dim('v' + __version__ + ' on Python ' + sys.version.split()[0] + ' (' + sys.platform + ')')}\n")
    _print(term.row("Data folder", str(config.DATA_DIR), 13))
    _print(term.row("Build cache", str(config.CACHE_DIR), 13) + "\n")
    exe = tectonic.find()
    if exe:
        _print(f"  {term.mark('ok')} {'LaTeX engine'.ljust(13)} Tectonic {tectonic.version(exe) or '?'} {term.dim('at ' + str(exe))}")
    else:
        _print(f"  {term.mark('info')} {'LaTeX engine'.ljust(13)} {term.dim(f'not downloaded yet (Tectonic {tectonic.VERSION} is fetched on first compile)')}")
    managed = tectonic.cache_dir()
    if managed and (managed / ".texkit-seeded").is_file():
        _print(f"  {term.mark('ok')} {'Packages'.ljust(13)} {term.dim(f'LaTeX packages ready for offline use ({tectonic.cache_size() / 1e6:.0f} MB at {managed})')}")
    elif managed and tectonic.BUNDLED_SEED.is_file():
        _print(f"  {term.mark('info')} {'Packages'.ljust(13)} {term.dim('bundled with this install, unpacked on the first compile')}")
    else:
        _print(f"  {term.mark('info')} {'Packages'.ljust(13)} {term.dim('downloaded on first use, then cached (run `texkit prepare-offline` to fetch ahead)')}")
    pandoc = pandoc_path()
    if pandoc:
        _print(f"  {term.mark('ok')} {'Word export'.ljust(13)} Pandoc {term.dim('at ' + pandoc)}")
    else:
        _print(f"  {term.mark('error')} {'Word export'.ljust(13)} {term.bad('Pandoc not found')}")
    ok = ok and bool(pandoc)
    tex = find_system_tex()
    if tex:
        engines = ", ".join(e for e in ("pdflatex", "xelatex", "lualatex") if tex.tool(e))
        _print(f"  {term.mark('ok')} {'Full TeX'.ljust(13)} {engines} {term.dim('at ' + str(Path(tex.tools[next(e for e in ('pdflatex', 'xelatex', 'lualatex') if tex.tool(e))]).parent))}")
    else:
        _print(f"  {term.mark('info')} {'Full TeX'.ljust(13)} {term.dim('none found: optional, used automatically for documents that need Biber, an index, minted, newer packages (TeX Live or MiKTeX)')}")
    gs = find_ghostscript()
    if gs:
        _print(f"  {term.mark('ok')} {'EPS images'.ljust(13)} Ghostscript {term.dim('at ' + gs)}")
    else:
        _print(f"  {term.mark('info')} {'EPS images'.ljust(13)} {term.dim('no Ghostscript: .eps files need a name-eps-converted-to.pdf next to them (optional: install Ghostscript)')}")
    _print(f"\n  {term.mark('ok')} {term.good('Everything is in place.')}\n" if ok else f"\n  {term.mark('warn')} {term.warn('Some things need attention.')}\n")
    return 0 if ok else 1


def format_cmd(args: argparse.Namespace) -> int:
    """Format .tex and .bib files in place, like `prettier --write` (or `--check`)."""
    from .core.formatter import FormatError, Options, format_text, kind_for
    from .core.safefs import atomic_write, is_hidden

    targets = [Path(p).expanduser() for p in (args.paths or ["."])]
    files: list[Path] = []
    for t in targets:
        if t.is_dir():
            for p in sorted(t.rglob("*")):
                if p.is_file() and kind_for(p.name) and not any(is_hidden(x) for x in p.relative_to(t).parts):
                    files.append(p)
        elif t.is_file():
            files.append(t)
        else:
            _print(f"{COMMAND} format: no such file or folder: {t}")
            return 2
    opts = Options(indent=args.indent, align_tables=not args.no_align)
    changed, failed = [], []
    for f in files:
        if not kind_for(f.name):
            continue
        raw = f.read_bytes()
        try:
            text = raw.decode("utf-8-sig")
        except UnicodeDecodeError:
            failed.append((f, "not UTF-8"))
            continue
        try:
            out = format_text(text, f.name, opts)
        except FormatError as exc:
            failed.append((f, str(exc)))
            continue
        if out != text:
            changed.append(f)
            if not args.check:
                bom = b"\xef\xbb\xbf" if raw.startswith(b"\xef\xbb\xbf") else b""
                atomic_write(f, bom + out.encode("utf-8"))
    for f in changed:
        _print(f"  {term.mark('warn' if args.check else 'ok')} {'would format' if args.check else 'formatted'}  {f}")
    for f, why in failed:
        _print(f"  {term.mark('error')} skipped  {f} {term.dim('(' + why + ')')}")
    total = len([f for f in files if kind_for(f.name)])
    if args.check:
        _print(f"\n  {term.mark('warn')} {term.warn(f'{len(changed)} of {total} files need formatting.')}\n" if changed
               else f"\n  {term.mark('ok')} {term.good(f'All {total} files are formatted.')}\n")
        return 1 if changed or failed else 0
    _print(f"\n  {term.mark('ok')} {term.good(f'Formatted {len(changed)} of {total} files.')}\n" if changed
           else f"\n  {term.mark('ok')} {term.good(f'All {total} files were already formatted.')}\n")
    return 1 if failed else 0


def main(argv: list[str] | None = None) -> int:
    try:
        return _main(argv)
    except KeyboardInterrupt:
        _print(f"\n  {term.mark('warn')} {term.warn('Cancelled.')}\n")
        return 130  # the conventional exit status for Ctrl+C


def _main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if os.name == "nt":
        try:
            sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
        except Exception:
            pass

    if argv and argv[0] == "compile":
        p = argparse.ArgumentParser(prog=f"{COMMAND} compile", description="Compile without opening the studio.")
        p.add_argument("path", nargs="?", help="folder or .tex file (default: current folder)")
        return compile_cmd(p.parse_args(argv[1:]))
    if argv and argv[0] == "doctor":
        p = argparse.ArgumentParser(prog=f"{COMMAND} doctor", description="Check the installation.")
        return doctor(p.parse_args(argv[1:]))
    if argv and argv[0] == "prepare-offline":
        p = argparse.ArgumentParser(prog=f"{COMMAND} prepare-offline", description="Download packages for offline use.")
        return prepare_offline(p.parse_args(argv[1:]))
    if argv and argv[0] == "format":
        p = argparse.ArgumentParser(prog=f"{COMMAND} format",
                                    description="Tidy .tex and .bib files: indentation, aligned tables, tidy bibliography entries. "
                                                "Only whitespace changes in .tex files, so the PDF stays exactly the same.")
        p.add_argument("paths", nargs="*", help="files or folders (default: the current folder)")
        p.add_argument("--check", action="store_true", help="don't change anything; exit 1 if files need formatting (for CI)")
        p.add_argument("--indent", type=int, default=2, choices=range(0, 9), metavar="N", help="spaces per level (default 2)")
        p.add_argument("--no-align", action="store_true", help="don't line up table columns")
        return format_cmd(p.parse_args(argv[1:]))

    p = argparse.ArgumentParser(
        prog=COMMAND,
        description=f"{PRODUCT_NAME}: {TAGLINE}",
        epilog=f"Other commands: '{COMMAND} compile [PATH]', '{COMMAND} format [PATH] [--check]', "
               f"'{COMMAND} prepare-offline', '{COMMAND} doctor'.",
    )
    p.add_argument("path", nargs="?", help="folder to open (default: the current folder)")
    p.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"port to use (default {DEFAULT_PORT})")
    p.add_argument("--no-browser", action="store_true", help="don't open a browser tab")
    p.add_argument("--version", action="version", version=f"{PRODUCT_NAME} {__version__}")
    return serve(p.parse_args(argv))


if __name__ == "__main__":
    raise SystemExit(main())
