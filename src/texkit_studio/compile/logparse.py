"""Turn Tectonic's output and the TeX .log into structured issues.

Tectonic (run with `-Z continue-on-errors`) prints every TeX error and box
warning on stderr as `error: <file>:<line>: <message>`. Those give us exact
locations. The .log adds what stderr leaves out: the source context of each
error (`l.25 \\incudegraphics`) and LaTeX/package warnings such as undefined
citations.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from pathlib import Path

_STDERR = re.compile(r"^(error|warning): (?:(?P<file>[^:\n]+?):(?P<line>\d+): )?(?P<msg>.+)$")
_LOG_ERROR = re.compile(r"^! (?P<msg>.+)$")
_LOG_LINE = re.compile(r"^l\.(?P<line>\d+) ?(?P<text>.*)$")
_LOG_WARNING = re.compile(r"^(?:LaTeX|Package (?P<pkg>[\w-]+)|Class (?P<cls>[\w-]+)) Warning: (?P<msg>.*)$")
_INPUT_LINE = re.compile(r"on input line (\d+)\.?")
_NOISE = (
    "were issued by the TeX engine",
    "Fontconfig error",
    "halted on potentially-recoverable error",
)


@dataclass
class Issue:
    severity: str  # "error" | "warning" | "info"
    category: str  # latex | package | reference | bibliography | typesetting | engine
    raw: str
    title: str = ""
    file: str | None = None
    line: int | None = None
    context: str | None = None
    token: str | None = None  # the control sequence TeX stopped at, e.g. \incudegraphics
    explanation: str | None = None
    fixes: list[dict] = field(default_factory=list)
    rule: str | None = None

    def to_dict(self) -> dict:
        return {k: v for k, v in asdict(self).items() if v not in (None, [], "")}


def _unwrap(log: str) -> list[str]:
    """TeX hard-wraps log lines at 79 characters; join them back together."""
    out: list[str] = []
    for line in log.splitlines():
        if out and len(out[-1]) % 79 == 0 and len(out[-1]) > 0 and not line.startswith(("!", "l.")):
            out[-1] += line
        else:
            out.append(line)
    return out


def _resolve(root: Path, name: str | None) -> str | None:
    """Map a TeX file name (often without .tex) to a project-relative path."""
    if not name:
        return None
    name = name.strip().strip('"').replace("\\", "/")
    if name.startswith("./"):
        name = name[2:]
    for candidate in (name, f"{name}.tex"):
        p = root / candidate
        if p.is_file():
            return candidate
    return None


def parse(root: Path, main_rel: str, stderr_lines: list[str], log_text: str) -> list[Issue]:
    issues: list[Issue] = []
    seen: set[tuple] = set()

    def add(issue: Issue) -> None:
        key = (issue.severity, issue.file, issue.line, issue.raw)
        if key not in seen:
            seen.add(key)
            issues.append(issue)

    # Error contexts from the log, in order: [(message, line, context)]
    log_lines = _unwrap(log_text)
    contexts: list[tuple[str, int, str, str | None]] = []
    for i, line in enumerate(log_lines):
        m = _LOG_ERROR.match(line)
        if not m:
            continue
        for j in range(i + 1, min(i + 25, len(log_lines))):
            lm = _LOG_LINE.match(log_lines[j])
            if lm:
                before = lm.group("text")
                after = log_lines[j + 1].strip() if j + 1 < len(log_lines) else ""
                tok = re.search(r"(\\[A-Za-z@]+|\\.)\s*$", before)
                contexts.append((m.group("msg").rstrip("."), int(lm.group("line")), f"{before}{after}".strip(),
                                 tok.group(1) if tok else None))
                break

    def context_for(msg: str, line: int | None) -> tuple[str | None, str | None]:
        for cmsg, cline, ctext, tok in contexts:
            if cline == line and msg.rstrip(".").startswith(cmsg[:40]):
                return ctext, tok
        return None, None

    # 1. stderr: exact file + line for errors and box warnings.
    for raw_line in stderr_lines:
        m = _STDERR.match(raw_line.strip())
        if not m or any(n in raw_line for n in _NOISE):
            continue
        kind, msg = m.group(1), m.group("msg").strip()
        file = _resolve(root, m.group("file")) or (m.group("file") and main_rel)
        line = int(m.group("line")) if m.group("line") else None
        if kind == "error":
            if not m.group("file") and msg.startswith(("the XeTeX engine", "something bad happened")):
                continue
            ctext, tok = context_for(msg, line)
            add(Issue("error", "latex" if m.group("file") else "engine", msg, file=file, line=line,
                      context=ctext, token=tok))
        elif msg.startswith(("Overfull", "Underfull")):
            if msg.startswith("Overfull"):
                add(Issue("info", "typesetting", msg, file=file, line=line))
        else:
            add(Issue("warning", "latex", msg, file=file, line=line))

    # Which project file TeX was reading at the start of each log line. TeX writes
    # "(name" when it opens a file and ")" when it closes it.
    current: list[str | None] = []
    stack: list[str | None] = []
    for line in log_lines:
        current.append(next((f for f in reversed(stack) if f), None))
        for tok in re.finditer(r"\((?P<f>[^\s()]+)|\)", line):
            if tok.group("f") is not None:
                stack.append(_resolve(root, tok.group("f")))
            elif stack:
                stack.pop()

    # 2. Log: LaTeX / package warnings (citations, references, labels, ...).
    i = 0
    while i < len(log_lines):
        m = _LOG_WARNING.match(log_lines[i])
        if not m:
            i += 1
            continue
        pkg = m.group("pkg") or m.group("cls")
        text = m.group("msg").strip()
        file = current[i] or main_rel
        i += 1
        while i < len(log_lines) and log_lines[i].strip():
            cont = log_lines[i].strip()
            if pkg and cont.startswith(f"({pkg})"):
                cont = cont[len(pkg) + 2:].strip()
            elif text.endswith("."):
                break
            text = f"{text} {cont}"
            i += 1
        if "Font Warning" in text or text.startswith("Label(s) may have changed"):
            continue
        lm = _INPUT_LINE.search(text)
        category = "reference" if re.search(r"Citation|Reference|Label", text) else ("package" if pkg else "latex")
        add(Issue("warning", category, text, file=file, line=int(lm.group(1)) if lm else None))

    # 3. Missing characters in the font (emoji, unusual symbols).
    for line in log_lines:
        mc = re.match(r"Missing character: There is no (.+?) in font (.+?)!", line)
        if mc:
            add(Issue("warning", "typesetting", line.strip()))

    order = {"error": 0, "warning": 1, "info": 2}
    issues.sort(key=lambda x: order[x.severity])
    return issues
