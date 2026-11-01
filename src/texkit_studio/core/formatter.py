"""A Prettier-style formatter for LaTeX and BibTeX.

LaTeX: only whitespace changes, so the output always typesets exactly like the input.
  * indents the contents of environments and of multi-line {...} groups,
  * indents the text of each \\item under it,
  * lines up the & columns of tables and aligned equations,
  * removes trailing spaces and squeezes runs of blank lines,
  * leaves verbatim-like environments (verbatim, lstlisting, minted, ...) untouched.
BibTeX: one field per line, aligned `=`, lower-case field names, {braces} kept as written.
"""

from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass
class Options:
    indent: int = 2
    align_tables: bool = True
    max_blank_lines: int = 1
    indent_document: bool = False  # most papers keep the body of \begin{document} flush left


VERBATIM = {"verbatim", "verbatim*", "Verbatim", "BVerbatim", "lstlisting", "minted", "comment",
            "filecontents", "filecontents*", "alltt", "spverbatim"}
FLUSH = {"document"}
ALIGN = {"tabular", "tabular*", "tabularx", "tabulary", "longtable", "longtable*", "array", "matrix", "pmatrix",
         "bmatrix", "Bmatrix", "vmatrix", "Vmatrix", "smallmatrix", "align", "align*", "alignat", "alignat*",
         "flalign", "flalign*", "eqnarray", "eqnarray*", "split", "aligned", "alignedat", "cases", "dcases", "tblr"}
LISTS = {"itemize", "enumerate", "description", "list", "compactitem", "compactenum"}
MAX_ALIGN_WIDTH = 40

_TOKEN = re.compile(r"\\(begin|end)\s*\{([^}]+)\}|(?<!\\)\\\[|(?<!\\)\\\]|(?<!\\)[{}]")
_COMMENT = re.compile(r"(?<!\\)%")


class FormatError(ValueError):
    pass


# ── LaTeX ──────────────────────────────────────────────────────────────
def _code(line: str) -> str:
    """The part of a line before an unescaped % comment."""
    m = _COMMENT.search(line)
    return line[: m.start()] if m else line


def format_tex(text: str, opts: Options | None = None) -> str:
    opts = opts or Options()
    crlf = "\r\n" in text
    lines = text.replace("\r\n", "\n").split("\n")
    unit = " " * opts.indent

    out: list[str] = []
    meta: list[tuple | None] = []  # per output line: (align block id) for the table pass
    stack: list[dict] = []  # open environments: {name, indents, id, item}
    braces = 0  # open { groups that span lines
    verbatim: str | None = None
    blanks = 0
    env_id = 0

    def depth() -> int:
        return sum(1 for e in stack if e["indents"]) + sum(1 for e in stack if e.get("item")) + braces

    for raw in lines:
        if verbatim:
            out.append(raw)  # verbatim content, including its \end line, is never changed
            meta.append(None)
            if re.search(rf"\\end\s*\{{{re.escape(verbatim)}\}}", raw):
                verbatim = None
            continue

        line = raw.strip()
        if not line:
            blanks += 1
            if out and blanks <= opts.max_blank_lines:
                out.append("")
                meta.append(None)
            continue
        blanks = 0

        code = _code(line)
        tokens = list(_TOKEN.finditer(code))

        # Dedent this line if it *starts* by closing something.
        level = depth()
        first = tokens[0] if tokens and tokens[0].start() == 0 else None
        if first is not None:
            if first.group(1) == "end" and stack and stack[-1]["name"] == first.group(2).strip():
                top = stack[-1]
                level -= (1 if top["indents"] else 0) + (1 if top.get("item") else 0)
            elif first.group(0) == "}" and braces > 0:
                level -= 1
            elif first.group(0) == "\\]" and stack and stack[-1]["name"] == "\\[":
                level -= 1
        top = stack[-1] if stack else None
        if top and top["name"] in LISTS and re.match(r"\\item\b", line) and top.get("item"):
            level -= 1  # \item itself sits at the list's level; its text is one deeper
        out.append(unit * max(level, 0) + line)
        meta.append(("align", top["id"]) if top and top["name"] in ALIGN and opts.align_tables else None)

        # Update the state from every token on the line.
        for t in tokens:
            kind, name = t.group(1), (t.group(2) or "").strip()
            if kind == "begin":
                if name in VERBATIM:
                    if not re.search(rf"\\end\s*\{{{re.escape(name)}\}}", code[t.end():]):
                        verbatim = name
                    break
                env_id += 1
                stack.append({"name": name, "indents": opts.indent_document or name not in FLUSH, "id": env_id, "braces": braces})
                braces = 0
            elif kind == "end":
                for k in range(len(stack) - 1, -1, -1):
                    if stack[k]["name"] == name:
                        braces = stack[k]["braces"]
                        del stack[k:]
                        break
            elif t.group(0) == "\\[":
                env_id += 1
                stack.append({"name": "\\[", "indents": True, "id": env_id, "braces": braces})
                braces = 0
            elif t.group(0) == "\\]":
                if stack and stack[-1]["name"] == "\\[":
                    braces = stack.pop()["braces"]
            elif t.group(0) == "{":
                braces += 1
            elif t.group(0) == "}":
                braces = max(0, braces - 1)
        if stack and stack[-1]["name"] in LISTS and re.match(r"\\item\b", line):
            stack[-1]["item"] = True

    while out and out[-1] == "":
        out.pop()
        meta.pop()

    if opts.align_tables:
        _align(out, meta)

    result = "\n".join(out) + "\n"
    return result.replace("\n", "\r\n") if crlf else result


def _split_cells(code: str) -> list[str] | None:
    """Split a table row on & outside braces. None if there's nothing to split."""
    cells, depth, start = [], 0, 0
    i = 0
    while i < len(code):
        ch = code[i]
        if ch == "\\":
            i += 2
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
        elif ch == "&" and depth == 0:
            cells.append(code[start:i])
            start = i + 1
        i += 1
    if not cells:
        return None
    cells.append(code[start:])
    return [c.strip() for c in cells]


def _align(out: list[str], meta: list) -> None:
    i = 0
    while i < len(out):
        if not meta[i]:
            i += 1
            continue
        block = meta[i]
        j = i
        while j < len(out) and meta[j] == block:
            j += 1
        rows = {}
        for k in range(i, j):
            stripped = out[k].lstrip()
            indent = out[k][: len(out[k]) - len(stripped)]
            m = _COMMENT.search(stripped)
            code, comment = (stripped[: m.start()], stripped[m.start():]) if m else (stripped, "")
            cells = _split_cells(code)
            if cells and len(cells) > 1:
                rows[k] = (indent, cells, comment)
        if rows:
            ncols = max(len(c) for _, c, _ in rows.values())
            widths = [0] * ncols
            for _, cells, _ in rows.values():
                if any("\\multicolumn" in c for c in cells):
                    continue  # a merged cell spans columns: it shouldn't widen just the first one
                for c, cell in enumerate(cells[:-1]):  # the last cell (with \\) isn't padded
                    widths[c] = max(widths[c], len(cell))
            if max(widths) <= MAX_ALIGN_WIDTH:
                for k, (indent, cells, comment) in rows.items():
                    spans = any("\\multicolumn" in c for c in cells)
                    parts = [cell.ljust(widths[c]) if c < len(cells) - 1 and not spans else cell for c, cell in enumerate(cells)]
                    parts[-1] = re.sub(r"(?<=[^\s\\])(\\\\)", r" \1", parts[-1], count=1)  # "3.4\\" -> "3.4 \\"
                    row = " & ".join(parts).rstrip()
                    out[k] = indent + row + (f" {comment}" if comment else "")
        i = j


# ── BibTeX ─────────────────────────────────────────────────────────────
_ENTRY_START = re.compile(r"@(\w+)\s*([{(])")


def _match_close(text: str, start: int, open_ch: str) -> int:
    close_ch = "}" if open_ch == "{" else ")"
    depth, i, in_quote = 0, start, False
    while i < len(text):
        ch = text[i]
        if ch == "\\":
            i += 2
            continue
        if ch == '"' and depth == 1:
            in_quote = not in_quote
        elif not in_quote:
            if ch in "{(" and (ch == open_ch or ch == "{"):
                depth += 1
            elif ch in "})" and (ch == close_ch or ch == "}"):
                depth -= 1
                if depth == 0:
                    return i
        i += 1
    raise FormatError("A bibliography entry isn't closed. Check for a missing } in the .bib file.")


def _split_fields(body: str) -> list[str]:
    parts, depth, start, in_quote, i = [], 0, 0, False, 0
    while i < len(body):
        ch = body[i]
        if ch == "\\":
            i += 2
            continue
        if ch == '"' and depth == 0:
            in_quote = not in_quote
        elif not in_quote:
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
            elif ch == "," and depth == 0:
                parts.append(body[start:i])
                start = i + 1
        i += 1
    parts.append(body[start:])
    return [p.strip() for p in parts if p.strip()]


def format_bib(text: str, opts: Options | None = None) -> str:
    opts = opts or Options()
    crlf = "\r\n" in text
    text = text.replace("\r\n", "\n")
    unit = " " * opts.indent
    chunks: list[str] = []
    pos = 0
    for m in _ENTRY_START.finditer(text):
        if m.start() < pos:
            continue
        between = text[pos:m.start()].strip()
        if between:
            chunks.append("\n".join(line.rstrip() for line in between.split("\n")))
        end = _match_close(text, m.end() - 1, m.group(2))
        kind = m.group(1)
        inner = text[m.end():end]
        pos = end + 1
        if kind.lower() in ("string", "preamble", "comment"):
            chunks.append(f"@{kind}{m.group(2)}{inner.strip()}{'}' if m.group(2) == '{' else ')'}")
            continue
        fields = _split_fields(inner)
        if not fields:
            chunks.append(text[m.start():pos].strip())
            continue
        key, rest = fields[0], fields[1:]
        parsed = []
        for f in rest:
            if "=" not in f:
                raise FormatError(f"Entry {key}: “{f[:30]}” isn't a field (name = value).")
            name, value = f.split("=", 1)
            value = re.sub(r"\s+", " ", value.strip())
            parsed.append((name.strip().lower(), value))
        width = max((len(n) for n, _ in parsed), default=0)
        body = "".join(f"{unit}{n.ljust(width)} = {v},\n" for n, v in parsed)
        chunks.append(f"@{kind.lower()}{{{key},\n{body}}}")
    tail = text[pos:].strip()
    if tail:
        chunks.append("\n".join(line.rstrip() for line in tail.split("\n")))
    result = "\n\n".join(chunks) + "\n"
    return result.replace("\n", "\r\n") if crlf else result


# ── Dispatch ───────────────────────────────────────────────────────────
TEX_SUFFIXES = {".tex", ".sty", ".cls", ".ltx", ".dtx", ".tikz"}


def kind_for(path: str) -> str | None:
    p = path.lower()
    if p.endswith(".bib"):
        return "bib"
    if any(p.endswith(s) for s in TEX_SUFFIXES):
        return "tex"
    return None


def format_text(text: str, path: str, opts: Options | None = None) -> str:
    kind = kind_for(path)
    if kind == "bib":
        return format_bib(text, opts)
    if kind == "tex":
        return format_tex(text, opts)
    raise FormatError("Formatting works for .tex and .bib files.")
