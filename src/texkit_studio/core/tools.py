"""Smaller project utilities: search across files, ZIP import, citation lookup, submission export."""

from __future__ import annotations

import io
import os
import re
import shutil
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path, PurePosixPath

from .._meta import DIST_NAME, __version__
from . import bibtex
from .safefs import TEXT_EXTENSIONS, is_hidden

# ── Search across files ───────────────────────────────────────────────
MAX_RESULTS = 500


def search(root: Path, query: str, *, regex: bool = False, case: bool = False, whole: bool = False) -> dict:
    if not query:
        return {"results": [], "truncated": False}
    pattern = query if regex else re.escape(query)
    if whole:
        pattern = rf"(?<![\w\\]){pattern}(?!\w)"
    try:
        rx = re.compile(pattern, 0 if case else re.I)
    except re.error as exc:
        raise ValueError(f"That isn't a valid pattern: {exc}") from exc
    results = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if not is_hidden(d))
        for name in sorted(filenames):
            p = Path(dirpath) / name
            if p.suffix.lower() not in TEXT_EXTENSIONS or is_hidden(name):
                continue
            try:
                text = p.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            rel = p.relative_to(root).as_posix()
            for i, line in enumerate(text.splitlines(), start=1):
                for m in rx.finditer(line):
                    results.append({"file": rel, "line": i, "col": m.start(), "len": max(1, m.end() - m.start()), "text": line[:300]})
                    if len(results) >= MAX_RESULTS:
                        return {"results": results, "truncated": True}
    return {"results": results, "truncated": False}


# ── ZIP import (e.g. an Overleaf download) ─────────────────────────────
MAX_ZIP_BYTES = 500 * 1024 * 1024
MAX_ZIP_FILES = 5000


def import_zip(data: bytes, dest: Path) -> Path:
    """Extract a project zip into the new folder `dest`, refusing anything unsafe."""
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise ValueError("That file isn't a valid .zip archive.") from exc
    members = [m for m in zf.infolist() if not m.is_dir() and not m.filename.startswith("__MACOSX/")]
    if len(members) > MAX_ZIP_FILES:
        raise ValueError("That zip has too many files to be a LaTeX project.")
    if sum(m.file_size for m in members) > MAX_ZIP_BYTES:
        raise ValueError("That zip is too large to import (over 500 MB uncompressed).")
    names = [PurePosixPath(m.filename.replace("\\", "/")) for m in members]
    for n in names:
        if n.is_absolute() or ".." in n.parts or (n.parts and ":" in n.parts[0]):
            raise ValueError(f"The zip contains an unsafe path: {n}")
    # Overleaf and GitHub downloads wrap everything in one top-level folder: drop it.
    tops = {n.parts[0] for n in names}
    strip = len(tops) == 1 and all(len(n.parts) > 1 for n in names)
    dest.mkdir(parents=True, exist_ok=False)
    for m, n in zip(members, names):
        rel = PurePosixPath(*n.parts[1:]) if strip else n
        if not rel.parts or any(part in {".DS_Store"} for part in rel.parts):
            continue
        target = dest.joinpath(*rel.parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        with zf.open(m) as src, open(target, "wb") as out:
            shutil.copyfileobj(src, out)
    return dest


def unique_folder(parent: Path, name: str) -> Path:
    name = re.sub(r'[<>:"/\\|?*]', "-", name).strip(" .") or "project"
    candidate, n = parent / name, 2
    while candidate.exists():
        candidate, n = parent / f"{name}-{n}", n + 1
    return candidate


# ── Citation lookup by DOI or arXiv ID ────────────────────────────────
_DOI = re.compile(r"(10\.\d{4,9}/[^\s\"<>]+)", re.I)
_ARXIV = re.compile(r"(?:arxiv[:./\s]*(?:abs/|pdf/)?)?(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?/\d{7})", re.I)
USER_AGENT = f"{DIST_NAME}/{__version__} (citation lookup)"


class LookupError_(RuntimeError):
    pass


def _get(url: str, accept: str) -> str:
    req = urllib.request.Request(url, headers={"Accept": accept, "User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            raise LookupError_("No publication was found with that identifier.") from exc
        raise LookupError_(f"The lookup service answered with an error ({exc.code}). Try again later.") from exc
    except OSError as exc:
        raise LookupError_("Couldn't reach the lookup service. Check your internet connection.") from exc


def lookup(identifier: str, taken: set[str]) -> dict:
    """Return {'key', 'bibtex', 'title'} for a DOI, DOI URL, or arXiv ID/URL."""
    identifier = identifier.strip()
    doi = _DOI.search(identifier)
    if doi:
        text = _get("https://doi.org/" + urllib.parse.quote(doi.group(1).rstrip(".,;"), safe="/"), "application/x-bibtex; charset=utf-8")
        if "@" not in text:
            raise LookupError_("That DOI exists but has no citation data.")
        entries = bibtex.parse(text, "lookup")
        if not entries:
            raise LookupError_("That DOI exists but has no citation data.")
        e = entries[0]
        key = bibtex.make_key(e.author, e.year, e.title, taken)
        body = re.sub(r"^\s*@(\w+)\s*\{\s*[^,]+,", lambda m: f"@{m.group(1).lower()}{{{key},", text.strip(), count=1)
        body = re.sub(r",\s*(?=\w+\s*=)", ",\n  ", body)  # one field per line
        body = re.sub(r"\}\s*$", "\n}", body)
        return {"key": key, "bibtex": body + "\n", "title": e.title}
    arx = _ARXIV.search(identifier)
    if arx:
        arxiv_id = arx.group(1)
        xml = _get(f"https://export.arxiv.org/api/query?id_list={urllib.parse.quote(arxiv_id)}", "application/atom+xml")
        ns = {"a": "http://www.w3.org/2005/Atom", "x": "http://arxiv.org/schemas/atom"}
        root = ET.fromstring(xml)
        entry = root.find("a:entry", ns)
        title = entry.findtext("a:title", default="", namespaces=ns) if entry is not None else ""
        if entry is None or not title or title.strip() == "Error":
            raise LookupError_("No arXiv paper was found with that ID.")
        title = re.sub(r"\s+", " ", title).strip()
        authors = [a.findtext("a:name", default="", namespaces=ns).strip() for a in entry.findall("a:author", ns)]
        year = (entry.findtext("a:published", default="", namespaces=ns) or "")[:4]
        cat = entry.find("x:primary_category", ns)
        primary = cat.get("term") if cat is not None else ""
        bare = re.sub(r"v\d+$", "", arxiv_id)
        key = bibtex.make_key(" and ".join(authors), year, title, taken)
        fields = [("title", f"{{{title}}}"), ("author", "{" + " and ".join(authors) + "}"), ("year", f"{{{year}}}"),
                  ("eprint", f"{{{bare}}}"), ("archivePrefix", "{arXiv}")]
        if primary:
            fields.append(("primaryClass", f"{{{primary}}}"))
        fields.append(("url", f"{{https://arxiv.org/abs/{bare}}}"))
        body = f"@misc{{{key},\n" + ",\n".join(f"  {k} = {v}" for k, v in fields) + "\n}\n"
        return {"key": key, "bibtex": body, "title": title}
    raise LookupError_("Enter a DOI (like 10.1145/3292500.3330701) or an arXiv ID (like 2101.00001).")


# ── Submission package (arXiv and journals) ───────────────────────────
_INPUT = re.compile(r"\\(input|include)\s*\{([^}]+)\}")


def _strip_comments(text: str) -> str:
    out = []
    for line in text.splitlines():
        if re.match(r"^\s*%", line):
            continue  # whole-line comments go entirely
        out.append(re.sub(r"(?<!\\)%.*$", "%", line) if re.search(r"(?<!\\)%", line) else line)
    return "\n".join(out) + "\n"


def flatten(root: Path, rel: str, depth: int = 0) -> str:
    """Inline \\input and \\include so the paper is one .tex file."""
    path = root / rel
    text = path.read_text(encoding="utf-8-sig", errors="replace")

    def inline(m: re.Match) -> str:
        name = m.group(2).strip()
        for cand in (Path(rel).parent / name, Path(name)):
            for c in (cand, cand.with_name(cand.name + ".tex")):
                if (root / c).is_file() and depth < 12:
                    body = flatten(root, c.as_posix(), depth + 1)
                    return ("\\clearpage\n" if m.group(1) == "include" else "") + body
        return m.group(0)

    lines = []
    for line in text.splitlines():
        code = re.sub(r"(?<!\\)%.*$", "", line)
        lines.append(_INPUT.sub(inline, code) if _INPUT.search(code) else line)
    return "\n".join(lines) + "\n"


def submission_zip(root: Path, main: str, analysis: dict, bbl: Path | None, out: Path) -> Path:
    """One flattened .tex, its .bbl, the images it uses, and local style files, ready to upload."""
    out.parent.mkdir(parents=True, exist_ok=True)
    main_path = Path(main)
    tex = _strip_comments(flatten(root, main))
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(main_path.name, tex)
        if bbl and bbl.is_file():
            zf.write(bbl, main_path.with_suffix(".bbl").name)
        added = set()
        for g in analysis["graphics"]:
            if g["resolved"] and g["resolved"] not in added:
                added.add(g["resolved"])
                zf.write(root / g["resolved"], g["resolved"])
        for p in root.rglob("*"):
            if p.is_file() and p.suffix.lower() in {".sty", ".cls", ".bst", ".clo"} and not any(is_hidden(x) for x in p.relative_to(root).parts):
                zf.write(p, p.relative_to(root).as_posix())
    return out
