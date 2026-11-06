"""Spot a mix of American and British spelling ("color" next to "behaviour").

It looks only at the prose: maths, comments, code, citations, file names, colour names, affiliations
and capitalised words in mid-sentence (usually names, like "Centre for Climate Research") are ignored.

How it decides what to flag:
  * The document's language comes from `\\usepackage[british]{babel}`, `\\setmainlanguage{american}` or a
    `% texkit-spelling: british` comment. Without any of those, the more common variant wins.
  * "-ize" is correct in American *and* Oxford British English, so -ize/-ise is only flagged when both
    are used in the same document, or when the text is clearly American and uses -ise.
  * Put `% nospell` at the end of a line to leave it alone (a quotation, for instance), or
    `% texkit-spelling: off` anywhere to turn the check off for the project.
"""

from __future__ import annotations

import re
from collections import Counter
from pathlib import Path

CAP = 60  # most issues reported; the rest are summarised

# ── The word table: (British, American) ──────────────────────────────────────────────────────
_SUFFIXES_IZE = ("e", "ed", "es", "ing", "ation", "ations", "ational", "er", "ers")
_IZE_STEMS = (  # (British stem, American stem): "organis" + "ation" → "organiz" + "ation"
    "organis realis recognis optimis minimis maximis normalis standardis generalis specialis summaris utilis "
    "categoris characteris visualis initialis synchronis parameteris randomis prioritis centralis decentralis "
    "localis globalis stabilis neutralis finalis formalis idealis materialis mobilis "
    "crystallis capitalis emphasis criticis apologis memoris hospitalis legalis familiaris digitis customis "
    "personalis authoris revolutionis harmonis monetis sanitis scrutinis sympathis terroris urbanis vaporis "
    "fertilis equalis penalis internationalis nationalis industrialis commercialis sterilis immunis "
    "polaris mineralis tokenis linearis discretis regularis galvanis"
).split()
_YZE_STEMS = (("analys", "analyz"), ("paralys", "paralyz"), ("catalys", "catalyz"), ("hydrolys", "hydrolyz"),
              ("electrolys", "electrolyz"), ("dialys", "dialyz"))
_NOT_PAIRS = {"analyses", "paralyses", "catalyses", "hydrolyses", "electrolyses", "dialyses"}  # also plurals of -sis nouns

_OUR_STEMS = (("colour", "color"), ("behaviour", "behavior"), ("favour", "favor"), ("honour", "honor"), ("labour", "labor"),
              ("neighbour", "neighbor"), ("flavour", "flavor"), ("harbour", "harbor"), ("humour", "humor"),
              ("rumour", "rumor"), ("vigour", "vigor"), ("endeavour", "endeavor"), ("odour", "odor"), ("tumour", "tumor"),
              ("armour", "armor"), ("rigour", "rigor"), ("saviour", "savior"), ("splendour", "splendor"),
              ("valour", "valor"), ("candour", "candor"), ("demeanour", "demeanor"), ("fervour", "fervor"),
              ("vapour", "vapor"), ("ardour", "ardor"), ("parlour", "parlor"), ("clamour", "clamor"))
_SUFFIXES_OUR = ("", "s", "ed", "ing", "ings", "ful", "fully", "less", "able", "ably", "ite", "ites", "al", "ally",
                 "er", "ers", "ist", "ists", "hood", "hoods")

_EXPLICIT = (  # irregular pairs
    ("centre", "center"), ("centres", "centers"), ("centred", "centered"), ("centring", "centering"),
    ("centrepiece", "centerpiece"), ("fibre", "fiber"), ("fibres", "fibers"), ("fibreglass", "fiberglass"),
    ("theatre", "theater"), ("theatres", "theaters"), ("calibre", "caliber"), ("sombre", "somber"), ("lustre", "luster"),
    ("defence", "defense"), ("defences", "defenses"), ("defenceless", "defenseless"), ("offence", "offense"),
    ("offences", "offenses"), ("pretence", "pretense"),
    ("catalogue", "catalog"), ("catalogues", "catalogs"), ("catalogued", "cataloged"), ("cataloguing", "cataloging"),
    ("modelling", "modeling"), ("modelled", "modeled"), ("labelling", "labeling"), ("labelled", "labeled"),
    ("travelling", "traveling"), ("travelled", "traveled"), ("traveller", "traveler"), ("travellers", "travelers"),
    ("cancelled", "canceled"), ("cancelling", "canceling"), ("signalling", "signaling"), ("signalled", "signaled"),
    ("fuelling", "fueling"), ("fuelled", "fueled"), ("levelling", "leveling"), ("levelled", "leveled"),
    ("channelling", "channeling"), ("channelled", "channeled"), ("counselling", "counseling"), ("counsellor", "counselor"),
    ("totalling", "totaling"), ("totalled", "totaled"), ("tunnelling", "tunneling"), ("tunnelled", "tunneled"),
    ("panelling", "paneling"), ("panelled", "paneled"), ("marshalling", "marshaling"), ("equalling", "equaling"),
    ("equalled", "equaled"), ("jewellery", "jewelry"), ("woollen", "woolen"),
    ("grey", "gray"), ("greys", "grays"), ("greyscale", "grayscale"), ("greyed", "grayed"),
    ("enrolment", "enrollment"), ("enrolments", "enrollments"), ("enrol", "enroll"), ("enrols", "enrolls"),
    ("fulfil", "fulfill"), ("fulfils", "fulfills"), ("fulfilment", "fulfillment"), ("skilful", "skillful"),
    ("skilfully", "skillfully"), ("instalment", "installment"), ("instalments", "installments"), ("instil", "instill"),
    ("distil", "distill"), ("aluminium", "aluminum"), ("sulphur", "sulfur"), ("sulphate", "sulfate"),
    ("sulphide", "sulfide"), ("sulphuric", "sulfuric"), ("caesium", "cesium"), ("ageing", "aging"),
    ("plough", "plow"), ("mould", "mold"), ("moulds", "molds"), ("moulded", "molded"), ("moulding", "molding"),
    ("sceptic", "skeptic"), ("sceptics", "skeptics"), ("sceptical", "skeptical"), ("scepticism", "skepticism"),
    ("artefact", "artifact"), ("artefacts", "artifacts"), ("maths", "math"), ("aeroplane", "airplane"),
    ("anaemia", "anemia"), ("anaemic", "anemic"), ("oestrogen", "estrogen"), ("oesophagus", "esophagus"),
    ("paediatric", "pediatric"), ("paediatrics", "pediatrics"), ("diarrhoea", "diarrhea"), ("leukaemia", "leukemia"),
    ("orthopaedic", "orthopedic"), ("encyclopaedia", "encyclopedia"), ("foetus", "fetus"), ("foetal", "fetal"),
    ("gynaecology", "gynecology"), ("haemoglobin", "hemoglobin"), ("haemorrhage", "hemorrhage"),
    ("haematology", "hematology"), ("ischaemia", "ischemia"), ("anaesthesia", "anesthesia"),
    ("anaesthetic", "anesthetic"), ("aetiology", "etiology"), ("oedema", "edema"),
    ("manoeuvre", "maneuver"), ("manoeuvres", "maneuvers"), ("manoeuvring", "maneuvering"),
    ("manoeuvred", "maneuvered"), ("mediaeval", "medieval"),
    ("behavioural", "behavioral"), ("behaviourally", "behaviorally"), ("favourite", "favorite"), ("favourites", "favorites"),
)

# word -> (variant, the other spelling, family). variant is "uk" or "us". The "ize" family is -ise/-ize,
# where -ize is also standard in Oxford British English.
_PAIRS: dict[str, tuple[str, str, str]] = {}


def _add(uk: str, us: str, family: str) -> None:
    _PAIRS.setdefault(uk, ("uk", us, family))
    _PAIRS.setdefault(us, ("us", uk, family))


for _uk, _us in _EXPLICIT:
    _add(_uk, _us, "core")
for _uk, _us in _OUR_STEMS:
    for _s in _SUFFIXES_OUR:
        _add(_uk + _s, _us + _s, "core")
for _stem in _IZE_STEMS:
    for _s in _SUFFIXES_IZE:
        if _stem + _s not in _NOT_PAIRS:
            _add(_stem + _s, _stem[:-1] + "z" + _s, "ize")
for _uk, _us in _YZE_STEMS:
    for _s in _SUFFIXES_IZE:
        if _uk + _s not in _NOT_PAIRS:
            _add(_uk + _s, _us + _s, "ize")

# ── Masking: blank out everything that isn't prose, keeping offsets and line numbers ───────────────
_SKIP_ENVS = ("verbatim", "verbatim*", "Verbatim", "lstlisting", "minted", "comment", "tikzpicture", "axis", "tikzcd",
              "pgfpicture", "filecontents", "filecontents*", "equation", "equation*", "align", "align*", "gather",
              "gather*", "multline", "multline*", "eqnarray", "eqnarray*", "flalign", "flalign*", "math", "displaymath",
              "alignat", "alignat*", "split")
_ENV = re.compile(r"\\begin\s*\{(" + "|".join(re.escape(e) for e in _SKIP_ENVS) + r")\}.*?\\end\s*\{\1\}", re.S)
_DISPLAY = re.compile(r"\$\$.*?\$\$|\\\[.*?\\\]|\\\(.*?\\\)", re.S)
_INLINE = re.compile(r"(?<![\\$])\$[^$]+?(?<!\\)\$", re.S)
_VERB = re.compile(r"\\verb\*?([^A-Za-z\s*])[^\n]*?\1")
_COMMENT = re.compile(r"(?<!\\)%[^\n]*")
_CMD_NAME = re.compile(r"\\[A-Za-z@]+\*?")
_OPT_ARGS = re.compile(r"(\\[A-Za-z@]+\*?)((?:\s*\[[^\]\n]*\])+)")
_PROSE_OPT = {"item", "section", "subsection", "subsubsection", "paragraph", "chapter", "part", "caption", "footnote",
              "subcaption", "title", "textit", "emph", "textbf"}
# Commands whose arguments are names, keys, paths or people, never prose.
_ALL_ARGS = {"cite", "citep", "citet", "citealp", "citeauthor", "citeyear", "parencite", "textcite", "autocite", "nocite",
             "ref", "eqref", "autoref", "cref", "Cref", "pageref", "nameref", "vref", "label", "url", "href", "includegraphics",
             "input", "include", "subfile", "usepackage", "RequirePackage", "documentclass", "bibliography",
             "bibliographystyle", "addbibresource", "graphicspath", "color", "definecolor", "pagecolor", "hypersetup",
             "lstinputlisting", "affil", "affiliation", "address", "institute", "email", "orcid", "thanks", "author",
             "setlength", "geometry", "pagestyle", "newcommand", "renewcommand", "providecommand", "DeclareMathOperator",
             "newtheorem", "newenvironment", "setmainfont", "setsansfont", "setmonofont", "usetikzlibrary", "pgfplotsset",
             "tikzset", "bibitem", "texttt", "setmainlanguage", "setdefaultlanguage", "selectlanguage", "foreignlanguage",
             "lstinline", "mintinline", "begin", "end", "newlabel", "hyperref", "orcidlink", "IEEEauthorblockN", "IEEEauthorblockA",
             "IEEEauthorrefmark", "corref", "fnref", "cortext", "ead", "lstset", "doi", "arxiv"}
_FIRST_ARG = {"textcolor", "colorbox", "fcolorbox", "cellcolor", "rowcolor", "columncolor", "arrayrulecolor", "colorlet"}


def _blank(text: str, start: int, end: int) -> str:
    return text[:start] + "".join(c if c == "\n" else " " for c in text[start:end]) + text[end:]


def _sub_blank(pattern: re.Pattern, text: str) -> str:
    return pattern.sub(lambda m: "".join(c if c == "\n" else " " for c in m.group(0)), text)


def _group_end(text: str, i: int) -> int | None:
    """Index just past the balanced {...} starting at text[i], or None."""
    depth = 0
    for j in range(i, min(len(text), i + 4000)):
        c = text[j]
        if c == "\\":
            continue
        if c == "{" and text[j - 1:j] != "\\":
            depth += 1
        elif c == "}" and text[j - 1:j] != "\\":
            depth -= 1
            if depth == 0:
                return j + 1
    return None


def _blank_command_args(text: str) -> str:
    out = text
    for m in re.finditer(r"\\([A-Za-z@]+)\*?", text):
        name = m.group(1)
        if name not in _ALL_ARGS and name not in _FIRST_ARG:
            continue
        i = m.end()
        end = i
        while True:
            k = end
            while k < len(text) and text[k] in " \t":
                k += 1
            if k < len(text) and text[k] == "[":
                close = text.find("]", k)
                if close < 0 or close - k > 300:
                    break
                end = close + 1
                continue
            if k < len(text) and text[k] == "{":
                g = _group_end(text, k)
                if g is None:
                    break
                end = g
                if name in _FIRST_ARG:
                    break
                continue
            break
        if end > i:
            out = _blank(out, i, end)
    return out


def mask(text: str) -> str:
    """`text` with every non-prose region replaced by spaces (same length, same line breaks)."""
    text = _sub_blank(_ENV, text)
    text = _sub_blank(_DISPLAY, text)
    text = _sub_blank(_INLINE, text)
    text = _sub_blank(_VERB, text)
    text = _blank_command_args(text)
    text = _OPT_ARGS.sub(lambda m: m.group(1) + "".join(c if c == "\n" else " " for c in m.group(2))
                         if m.group(1).lstrip("\\").rstrip("*") not in _PROSE_OPT else m.group(0), text)
    text = _sub_blank(_CMD_NAME, text)
    return text


_WORD = re.compile(r"(?<![A-Za-z0-9_/@\\])([A-Za-z]+)(?![A-Za-z0-9_/@])")
_BRITISH_DECL = re.compile(r"\b(british|UKenglish|australian|newzealand)\b", re.I)
_AMERICAN_DECL = re.compile(r"\b(american|USenglish)\b", re.I)
_LANG_LINE = re.compile(r"\\(?:usepackage|RequirePackage|setmainlanguage|setdefaultlanguage|documentclass|selectlanguage)[^\n]*")
_DIRECTIVE = re.compile(r"%\s*texkit-spelling\s*:\s*(british|american|off)", re.I)


def _case_like(original: str, replacement: str) -> str:
    if original.isupper() and len(original) > 1:
        return replacement.upper()
    return replacement.capitalize() if original[:1].isupper() else replacement


def _sentence_start(masked: str, pos: int) -> bool:
    k = pos - 1
    while k >= 0 and masked[k] in " \t":
        k -= 1
    return k < 0 or masked[k] in ".?!:{\n"


def check(root: Path, files: list[str], prefer: str | None = None) -> dict:
    """Check the spelling of the .tex files in `files`.

    `prefer` is the user's setting: "american", "british" or "off". Anything else means automatic.
    Returns {"issues": [...], "dialect": "american"|"british"|None, "declared": bool,
    "source": "setting"|"document"|"majority"|None, "us": n, "uk": n, ...}.
    """
    prefer = prefer if prefer in ("american", "british", "off") else None
    if prefer == "off":
        return {"issues": [], "dialect": None, "declared": False, "source": None, "us": 0, "uk": 0, "off": True}
    raw: dict[str, str] = {}
    for rel in files:
        if rel.endswith(".tex"):
            try:
                raw[rel] = (root / rel).read_text(encoding="utf-8-sig", errors="replace")
            except OSError:
                continue
    empty = {"issues": [], "dialect": None, "declared": False, "source": None, "us": 0, "uk": 0}
    everything = "\n".join(raw.values())
    directive = _DIRECTIVE.search(everything)
    if directive and directive.group(1).lower() == "off" and not prefer:
        return {**empty, "off": True}

    declared = None
    source = None
    if prefer:
        declared, source = prefer, "setting"
    elif directive:
        declared, source = directive.group(1).lower(), "document"
    else:
        lang = " ".join(m.group(0) for m in _LANG_LINE.finditer(_COMMENT.sub("", everything)))
        if _BRITISH_DECL.search(lang):
            declared, source = "british", "document"
        elif _AMERICAN_DECL.search(lang):
            declared, source = "american", "document"

    hits = []  # (file, line, col, token, variant, other, family)
    for rel, text in raw.items():
        lines = text.split("\n")
        skip_lines = {i for i, ln in enumerate(lines) if re.search(r"%.*\bnospell\b", ln)}
        masked = mask(_sub_blank(_COMMENT, text))
        starts = [0]
        for ln in lines:
            starts.append(starts[-1] + len(ln) + 1)
        line_no = 0
        for m in _WORD.finditer(masked):
            while line_no + 1 < len(starts) - 1 and starts[line_no + 1] <= m.start():
                line_no += 1
            word = m.group(1)
            info = _PAIRS.get(word.lower())
            if not info or line_no in skip_lines:
                continue
            if word[:1].isupper() and not _sentence_start(masked, m.start()):
                continue  # a name in the middle of a sentence ("Centre for Climate Research")
            if len(word) > 1 and word.isupper():
                continue  # an acronym
            hits.append((rel, line_no + 1, m.start() - starts[line_no], word, *info))

    core = Counter(h[4] for h in hits if h[6] == "core")
    ize = Counter(h[4] for h in hits if h[6] == "ize")  # "us" = -ize, "uk" = -ise
    if not hits:
        return {**empty, "dialect": declared, "declared": declared is not None, "source": source}

    first_core = next((h[4] for h in hits if h[6] == "core"), None)
    if declared:
        dialect = declared
    elif core["us"] != core["uk"]:
        dialect = "american" if core["us"] > core["uk"] else "british"
    else:
        dialect = {"us": "american", "uk": "british"}.get(first_core or "") if first_core else None

    flagged = []  # (hit, reason)
    for h in hits:
        rel, line, col, word, variant, other, family = h
        if family == "core":
            if dialect == "american" and variant == "uk":
                flagged.append((h, "american"))
            elif dialect == "british" and variant == "us":
                flagged.append((h, "british"))
        else:  # -ise / -ize
            if dialect == "american" and variant == "uk":
                flagged.append((h, "american"))
            elif ize["us"] and ize["uk"]:
                keep = "uk" if ize["uk"] > ize["us"] else "us"
                if variant != keep and not (dialect == "american" and variant == "us"):
                    flagged.append((h, "ize-uk" if keep == "uk" else "ize-us"))

    def examples(variant: str, family: str) -> list[str]:
        return [w for w, _ in Counter(h[3].lower() for h in hits if h[4] == variant and h[6] == family).most_common(3)]

    issues = []
    for (rel, line, col, word, variant, other, family), reason in flagged:
        fix_to = _case_like(word, other)
        if reason in ("american", "british"):
            have = "British" if variant == "uk" else "American"
            want = "American" if reason == "american" else "British"
            ex = examples("us" if reason == "american" else "uk", "core")
            lead = {"setting": f"Your spelling setting is {want} English", "document": f"This document is set to {want} English"}
            why = lead.get(source, f"Most of your text uses {want} spelling") + \
                  (f" ({', '.join('“' + e + '”' for e in ex)})" if ex else "") + \
                  f", but “{word}” is {have}. Use “{fix_to}”, or write “% nospell” at the end of the line if it's a quotation."
            title = f"“{word}” is {have} spelling, not {want}"
        else:
            keep = "-ise" if reason == "ize-uk" else "-ize"
            title = f"Mixed -ise and -ize spelling: “{word}”"
            why = (f"You use both -ise and -ize words. Most use {keep}, so “{fix_to}” keeps it consistent. "
                   "(Both are standard in British English; pick one.)")
        issues.append({
            "severity": "warning", "category": "language", "raw": title, "title": title, "explanation": why,
            "source": "analysis", "rule": "spelling-variant", "file": rel, "line": line, "col": col, "token": word,
            "fixes": [{"kind": "replace", "label": f"Change to {fix_to}", "from": word, "to": fix_to}],
        })
    if len(issues) > CAP:
        extra = len(issues) - CAP
        issues = issues[:CAP]
        issues.append({"severity": "warning", "category": "language", "raw": f"{extra} more spelling variants",
                       "title": f"…and {extra} more spelling variants", "explanation": "Fix these first, then check again.",
                       "source": "analysis", "rule": "spelling-variant"})
    return {"issues": issues, "dialect": dialect, "declared": declared is not None, "source": source or ("majority" if dialect else None),
            "us": core["us"], "uk": core["uk"], "ise": ize["uk"], "ize": ize["us"]}
