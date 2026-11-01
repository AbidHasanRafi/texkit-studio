"""Terminal styling for the command line: colour, panels and status marks.

Output stays plain text when it is piped, when NO_COLOR is set, or on a "dumb" terminal (FORCE_COLOR overrides).
Box drawing and marks fall back to ASCII when the terminal can't show Unicode.
"""

from __future__ import annotations

import os
import shutil
import sys
from functools import lru_cache


@lru_cache(maxsize=1)
def _color() -> bool:
    if os.environ.get("NO_COLOR"):
        return False
    if os.environ.get("FORCE_COLOR"):
        return True
    if not sys.stdout.isatty() or os.environ.get("TERM") == "dumb":
        return False
    if os.name == "nt":  # old consoles need virtual terminal processing switched on
        try:
            import ctypes

            kernel = ctypes.windll.kernel32  # type: ignore[attr-defined]
            handle = kernel.GetStdHandle(-11)
            mode = ctypes.c_ulong()
            if not kernel.GetConsoleMode(handle, ctypes.byref(mode)):
                return False
            kernel.SetConsoleMode(handle, mode.value | 0x0004)
        except Exception:
            return False
    return True


@lru_cache(maxsize=1)
def _unicode() -> bool:
    return "utf" in (getattr(sys.stdout, "encoding", "") or "").lower()


@lru_cache(maxsize=1)
def _truecolor() -> bool:
    return os.environ.get("COLORTERM", "").lower() in ("truecolor", "24bit") or bool(os.environ.get("WT_SESSION"))


def paint(text: str, *codes: str) -> str:
    return f"\x1b[{';'.join(codes)}m{text}\x1b[0m" if _color() and codes else text


def accent(text: str) -> str:
    return paint(text, "38;2;124;196;190" if _truecolor() else "36")


def bold(text: str) -> str:
    return paint(text, "1")


def dim(text: str) -> str:
    return paint(text, "2")


def good(text: str) -> str:
    return paint(text, "92")


def warn(text: str) -> str:
    return paint(text, "93")


def bad(text: str) -> str:
    return paint(text, "91")


def link(url: str) -> str:
    return paint(url, "4", "38;2;124;196;190" if _truecolor() else "36")


def mark(kind: str) -> str:
    """A coloured status mark: ok, warn, error, info or step."""
    glyphs = {"ok": "✓", "warn": "!", "error": "✗", "info": "i", "step": "›"} if _unicode() else \
             {"ok": "+", "warn": "!", "error": "x", "info": "i", "step": ">"}
    colour = {"ok": good, "warn": warn, "error": bad, "info": accent, "step": accent}[kind]
    return colour(glyphs[kind])


def row(label: str, value: str, width: int = 8) -> str:
    """An aligned "label  value" line for key facts such as the folder and address."""
    return f"  {accent('◆' if _unicode() else '*')} {dim(label.ljust(width))} {value}"


def panel(lines: list[tuple[str, str]], indent: int = 2) -> str:
    """A rounded box around lines of (plain_text, styled_text). Width is measured on the plain text."""
    inner = max(len(plain) for plain, _ in lines) + 4
    avail = shutil.get_terminal_size((80, 24)).columns - indent - 2
    if inner > avail:  # too narrow for a box: just indent the styled lines
        return "\n".join(" " * indent + styled for _, styled in lines)
    tl, tr, bl, br, h, v = ("╭", "╮", "╰", "╯", "─", "│") if _unicode() else ("+", "+", "+", "+", "-", "|")
    pad = " " * indent
    edge = lambda ch: dim(ch)  # noqa: E731
    out = [pad + edge(tl + h * inner + tr)]
    for plain, styled in lines:
        out.append(pad + edge(v) + "  " + styled + " " * (inner - 4 - len(plain)) + "  " + edge(v))
    out.append(pad + edge(bl + h * inner + br))
    return "\n".join(out)
