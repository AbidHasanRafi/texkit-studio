"""Read the whole document (following \\input and \\include) and connect its parts.

It finds every figure, table, equation and section with its \\label, every \\ref and
\\cite, the bibliography entries, images and packages, then checks the rules journals
commonly require: every figure and table referred to in the text, every bibliography
entry cited, no reference or citation pointing nowhere.
"""

from __future__ import annotations

import difflib
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path

from . import bibtex, spelling
from .project import detect_main, tex_files
from .safefs import is_hidden

FLOATS = {"figure": "figure", "figure*": "figure", "subfigure": "figure", "wrapfigure": "figure",
          "table": "table", "table*": "table", "subtable": "table", "wraptable": "table",
          "algorithm": "algorithm", "lstlisting": "listing", "listing": "listing"}
MATHS = {"equation", "equation*", "align", "align*", "gather", "gather*", "multline", "multline*",
         "eqnarray", "eqnarray*", "flalign", "alignat", "subequations"}
THEOREMS = {"theorem", "lemma", "proposition", "corollary", "definition", "remark", "example"}
VERBATIM = {"verbatim", "verbatim*", "lstlisting", "minted", "comment", "Verbatim"}
SECTIONS = {"part": 0, "chapter": 1, "section": 2, "subsection": 3, "subsubsection": 4, "paragraph": 5}
REF_CMDS = r"ref|eqref|autoref|Autoref|cref|Cref|pageref|nameref|vref|vpageref|subref|labelcref|cpageref|Cpageref|hyperref"
CITE_CMDS = (r"cite|citep|citet|citealp|citealt|citeauthor|citeyear|citeyearpar|parencite|Parencite|textcite|Textcite|"
             r"autocite|Autocite|footcite|fullcite|smartcite|supercite|nocite|Cite|Citep|Citet|citenum|cites|parencites")
IMAGE_EXTS = (".pdf", ".png", ".jpg", ".jpeg", ".eps", ".svg", ".gif", ".bmp", ".tif", ".tiff")

_TOKEN = re.compile(
    r"\\(?P<env>begin|end)\s*\{(?P<envname>[^}]+)\}"
    rf"|\\(?P<sec>{'|'.join(SECTIONS)})\*?\s*(?:\[[^\]]*\])?\s*\{{"
    r"|\\label\s*\{(?P<label>[^}]+)\}"
    rf"|\\(?P<refcmd>{REF_CMDS})\*?\s*(?:\[[^\]]*\])?\s*\{{(?P<refs>[^}}]+)\}}"
    rf"|\\(?P<citecmd>{CITE_CMDS})\*?\s*(?:\[[^\]]*\]\s*){{0,2}}\{{(?P<cites>[^}}]+)\}}"
    r"|\\(?P<inc>input|include|subfile)\s*\{(?P<incfile>[^}]+)\}"
    r"|\\includegraphics\*?\s*(?:\[[^\]]*\])?\s*\{(?P<graphic>[^}]+)\}"
    r"|\\(?P<bibcmd>bibliography|addbibresource)\s*(?:\[[^\]]*\])?\s*\{(?P<bib>[^}]+)\}"
    r"|\\caption\s*(?:\[[^\]]*\])?\s*\{"
    r"(?P<caption>)"
    r"|\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{(?P<pkgs>[^}]+)\}"
    r"|\\graphicspath\s*\{(?P<gpath>(?:\{[^}]*\})+)\}"
    r"|\\bibitem\s*(?:\[[^\]]*\])?\s*\{(?P<bibitem>[^}]+)\}"
    r"|\\printbibliography(?P<printbib>)"
)
_COMMENT = re.compile(r"(?<!\\)%.*$")


@dataclass
class Label:
    key: str
    kind: str  # figure | table | equation | section | chapter | algorithm | listing | theorem | other
    file: str
    line: int
    col: int
    caption: str = ""
    number: str = ""  # Fig. 1, Table 2 (top-level floats in document order)
    order: int = 0  # position in the document, for "mentioned out of order"


@dataclass
class Use:
    key: str
    cmd: str
    file: str
    line: int
    col: int
    order: int = 0


@dataclass
class Float:
    kind: str
    env: str
    file: str
    line: int
    caption: str = ""
    labels: list[str] = field(default_factory=list)
    depth: int = 0  # 0 = top level, >0 = sub-figure


@dataclass
class Section:
    level: int
    title: str
    file: str
    line: int
    words: int = 0


class Scan:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.labels: list[Label] = []
        self.refs: list[Use] = []
        self.cites: list[Use] = []
        self.floats: list[Float] = []
        self.sections: list[Section] = []
        self.graphics: list[Use] = []
        self.bib_files: list[str] = []
        self.bib_cmd: Use | None = None
        self.bibitems: list[Use] = []
        self.packages: set[str] = set()
        self.graphic_paths: list[str] = [""]
        self.files: list[str] = []
        self.missing_inputs: list[Use] = []
        self.words = 0
        self._order = 0
        self._env: list[tuple[str, Float | None]] = []
        self._last_section_kind = "other"
        self._seen: set[str] = set()

    # ── reading ────────────────────────────────────────────────────────
    def read(self, rel: str, depth: int = 0) -> None:
        if rel in self._seen or depth > 12:
            return
        path = self.root / rel
        try:
            text = path.read_text(encoding="utf-8-sig", errors="replace")
        except OSError:
            return
        self._seen.add(rel)
        self.files.append(rel)
        lines = text.splitlines()
        in_verbatim = None
        pending_caption: tuple[Float, str] | None = None  # caption spanning several lines
        for i, raw in enumerate(lines, start=1):
            if in_verbatim:
                if re.search(rf"\\end\s*\{{{re.escape(in_verbatim)}\}}", raw):
                    in_verbatim = None
                continue
            line = _COMMENT.sub("", raw)
            if pending_caption:
                fl, so_far = pending_caption
                text_part, closed = _balanced(line, 0)
                so_far = f"{so_far} {text_part}"
                if closed:
                    fl.caption = _plain(so_far)
                    pending_caption = None
                else:
                    pending_caption = (fl, so_far)
                continue
            self._count_words(line)
            for m in _TOKEN.finditer(line):
                self._order += 1
                g = m.groupdict()
                if g["env"]:
                    name = g["envname"].strip()
                    if g["env"] == "begin":
                        fl = None
                        if name in FLOATS:
                            depth_f = sum(1 for _, f in self._env if f is not None)
                            fl = Float(FLOATS[name], name, rel, i, depth=depth_f)
                            self.floats.append(fl)
                        self._env.append((name, fl))
                        if name in VERBATIM and not re.search(rf"\\end\s*\{{{re.escape(name)}\}}", line[m.end():]):
                            in_verbatim = name
                            break
                    else:
                        for k in range(len(self._env) - 1, -1, -1):
                            if self._env[k][0] == name:
                                del self._env[k:]
                                break
                elif g["sec"]:
                    title, closed = _balanced(line, m.end())
                    level = SECTIONS[g["sec"]]
                    self.sections.append(Section(level, _plain(title) or "(untitled)", rel, i))
                    self._last_section_kind = "chapter" if g["sec"] == "chapter" else "section"
                elif g["label"] is not None:
                    self.labels.append(Label(g["label"].strip(), self._label_kind(), rel, i, m.start("label"), order=self._order))
                    fl = self._current_float()
                    if fl:
                        fl.labels.append(g["label"].strip())
                elif g["refcmd"]:
                    for key, col in _split_keys(g["refs"], m.start("refs")):
                        self.refs.append(Use(key, g["refcmd"], rel, i, col, self._order))
                elif g["citecmd"]:
                    for key, col in _split_keys(g["cites"], m.start("cites")):
                        self.cites.append(Use(key, g["citecmd"], rel, i, col, self._order))
                elif g["inc"]:
                    target = self._resolve_tex(g["incfile"].strip(), rel)
                    if target:
                        self.read(target, depth + 1)
                    else:
                        self.missing_inputs.append(Use(g["incfile"].strip(), g["inc"], rel, i, m.start("incfile")))
                elif g["graphic"] is not None:
                    self.graphics.append(Use(g["graphic"].strip(), "includegraphics", rel, i, m.start("graphic")))
                elif g["bibcmd"]:
                    self.bib_cmd = self.bib_cmd or Use(g["bib"], g["bibcmd"], rel, i, m.start("bib"))
                    for name in g["bib"].split(","):
                        self.bib_files.append(self._resolve_bib(name.strip(), rel, g["bibcmd"]))
                elif g["caption"] is not None:
                    fl = self._current_float()
                    title, closed = _balanced(line, m.end())
                    if fl is not None:
                        if closed:
                            fl.caption = _plain(title)
                        else:
                            pending_caption = (fl, title)
                elif g["pkgs"]:
                    self.packages.update(p.strip() for p in g["pkgs"].split(",") if p.strip())
                elif g["gpath"]:
                    self.graphic_paths += [p for p in re.findall(r"\{([^}]*)\}", g["gpath"])]
                elif g["bibitem"]:
                    self.bibitems.append(Use(g["bibitem"].strip(), "bibitem", rel, i, m.start("bibitem")))
                elif g["printbib"] is not None:
                    self.bib_cmd = self.bib_cmd or Use("", "printbibliography", rel, i, m.start())

    def _current_float(self) -> Float | None:
        for _name, fl in reversed(self._env):
            if fl is not None:
                return fl
        return None

    def _label_kind(self) -> str:
        for name, fl in reversed(self._env):
            if fl is not None:
                return fl.kind
            if name in MATHS:
                return "equation"
            if name in THEOREMS:
                return "theorem"
            if name in ("enumerate",):
                return "item"
        return self._last_section_kind

    def _resolve_tex(self, name: str, current: str) -> str | None:
        name = name.replace("\\", "/")
        bases = [Path(current).parent, Path("")]
        for base in bases:
            for cand in (name, f"{name}.tex"):
                p = (self.root / base / cand)
                if p.is_file():
                    try:
                        return p.resolve().relative_to(self.root).as_posix()
                    except ValueError:
                        return None
        return None

    def _resolve_bib(self, name: str, current: str, cmd: str) -> str:
        if cmd == "bibliography" and not name.endswith(".bib"):
            name += ".bib"
        for base in (Path(current).parent, Path("")):
            p = self.root / base / name
            if p.is_file():
                try:
                    return p.resolve().relative_to(self.root).as_posix()
                except ValueError:
                    break
        return name  # missing; reported later

    def _count_words(self, line: str) -> None:
        if self._env and any(n in MATHS or n in ("tabular", "tikzpicture") for n, _ in self._env):
            return
        text = re.sub(r"\\(begin|end)\{[^}]*\}", " ", line)
        text = re.sub(r"\\(label|ref|eqref|cite\w*|includegraphics|usepackage|documentclass|input|include)\*?(\[[^\]]*\])?\{[^}]*\}", " ", text)
        text = re.sub(r"\$[^$]*\$", " x ", text)
        text = re.sub(r"\\[a-zA-Z@]+\*?", " ", text)
        n = len(re.findall(r"[^\W\d_][\w'’-]*|\d+(?:[.,]\d+)?", text.replace("{", " ").replace("}", " ")))
        self.words += n
        if self.sections:
            self.sections[-1].words += n


def _balanced(line: str, start: int) -> tuple[str, bool]:
    depth = 0
    for j in range(start, len(line)):
        ch = line[j]
        if ch == "{" and (j == 0 or line[j - 1] != "\\"):
            depth += 1
        elif ch == "}" and (j == 0 or line[j - 1] != "\\"):
            if depth == 0:
                return line[start:j], True
            depth -= 1
    return line[start:], False


def _plain(text: str) -> str:
    text = re.sub(r"\\(label|footnote)\{[^}]*\}", "", text)
    text = re.sub(r"\\[a-zA-Z@]+\*?\{([^}]*)\}", r"\1", text)
    text = re.sub(r"\\[a-zA-Z@]+\*?", "", text)
    text = text.replace("{", "").replace("}", "").replace("~", " ").replace("$", "")
    return re.sub(r"\s+", " ", text).strip()


def _split_keys(group: str, start: int):
    offset = 0
    for part in group.split(","):
        key = part.strip()
        if key:
            yield key, start + offset + (len(part) - len(part.lstrip()))
        offset += len(part) + 1


# ── public API ────────────────────────────────────────────────────────
PREFIX = {"figure": "fig", "table": "tab", "equation": "eq", "section": "sec", "chapter": "ch",
          "algorithm": "alg", "listing": "lst", "theorem": "thm"}


def analyse(root: Path, spelling_pref: str | None = None) -> dict:
    root = root.resolve()
    main = detect_main(root)
    scan = Scan(root)
    if main:
        scan.read(main)
    # Files nothing includes still contribute labels and references (e.g. a chapter being drafted),
    # but only when there's no main file to follow.
    if not main:
        for rel in tex_files(root):
            scan.read(rel)

    # Number top-level figures and tables in document order.
    counters: dict[str, int] = {}
    numbers: dict[str, str] = {}
    for fl in scan.floats:
        if fl.depth == 0 and fl.kind in ("figure", "table", "algorithm", "listing"):
            counters[fl.kind] = counters.get(fl.kind, 0) + 1
            n = counters[fl.kind]
            for key in fl.labels:
                numbers[key] = {"figure": f"Fig. {n}", "table": f"Table {n}", "algorithm": f"Algorithm {n}", "listing": f"Listing {n}"}[fl.kind]
    captions = {key: fl.caption for fl in scan.floats for key in fl.labels}
    for lab in scan.labels:
        lab.number = numbers.get(lab.key, "")
        lab.caption = captions.get(lab.key, "")
    sec_titles = {}
    for s in scan.sections:
        sec_titles[(s.file, s.line)] = s.title
    for lab in scan.labels:
        if lab.kind in ("section", "chapter") and not lab.caption:
            prev = [s for s in scan.sections if s.file == lab.file and s.line <= lab.line]
            if prev:
                lab.caption = prev[-1].title

    # Bibliography entries from the .bib files the document uses (or every .bib if none is named).
    bib_rels = [b for b in dict.fromkeys(scan.bib_files)]
    if not bib_rels:
        bib_rels = sorted(p.relative_to(root).as_posix() for p in root.rglob("*.bib")
                          if not any(is_hidden(part) for part in p.relative_to(root).parts))
    entries: list[bibtex.Entry] = []
    missing_bibs = []
    for rel in bib_rels:
        p = root / rel
        if p.is_file():
            entries += bibtex.parse(p.read_text(encoding="utf-8-sig", errors="replace"), rel)
        elif scan.bib_cmd:
            missing_bibs.append(rel)
    for item in scan.bibitems:
        entries.append(bibtex.Entry(item.key, "bibitem", item.file, item.line))

    ref_counts: dict[str, list[Use]] = {}
    for r in scan.refs:
        ref_counts.setdefault(r.key, []).append(r)
    cite_counts: dict[str, list[Use]] = {}
    for c in scan.cites:
        cite_counts.setdefault(c.key, []).append(c)

    checks = _checks(scan, main, entries, ref_counts, cite_counts, missing_bibs)
    language = spelling.check(root, scan.files, spelling_pref)
    checks += language.pop("issues")
    label_keys = {lab.key for lab in scan.labels}
    entry_keys = {e.key for e in entries}
    nocite_all = "*" in cite_counts

    return {
        "main": main,
        "files": scan.files,
        "packages": sorted(scan.packages),
        "labels": [{**asdict(lab), "refs": [_loc(u) for u in ref_counts.get(lab.key, [])]} for lab in scan.labels],
        "refs": [{**asdict(u), "found": u.key in label_keys} for u in scan.refs],
        "cites": [{**asdict(u), "found": u.key in entry_keys or u.key == "*"} for u in scan.cites],
        "bibliography": {
            "files": bib_rels, "included": scan.bib_cmd is not None, "nociteAll": nocite_all,
            "entries": [{**e.to_dict(), "short": e.short, "cites": [_loc(u) for u in cite_counts.get(e.key, [])]} for e in entries],
        },
        "floats": [asdict(f) for f in scan.floats],
        "sections": [asdict(s) for s in scan.sections],
        "graphics": [{**asdict(g), "resolved": _resolve_graphic(root, g, scan.graphic_paths)} for g in scan.graphics],
        "words": scan.words,
        "checks": checks,
        "language": language,
    }


def _loc(u: Use) -> dict:
    return {"file": u.file, "line": u.line, "col": u.col}


def _resolve_graphic(root: Path, g: Use, paths: list[str]) -> str | None:
    base = Path(g.file).parent
    for gp in paths:
        for b in (base, Path("")):
            stem = (root / b / gp / g.key)
            for cand in [stem] + [stem.with_name(stem.name + ext) for ext in IMAGE_EXTS]:
                if cand.is_file():
                    try:
                        return cand.resolve().relative_to(root).as_posix()
                    except ValueError:
                        return None
    return None


def _issue(severity, title, explanation, file=None, line=None, rule=None, fixes=None, key=None, col=None) -> dict:
    d = {"severity": severity, "category": "references", "raw": title, "title": title, "explanation": explanation,
         "source": "analysis", "rule": rule}
    if file:
        d["file"] = file
    if line:
        d["line"] = line
    if col is not None:
        d["col"] = col
    if key:
        d["key"] = key
    if fixes:
        d["fixes"] = fixes
    return d


def _short(text: str, n: int = 60) -> str:
    return text if len(text) <= n else text[: n - 1].rstrip() + "…"


def _slug(text: str) -> str:
    words = re.findall(r"[a-z0-9]+", text.lower())
    stop = {"a", "an", "the", "of", "and", "for", "in", "on", "with", "to"}
    return "-".join([w for w in words if w not in stop][:3]) or "item"


def _checks(scan: Scan, main, entries, ref_counts, cite_counts, missing_bibs) -> list[dict]:
    out: list[dict] = []
    labels_by_key: dict[str, list[Label]] = {}
    for lab in scan.labels:
        labels_by_key.setdefault(lab.key, []).append(lab)
    entry_keys = {e.key for e in entries}
    noun = {"figure": "Figure", "table": "Table", "algorithm": "Algorithm", "listing": "Listing"}

    # Figures and tables must be referred to in the text.
    for fl in scan.floats:
        if fl.kind not in noun:
            continue
        name = noun[fl.kind]
        what = f"“{_short(fl.caption, 48)}”" if fl.caption else f"on line {fl.line}"
        if not fl.labels:
            if fl.depth == 0 or fl.caption:
                suggestion = f"{PREFIX.get(fl.kind, 'fig')}:{_slug(fl.caption or name)}"
                out.append(_issue("warning", f"{name} {what} has no \\label",
                                  f"Without a \\label you can't refer to it in the text. Add \\label{{{suggestion}}} right after its \\caption.",
                                  fl.file, fl.line, "float-no-label",
                                  [{"kind": "addLabel", "label": f"Add \\label{{{suggestion}}}", "labelKey": suggestion, "line": fl.line}]))
            continue
        if not fl.caption and fl.depth == 0:
            out.append(_issue("info", f"{name} on line {fl.line} has no caption",
                              "Most journals require a caption on every figure and table.", fl.file, fl.line, "float-no-caption"))
        if not any(ref_counts.get(k) for k in fl.labels):
            key = fl.labels[0]
            lab = labels_by_key[key][0]
            number = lab.number or name
            out.append(_issue("warning", f"{number} {what} is never referred to in the text",
                              f"Journals usually require every {name.lower()} to be mentioned in the text, for example "
                              f"“as shown in {number.replace('Fig.', 'Fig.')}”. Use “Insert reference” to add one where you're typing.",
                              lab.file, lab.line, "float-unreferenced",
                              [{"kind": "insertRef", "label": f"Insert a reference to {number} at the cursor", "key": key, "refKind": fl.kind}],
                              key=key, col=lab.col))

    # Figures and tables mentioned out of order (IEEE and many others require order).
    for kind in ("figure", "table"):
        firsts = []
        for fl in scan.floats:
            if fl.kind == kind and fl.depth == 0 and fl.labels:
                uses = [u for k in fl.labels for u in ref_counts.get(k, [])]
                if uses:
                    lab = labels_by_key[fl.labels[0]][0]
                    firsts.append((min(u.order for u in uses), lab, min(uses, key=lambda u: u.order)))
        mentioned = [lab for _, lab, _ in sorted(firsts, key=lambda t: t[0])]
        numbered = [lab for _, lab, _ in firsts]
        for i, lab in enumerate(mentioned):
            if lab is not numbered[i]:
                first_use = next(u for _, lb, u in firsts if lb is lab)
                out.append(_issue("info", f"{lab.number} is mentioned before {numbered[i].number}",
                                  "Many journals ask that figures and tables are first mentioned in numerical order.",
                                  first_use.file, first_use.line, "float-order", key=lab.key))
                break

    # References and citations that point nowhere.
    all_labels = sorted(labels_by_key)
    for key, uses in ref_counts.items():
        if key in labels_by_key:
            continue
        close = difflib.get_close_matches(key, all_labels, n=1, cutoff=0.6)
        for u in uses:
            fixes = [{"kind": "replace", "label": f"Change to {close[0]}", "from": key, "to": close[0]}] if close else []
            out.append(_issue("error", f"\\{u.cmd}{{{key}}} points to a label that doesn't exist",
                              f"It will print as ??. {'Did you mean ' + close[0] + '?' if close else 'Add \\label{' + key + '} where it should point.'}",
                              u.file, u.line, "ref-missing", fixes, key=key, col=u.col))
    if entries or scan.bib_cmd:
        all_keys = sorted(entry_keys)
        for key, uses in cite_counts.items():
            if key in entry_keys or key == "*":
                continue
            close = difflib.get_close_matches(key, all_keys, n=1, cutoff=0.6)
            bib = scan.bib_files[0] if scan.bib_files else "your .bib file"
            for u in uses:
                fixes = [{"kind": "replace", "label": f"Change to {close[0]}", "from": key, "to": close[0]}] if close else []
                out.append(_issue("error", f"Citation “{key}” isn't in {bib}",
                                  f"It will print as [?]. {'Did you mean ' + close[0] + '?' if close else 'Add the source with “Add citation by DOI”, or check the key.'}",
                                  u.file, u.line, "cite-missing", fixes, key=key, col=u.col))

    # Every bibliography entry should be cited.
    if scan.bib_cmd and "*" not in cite_counts:
        for e in entries:
            if e.type != "bibitem" and e.key not in cite_counts:
                out.append(_issue("warning", f"“{_short(e.title or e.key, 50)}” is in the bibliography but never cited",
                                  f"{e.short or e.key} is listed in {e.file} but nothing cites it, so it won't appear in the "
                                  f"references (or, with some styles, appears uncited). Cite it, or remove it from the .bib file.",
                                  e.file, e.line, "bib-uncited",
                                  [{"kind": "insertCite", "label": "Cite it at the cursor", "key": e.key}], key=e.key))
    elif scan.bib_cmd and "*" in cite_counts:
        pass
    for e in entries:
        if e.type == "bibitem" and e.key not in cite_counts and "*" not in cite_counts:
            out.append(_issue("warning", f"\\bibitem{{{e.key}}} is never cited", "Cite it in the text, or remove it.",
                              e.file, e.line, "bib-uncited", [{"kind": "insertCite", "label": "Cite it at the cursor", "key": e.key}], key=e.key))

    # Citations but no bibliography printed.
    if scan.cites and not scan.bib_cmd and not scan.bibitems:
        bibs = sorted({e.file for e in entries})
        name = bibs[0][:-4] if bibs else "references"
        out.append(_issue("error", "You cite sources but the document never prints a bibliography",
                          f"Add \\bibliographystyle{{plain}} and \\bibliography{{{name}}} before \\end{{document}}.",
                          main, None, "no-bibliography",
                          [{"kind": "insertBibliography", "label": "Add the bibliography", "bib": name}]))
    for rel in missing_bibs:
        out.append(_issue("error", f"The bibliography file {rel} doesn't exist",
                          "Check the name in \\bibliography{...}, or create the file.", scan.bib_cmd.file if scan.bib_cmd else main,
                          scan.bib_cmd.line if scan.bib_cmd else None, "bib-file-missing"))

    # Duplicates and broken includes.
    for key, labs in labels_by_key.items():
        if len(labs) > 1:
            for lab in labs[1:]:
                out.append(_issue("error", f"The label “{key}” is used more than once",
                                  f"It's also on line {labs[0].line} of {labs[0].file}. References will point to the wrong place.",
                                  lab.file, lab.line, "label-duplicate", key=key, col=lab.col))
    seen_keys: dict[str, bibtex.Entry] = {}
    for e in entries:
        if e.key in seen_keys and e.type != "bibitem":
            out.append(_issue("warning", f"The bibliography key “{e.key}” appears twice",
                              f"Only one entry is used. The other is on line {seen_keys[e.key].line}.", e.file, e.line, "bib-duplicate", key=e.key))
        seen_keys.setdefault(e.key, e)
    for u in scan.missing_inputs:
        out.append(_issue("error", f"\\{u.cmd}{{{u.key}}}: file not found", "Check the file name and folder.",
                          u.file, u.line, "input-missing", col=u.col))
    for g in scan.graphics:
        if not _resolve_graphic(scan.root, g, scan.graphic_paths):
            out.append(_issue("error", f"Image not found: {g.key}", "Check the file name and folder (paths are relative to the main file).",
                              g.file, g.line, "graphic-missing", col=g.col))
    order = {"error": 0, "warning": 1, "info": 2}
    out.sort(key=lambda d: order[d["severity"]])
    return out


def unused_files(root: Path, result: dict) -> list[str]:
    """Images and .tex files in the folder that the document never uses."""
    used = {g["resolved"] for g in result["graphics"] if g["resolved"]} | set(result["files"]) | set(result["bibliography"]["files"])
    out = []
    for p in sorted(root.rglob("*")):
        rel_parts = p.relative_to(root).parts
        if not p.is_file() or any(is_hidden(x) for x in rel_parts):
            continue
        rel = p.relative_to(root).as_posix()
        if (p.suffix.lower() in IMAGE_EXTS or p.suffix.lower() == ".tex") and rel not in used:
            out.append(rel)
    return out
