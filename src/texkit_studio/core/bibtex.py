"""A small, forgiving BibTeX reader: entry keys, types, a few display fields, and line numbers."""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass

_ENTRY = re.compile(r"@(\w+)\s*[{(]\s*([^,\s]+)\s*,", re.M)
_SKIP = {"string", "comment", "preamble"}


@dataclass
class Entry:
    key: str
    type: str
    file: str
    line: int
    title: str = ""
    author: str = ""
    year: str = ""

    def to_dict(self) -> dict:
        return asdict(self)

    @property
    def short(self) -> str:
        """'Knuth (1984)' style label for lists."""
        first = self.author.split(" and ")[0].strip()
        last = first.split(",")[0].strip() if "," in first else (first.split()[-1] if first else "")
        many = " et al." if self.author.count(" and ") >= 2 else (" and others" if " and others" in self.author else "")
        if " and " in self.author and not many:
            second = self.author.split(" and ")[1].strip()
            last2 = second.split(",")[0].strip() if "," in second else (second.split()[-1] if second else "")
            names = f"{last} and {last2}"
        else:
            names = f"{last}{many}"
        return f"{names} ({self.year})" if self.year else names


def _clean(value: str) -> str:
    for logo in ("LaTeX", "TeX", "BibTeX", "XeTeX"):
        value = re.sub(rf"\\{logo}\b\s*(\{{\}})?", logo, value)
    value = re.sub(r"\\[a-zA-Z]+\s*", "", value)
    value = value.replace("{", "").replace("}", "").replace("~", " ")
    return re.sub(r"\s+", " ", value).strip()


def _field(body: str, name: str) -> str:
    m = re.search(rf"\b{name}\s*=\s*", body, re.I)
    if not m:
        return ""
    rest = body[m.end():]
    if rest.startswith("{"):
        depth, out = 0, []
        for ch in rest:
            if ch == "{":
                depth += 1
                if depth == 1:
                    continue
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    break
            out.append(ch)
        return _clean("".join(out))
    if rest.startswith('"'):
        end = rest.find('"', 1)
        return _clean(rest[1:end if end > 0 else None])
    m2 = re.match(r"[\w.-]+", rest)
    return m2.group(0) if m2 else ""


def parse(text: str, file: str) -> list[Entry]:
    entries = []
    matches = list(_ENTRY.finditer(text))
    for i, m in enumerate(matches):
        kind = m.group(1).lower()
        if kind in _SKIP:
            continue
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        body = text[m.end():end]
        entries.append(Entry(
            key=m.group(2), type=kind, file=file, line=text.count("\n", 0, m.start()) + 1,
            title=_field(body, "title"), author=_field(body, "author") or _field(body, "editor"),
            year=_field(body, "year") or (_field(body, "date")[:4]),
        ))
    return entries


def make_key(author: str, year: str, title: str, taken: set[str]) -> str:
    """knuth1984tex style keys, unique within `taken`."""
    first = author.split(" and ")[0].strip()
    last = first.split(",")[0] if "," in first else (first.split()[-1] if first else "ref")
    word = next((w for w in re.findall(r"[A-Za-z]+", title) if w.lower() not in {"a", "an", "the", "on", "of", "and", "for", "in"}), "")
    base = re.sub(r"[^a-z0-9]", "", f"{last}{year}{word}".lower()) or "ref"
    key, n = base, 2
    while key in taken:
        key, n = f"{base}{chr(96 + n)}", n + 1
    return key
