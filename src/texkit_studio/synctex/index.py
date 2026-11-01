"""Click-to-jump between source and PDF, from the engine's .synctex.gz file.

Records look like `(tag,line:x,y:W,H,D` (hbox), `[...` (vbox), `h`/`v` (void boxes),
`k`/`g`/`$`/`x` (kern, glue, math, point). Coordinates are in TeX scaled points measured
from the page's top-left corner; we convert them to PDF points (1/72 in).
"""

from __future__ import annotations

import gzip
import re
from dataclasses import dataclass
from pathlib import Path

_RECORD = re.compile(r"^([\[\(hvkg$x])(\d+),(\d+)(?:,\d+)?:(-?\d+),(-?\d+)(?::(-?\d+)(?:,(-?\d+),(-?\d+))?)?")
SP_PER_BP = 65781.76  # 65536 sp per TeX point × 72.27 / 72


@dataclass(frozen=True)
class Box:
    kind: str
    tag: int
    line: int
    x: float
    y: float  # baseline
    w: float
    h: float
    d: float

    @property
    def top(self) -> float:
        return self.y - self.h

    @property
    def bottom(self) -> float:
        return self.y + self.d


class SyncIndex:
    def __init__(self, files: dict[int, str], pages: dict[int, list[Box]]):
        self.files = files  # tag -> project-relative path
        self.pages = pages  # 1-based page -> boxes

    # ── loading ─────────────────────────────────────────────────────────
    @classmethod
    def load(cls, path: Path, root: Path) -> SyncIndex | None:
        try:
            with gzip.open(path, "rt", encoding="utf-8", errors="replace") as fh:
                text = fh.read()
        except OSError:
            return None
        unit, mag, x_off, y_off = 1.0, 1000.0, 0.0, 0.0
        files: dict[int, str] = {}
        pages: dict[int, list[Box]] = {}
        page = 0
        in_content = False
        root_res = root.resolve()
        for line in text.splitlines():
            if not in_content:
                if line.startswith("Input:"):
                    _, tag, name = line.split(":", 2)
                    rel = _relative(name, root_res)
                    if rel:
                        files[int(tag)] = rel
                elif line.startswith("Unit:"):
                    unit = float(line[5:] or 1)
                elif line.startswith("Magnification:"):
                    mag = float(line[14:] or 1000)
                elif line.startswith("X Offset:"):
                    x_off = float(line[9:] or 0)
                elif line.startswith("Y Offset:"):
                    y_off = float(line[9:] or 0)
                elif line.startswith("Content:"):
                    in_content = True
                continue
            if line.startswith("Input:"):  # inputs can also appear mid-content
                _, tag, name = line.split(":", 2)
                rel = _relative(name, root_res)
                if rel:
                    files[int(tag)] = rel
                continue
            if line.startswith("{"):
                page = int(line[1:] or 0)
                pages.setdefault(page, [])
                continue
            m = _RECORD.match(line)
            if not m or not page:
                continue
            kind, tag, ln, x, y, w, h, d = m.groups()
            if int(tag) not in files:
                continue
            scale = unit * mag / 1000.0 / SP_PER_BP
            pages[page].append(Box(
                kind, int(tag), int(ln),
                (int(x) + x_off) * scale, (int(y) + y_off) * scale,
                int(w or 0) * scale, int(h or 0) * scale, int(d or 0) * scale,
            ))
        return cls(files, pages)

    # ── source → PDF ────────────────────────────────────────────────────
    def forward(self, file: str, line: int) -> dict | None:
        tags = {t for t, f in self.files.items() if f == file}
        if not tags:
            return None
        # Use the exact line if TeX recorded it, otherwise the closest earlier line.
        candidates: dict[int, list[tuple[int, Box]]] = {}
        best_line = None
        for page, boxes in self.pages.items():
            for b in boxes:
                if b.tag in tags and b.line <= line:
                    if best_line is None or b.line > best_line:
                        best_line = b.line
                        candidates = {}
                    if b.line == best_line:
                        candidates.setdefault(page, []).append((page, b))
        if best_line is None:
            return None
        page = min(candidates)
        boxes = [b for _, b in candidates[page]]
        lines = [b for b in boxes if b.kind == "(" and b.w > 0] or boxes
        # Small records (a citation, a kern) are hard to spot: widen them to the text line that holds them.
        hboxes = [b for b in self.pages[page] if b.kind == "(" and b.w >= 40]
        widened = []
        for b in lines:
            if b.w < 40:
                holder = [hb for hb in hboxes if hb.x <= b.x <= hb.x + hb.w and hb.top - 1 <= b.y <= hb.bottom + 1]
                b = min(holder, key=lambda hb: hb.w) if holder else b
            widened.append(b)
        lines = widened
        rects = []
        for b in lines:
            h = b.h + b.d if (b.h + b.d) > 0 else 10.0
            rects.append({"x": round(b.x, 2), "y": round(b.y - (b.h if b.h > 0 else 8.0), 2),
                          "w": round(max(b.w, 4.0), 2), "h": round(h, 2)})
        return {"page": page, "rects": _merge(rects)[:12]}

    # ── PDF → source ────────────────────────────────────────────────────
    def inverse(self, page: int, x: float, y: float) -> dict | None:
        boxes = self.pages.get(page) or []
        inside = [b for b in boxes if b.kind == "(" and b.w > 0 and b.x <= x <= b.x + b.w and b.top - 1 <= y <= b.bottom + 1]
        if inside:
            line_box = min(inside, key=lambda b: b.w * max(b.h + b.d, 1))
            # A line's box is tagged where TeX *finished* the paragraph (often the next command,
            # even in another file). The glue/kern records inside the line carry the real source
            # position of each word, so prefer the nearest of those.
            words = [b for b in boxes if b.kind in "gk$xh" and line_box.top - 1 <= b.y <= line_box.bottom + 1
                     and line_box.x - 1 <= b.x <= line_box.x + line_box.w + 1]
            b = min(words, key=lambda b: abs(b.x - x)) if words else line_box
        else:
            near = [b for b in boxes if b.kind in "(hkg$x"]
            if not near:
                return None

            def dist(b: Box) -> float:
                dx = 0.0 if b.x <= x <= b.x + b.w else min(abs(x - b.x), abs(x - b.x - b.w))
                dy = 0.0 if b.top <= y <= b.bottom else min(abs(y - b.top), abs(y - b.bottom))
                return dy * 3 + dx

            b = min(near, key=dist)
        return {"file": self.files[b.tag], "line": b.line}


def _relative(name: str, root: Path) -> str | None:
    name = name.strip()
    if not name:
        return None
    try:
        p = Path(name.replace("\\", "/"))
        if not p.is_absolute():
            p = root / p
        rel = p.resolve().relative_to(root).as_posix()
    except (ValueError, OSError):
        return None
    if not rel.endswith(".tex") and (root / f"{rel}.tex").is_file():
        rel += ".tex"
    return rel


def _merge(rects: list[dict]) -> list[dict]:
    """Join boxes on the same text line into one highlight."""
    rects = sorted(rects, key=lambda r: (round(r["y"]), r["x"]))
    out: list[dict] = []
    for r in rects:
        last = out[-1] if out else None
        if last and abs(last["y"] - r["y"]) < 2 and r["x"] <= last["x"] + last["w"] + 2:
            right = max(last["x"] + last["w"], r["x"] + r["w"])
            last["w"] = round(right - last["x"], 2)
            last["h"] = max(last["h"], r["h"])
        else:
            out.append(dict(r))
    return out
