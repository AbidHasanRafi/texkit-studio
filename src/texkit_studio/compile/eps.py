"""Make `.eps` graphics work with Tectonic.

Tectonic is XeTeX-based, and its PDF writer (xdvipdfmx) cannot embed EPS files. Journal
templates use them anyway (MDPI's logos, for example), and pdfLaTeX, Overleaf and Prism cope by
running `epstopdf`, which needs shell-escape. Instead, before each compile we make sure every
`name.eps` in the project has a `name-eps-converted-to.pdf` that engine/tex/graphics.cfg can
include in its place:

1. One next to the EPS already (yours, or left by Overleaf or Prism) is used as it is.
2. Otherwise Ghostscript converts the EPS, if it's installed.
3. Otherwise a blank placeholder of the same size is made, so the compile still produces a PDF,
   and the caller reports which images are placeholders.

Generated files live in the build cache, never in the project folder.
"""

from __future__ import annotations

import glob
import json
import os
import re
import shutil
import struct
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

from ..core.safefs import atomic_write, is_hidden
from ..engine.tectonic import no_window

SUFFIX = "-eps-converted-to.pdf"
MAX_FILES = 500
GS_TIMEOUT = 60  # seconds per image
_NUM = r"(-?\d+(?:\.\d+)?)"
_BOX = re.compile(rf"^%%(Hi[Rr]es)?BoundingBox:\s*{_NUM}\s+{_NUM}\s+{_NUM}\s+{_NUM}", re.M)


@dataclass
class EpsReport:
    ghostscript: str | None = None
    converted: list[str] = field(default_factory=list)  # converted by Ghostscript this time
    placeholders: list[str] = field(default_factory=list)  # project-relative EPS paths with no real PDF
    reused: int = 0  # already had a PDF (yours, or converted earlier)


def find_ghostscript() -> str | None:
    """Locate Ghostscript: $TEXKIT_GS, then PATH, then the usual Windows install folders."""
    env = os.environ.get("TEXKIT_GS")
    if env and Path(env).is_file():
        return env
    for name in ("gswin64c", "gswin32c", "gs"):
        found = shutil.which(name)
        if found:
            return found
    if os.name == "nt":
        for base in (os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)"), os.environ.get("ProgramW6432")):
            if not base:
                continue
            hits = sorted(glob.glob(str(Path(base) / "gs" / "gs*" / "bin" / "gswin*c.exe")), reverse=True)
            if hits:
                return hits[0]
    return None


def bounding_box(path: Path) -> tuple[float, float, float, float]:
    """The EPS's bounding box (llx, lly, urx, ury); 72 x 72 pt when it can't be read."""
    try:
        with path.open("rb") as fh:
            head = fh.read(1 << 16)
            if head[:4] == b"\xc5\xd0\xd3\xc6":  # DOS EPS binary header: PostScript starts at an offset
                start, length = struct.unpack("<II", head[4:12])
                fh.seek(start)
                head = fh.read(min(length, 1 << 16))
            text = head.decode("latin-1")
            if "(atend)" in text:  # the real box is in the trailer
                fh.seek(0, os.SEEK_END)
                fh.seek(max(0, fh.tell() - (1 << 16)))
                text += "\n" + fh.read().decode("latin-1")
    except OSError:
        return (0, 0, 72, 72)
    boxes = _BOX.findall(text)
    # Prefer the precise HiRes box; ignore "(atend)" placeholders and empty boxes.
    for want_hires in (True, False):
        for hires, llx, lly, urx, ury in boxes:
            if bool(hires) == want_hires and float(urx) > float(llx) and float(ury) > float(lly):
                return float(llx), float(lly), float(urx), float(ury)
    return (0, 0, 72, 72)


def placeholder_pdf(width: float, height: float) -> bytes:
    """A one-page PDF of the given size: light grey with a border and a cross, so a placeholder is obvious."""
    w, h = max(width, 1.0), max(height, 1.0)
    content = (
        f"0.92 g 0 0 {w:.3f} {h:.3f} re f "
        f"0.5 G 0.6 w 0.3 0.3 {w - 0.6:.3f} {h - 0.6:.3f} re S "
        f"0 0 m {w:.3f} {h:.3f} l S 0 {h:.3f} m {w:.3f} 0 l S"
    ).encode("ascii")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {w:.3f} {h:.3f}] /Contents 4 0 R /Resources << >> >>".encode("ascii"),
        b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    for off in offsets:
        out += b"%010d 00000 n \n" % off
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)
    return bytes(out)


def _convert(gs: str, src: Path, dest: Path) -> bool:
    """Convert with Ghostscript the way epstopdf does (-dEPSCrop sizes the page to the bounding box)."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(suffix=".pdf", dir=dest.parent)
    os.close(fd)
    tmp = Path(tmp_name)
    cmd = [gs, "-q", "-dNOPAUSE", "-dBATCH", "-dSAFER", "-dEPSCrop", "-dAutoRotatePages=/None",
           "-sDEVICE=pdfwrite", "-dCompatibilityLevel=1.5", f"-sOutputFile={tmp}", str(src)]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=GS_TIMEOUT, stdin=subprocess.DEVNULL, **no_window())
        if proc.returncode == 0 and tmp.stat().st_size > 0:
            os.replace(tmp, dest)
            return True
    except (OSError, subprocess.SubprocessError):
        pass
    tmp.unlink(missing_ok=True)
    return False


def _eps_files(folder: Path) -> list[Path]:
    found: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(folder):
        dirnames[:] = [d for d in dirnames if not is_hidden(d)]
        for name in filenames:
            if name.lower().endswith(".eps"):
                found.append(Path(dirpath) / name)
                if len(found) >= MAX_FILES:
                    return found
    return found


def prepare(folder: Path, out_dir: Path) -> EpsReport:
    """Ensure each `.eps` under `folder` has a converted PDF, in `folder` or mirrored under `out_dir`.

    `folder` must be the directory TeX runs in, since \\includegraphics paths are relative to it.
    `out_dir` is passed to Tectonic as a search path; files in it mirror the project's layout.
    """
    report = EpsReport()
    files = _eps_files(folder)
    if not files:
        return report
    gs = find_ghostscript()
    report.ghostscript = gs
    for src in files:
        stem = src.name[:-4]
        if (src.parent / f"{stem}{SUFFIX}").is_file():
            report.reused += 1
            continue
        rel = src.relative_to(folder)
        dest = out_dir / rel.parent / f"{stem}{SUFFIX}"
        meta_path = dest.with_name(dest.name + ".json")
        st = src.stat()
        key = {"mtime": st.st_mtime_ns, "size": st.st_size}
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            meta = {}
        fresh = dest.is_file() and meta.get("mtime") == key["mtime"] and meta.get("size") == key["size"]
        # A placeholder is only worth keeping while there's still no Ghostscript to do better.
        if fresh and (meta.get("kind") == "ghostscript" or gs is None):
            if meta.get("kind") == "ghostscript":
                report.reused += 1
            else:
                report.placeholders.append(rel.as_posix())
            continue
        if gs and _convert(gs, src, dest):
            kind = "ghostscript"
            report.converted.append(rel.as_posix())
        else:
            llx, lly, urx, ury = bounding_box(src)
            atomic_write(dest, placeholder_pdf(urx - llx, ury - lly))
            kind = "placeholder"
            report.placeholders.append(rel.as_posix())
        atomic_write(meta_path, json.dumps({**key, "kind": kind}).encode("utf-8"))
    return report
