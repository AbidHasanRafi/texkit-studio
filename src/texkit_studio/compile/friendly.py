"""Plain-English explanations for common LaTeX problems.

Each rule matches an issue's raw message and fills in `title`, `explanation`
and optional one-click `fixes`. Rules are tried in order; the first match wins.
Issues no rule matches keep a lightly cleaned-up version of the raw message.
"""

from __future__ import annotations

import difflib
import re
from typing import Callable

from .logparse import Issue

# Commands people commonly use, for "did you mean" suggestions.
KNOWN_COMMANDS = """
documentclass usepackage begin end section subsection subsubsection paragraph chapter part
title author date maketitle tableofcontents listoffigures listoftables abstract
textbf textit texttt textsc textsf textrm emph underline footnote footnotemark footnotetext
cite citep citet citeauthor nocite ref eqref pageref autoref cref Cref label caption
includegraphics input include includeonly bibliography bibliographystyle printbibliography addbibresource
centering raggedright raggedleft newline linebreak newpage clearpage cleardoublepage pagebreak
hspace vspace hfill vfill quad qquad noindent indent smallskip medskip bigskip
item hline cline toprule midrule bottomrule multicolumn multirow
frac dfrac tfrac sqrt sum prod int oint lim infty partial nabla cdot cdots ldots dots times div pm mp
alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi pi rho sigma tau
upsilon phi varphi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Phi Psi Omega
mathbf mathit mathrm mathcal mathbb mathfrak boldsymbol text operatorname
left right big Big bigg Bigg leq geq neq approx equiv sim propto subset subseteq in notin cup cap
rightarrow leftarrow Rightarrow Leftarrow leftrightarrow mapsto to
url href hyperref newcommand renewcommand newenvironment DeclareMathOperator
small footnotesize scriptsize tiny large Large LARGE huge Huge normalsize
today thanks and appendix IEEEauthorblockN IEEEauthorblockA IEEEkeywords columnwidth textwidth linewidth
""".split()

# Commands that need a package, for "add \\usepackage{...}" suggestions.
PACKAGE_FOR = {
    "includegraphics": "graphicx", "graphicspath": "graphicx",
    "toprule": "booktabs", "midrule": "booktabs", "bottomrule": "booktabs", "cmidrule": "booktabs",
    "url": "url", "href": "hyperref", "autoref": "hyperref", "hypersetup": "hyperref",
    "cref": "cleveref", "Cref": "cleveref",
    "mathbb": "amssymb", "mathfrak": "amssymb", "eqref": "amsmath", "text": "amsmath",
    "DeclareMathOperator": "amsmath", "operatorname": "amsmath", "boldsymbol": "amsmath",
    "SI": "siunitx", "si": "siunitx", "num": "siunitx", "qty": "siunitx", "unit": "siunitx",
    "multirow": "multirow", "textcolor": "xcolor", "color": "xcolor", "definecolor": "xcolor",
    "colorbox": "xcolor", "rowcolor": "xcolor", "lipsum": "lipsum", "blindtext": "blindtext",
    "subcaption": "subcaption", "subfloat": "subfig", "captionof": "caption",
    "citep": "natbib", "citet": "natbib", "addbibresource": "biblatex", "printbibliography": "biblatex",
    "tikz": "tikz", "draw": "tikz", "lstinline": "listings", "lstset": "listings",
    "algorithmic": "algorithmic", "State": "algpseudocode", "checkmark": "amssymb",
    "ding": "pifont", "sout": "ulem", "uline": "ulem", "hl": "soul", "todo": "todonotes",
    "FloatBarrier": "placeins", "doublespacing": "setspace", "onehalfspacing": "setspace",
    "geometry": "geometry", "fancyhead": "fancyhdr", "pagestyle": "fancyhdr",
}

Rule = tuple[re.Pattern, Callable[[Issue, re.Match], None]]
RULES: list[Rule] = []


def rule(pattern: str):
    def register(fn):
        RULES.append((re.compile(pattern), fn))
        return fn
    return register


def _bad_command(issue: Issue) -> str | None:
    if issue.token and issue.token[1:].replace("@", "").isalpha():
        return issue.token
    return None


@rule(r"^Undefined control sequence")
def _undefined(issue: Issue, _m) -> None:
    cmd = _bad_command(issue)
    if not cmd:
        issue.title = "Unknown command"
        issue.explanation = "LaTeX met a command it doesn't know. It's usually a typo, or a command from a package that isn't loaded."
        return
    name = cmd[1:]
    issue.title = f"Unknown command {cmd}"
    pkg = PACKAGE_FOR.get(name)
    close = difflib.get_close_matches(name, KNOWN_COMMANDS, n=1, cutoff=0.75)
    if pkg:
        issue.explanation = f"{cmd} comes from the {pkg} package, which isn't loaded. Add \\usepackage{{{pkg}}} to the preamble (before \\begin{{document}})."
        issue.fixes.append({"kind": "insertPackage", "label": f"Add \\usepackage{{{pkg}}}", "package": pkg})
    elif close and close[0] != name:
        issue.explanation = f"LaTeX doesn't recognise {cmd}. It looks like a typo for \\{close[0]}."
        issue.fixes.append({"kind": "replace", "label": f"Replace with \\{close[0]}", "from": cmd, "to": f"\\{close[0]}"})
    else:
        issue.explanation = f"LaTeX doesn't recognise {cmd}. Check the spelling, or load the package that defines it."


@rule(r"^Missing \$ inserted")
def _missing_dollar(issue: Issue, _m) -> None:
    issue.title = "Maths symbol used outside maths mode"
    issue.explanation = ("Symbols like ^, _ or Greek letters only work inside maths. Wrap the formula in $...$, "
                         "or write \\_ for a literal underscore (common in file names and URLs).")


@rule(r"^LaTeX Error: File `(.+?)' not found")
def _file_not_found(issue: Issue, m) -> None:
    name = m.group(1)
    issue.title = f"File not found: {name}"
    if name.endswith((".sty", ".cls")):
        issue.explanation = (f"{name} isn't a package LaTeX can find. Check the spelling. If it's a journal's own class or style file, "
                             "put it in your project folder next to the main file.")
    else:
        issue.explanation = f"LaTeX can't find {name}. Check the file name and folder, and remember that paths are relative to the main file."


@rule(r"^Unable to load picture or PDF file '(.+?)'|^File `(.+?)' not found|Cannot determine size of graphic in (.+?) ")
def _image_not_found(issue: Issue, m) -> None:
    name = next(g for g in m.groups() if g)
    issue.title = f"Image not found: {name}"
    issue.explanation = "Check the file name and folder. Paths are relative to the main file, and on Linux and macOS capital letters matter."


@rule(r"^LaTeX Error: Missing \\begin\{document\}")
def _no_begin(issue: Issue, _m) -> None:
    issue.title = "Text before \\begin{document}"
    issue.explanation = "Only settings (\\usepackage, \\title, ...) can go in the preamble. Move this text below \\begin{document}, or check for a stray character."


@rule(r"^LaTeX Error: \\begin\{(.+?)\} on input line (\d+) ended by \\end\{(.+?)\}")
def _mismatch(issue: Issue, m) -> None:
    issue.title = f"\\begin{{{m.group(1)}}} is closed by \\end{{{m.group(3)}}}"
    issue.explanation = f"The environment opened on line {m.group(2)} must be closed with \\end{{{m.group(1)}}} before \\end{{{m.group(3)}}}."


@rule(r"^LaTeX Error: Environment (.+?) undefined")
def _env_undefined(issue: Issue, m) -> None:
    env = m.group(1)
    issue.title = f"Unknown environment {env}"
    pkgs = {"align": "amsmath", "align*": "amsmath", "gather": "amsmath", "equation*": "amsmath",
            "tikzpicture": "tikz", "lstlisting": "listings", "algorithm": "algorithm", "algorithmic": "algpseudocode",
            "subfigure": "subcaption", "longtable": "longtable", "tabularx": "tabularx", "multicols": "multicol",
            "proof": "amsthm", "minted": "minted"}
    pkg = pkgs.get(env)
    if pkg:
        issue.explanation = f"The {env} environment comes from the {pkg} package. Add \\usepackage{{{pkg}}} to the preamble."
        issue.fixes.append({"kind": "insertPackage", "label": f"Add \\usepackage{{{pkg}}}", "package": pkg})
    else:
        issue.explanation = "Check the spelling, or load the package that defines it."


@rule(r"^Too many \}'s|^Extra \}, or forgotten")
def _extra_brace(issue: Issue, _m) -> None:
    issue.title = "Extra closing brace }"
    issue.explanation = "There's a } without a matching {. Look on this line and the one before it."


@rule(r"^Missing \} inserted|^Extra \{|^Runaway argument|^Paragraph ended before (.+?) was complete")
def _missing_brace(issue: Issue, _m) -> None:
    issue.title = "A brace { isn't closed"
    issue.explanation = "A command's argument started with { but never got its closing }. Check this line and the lines just above it."


@rule(r"^Misplaced alignment tab character &|^Extra alignment tab")
def _ampersand(issue: Issue, m) -> None:
    if m.group(0).startswith("Extra"):
        issue.title = "Too many columns in a table row"
        issue.explanation = "This row has more & separators than the table has columns. Remove one, or add a column to the {...} spec."
    else:
        issue.title = "Stray & character"
        issue.explanation = "& separates table columns. To print an ampersand in text, write \\&."


@rule(r"^LaTeX Error: Option clash for package (.+?)\.")
def _option_clash(issue: Issue, m) -> None:
    issue.title = f"The {m.group(1)} package is loaded twice with different options"
    issue.explanation = "Load it once with all the options together, or pass options earlier with \\PassOptionsToPackage."


@rule(r"^LaTeX Error: Can be used only in preamble")
def _preamble_only(issue: Issue, _m) -> None:
    issue.title = "This command belongs in the preamble"
    issue.explanation = "Move it above \\begin{document}."


@rule(r"^LaTeX Error: There's no line here to end")
def _no_line(issue: Issue, _m) -> None:
    issue.title = "Line break with nothing to break"
    issue.explanation = "\\\\ was used at the start of a paragraph or after a blank line. Remove it, or use \\vspace{...} for extra space."


@rule(r"^Missing number, treated as zero|^Illegal unit of measure")
def _number(issue: Issue, _m) -> None:
    issue.title = "A length or number is missing"
    issue.explanation = "A command expected a size such as 2cm or 0.5\\textwidth. Check the value and its unit (pt, cm, mm, in, em)."


@rule(r"^LaTeX Error: Unknown option")
def _unknown_option(issue: Issue, _m) -> None:
    issue.title = "Unknown package or class option"
    issue.explanation = "One of the options in [...] isn't supported. Check its spelling in the package's documentation."


@rule(r"^Citation [`'](.+?)' .*undefined")
def _citation(issue: Issue, m) -> None:
    key = m.group(1)
    issue.title = f"Citation “{key}” isn't in your bibliography"
    issue.explanation = f"It prints as [?]. Add an entry with the key {key} to your .bib file, or check the spelling. If you just added it, compile again."
    issue.category = "bibliography"


@rule(r"^Reference [`'](.+?)' .*undefined")
def _reference(issue: Issue, m) -> None:
    issue.title = f"Reference to “{m.group(1)}” has no matching \\label"
    issue.explanation = f"It prints as ??. Add \\label{{{m.group(1)}}} after the caption or heading you mean, or fix the spelling."


@rule(r"^Label [`'](.+?)' multiply defined")
def _dup_label(issue: Issue, m) -> None:
    issue.title = f"The label “{m.group(1)}” is used twice"
    issue.explanation = "Each \\label must be unique, or references will point to the wrong place."


@rule(r"^There were undefined references")
def _undef_refs(issue: Issue, _m) -> None:
    issue.title = "Some references are undefined"
    issue.explanation = "Look for ?? or [?] in the PDF. The individual warnings above say which ones."


@rule(r"^Overfull \\hbox \((.+?)pt too wide\)")
def _overfull(issue: Issue, m) -> None:
    issue.title = f"A line sticks out into the margin by {float(m.group(1)):.1f} pt"
    issue.explanation = "Usually a long word, URL or formula LaTeX can't break. Rewording, or allowing a break with \\- or \\allowbreak, fixes it."


@rule(r"^Missing character: There is no (.+?) in font")
def _missing_char(issue: Issue, m) -> None:
    issue.title = f"The font has no {m.group(1)} character"
    issue.explanation = "That character (often an emoji or unusual symbol) will be missing from the PDF. Use a LaTeX command for it, or pick a font that has it with fontspec."


@rule(r"(?i)shell escape|\\write18|minted")
def _shell_escape(issue: Issue, _m) -> None:
    issue.title = "This package needs to run external programs"
    issue.explanation = ("For safety, TexKit Studio doesn't let documents run programs (shell-escape). "
                         "Packages such as minted and svg need it. Use listings instead of minted, or convert SVG images to PDF.")


@rule(r"(?i)(failed to|couldn't|unable to) (download|fetch|connect)|network|dns error|timed out")
def _offline(issue: Issue, _m) -> None:
    issue.title = "Couldn't download a LaTeX package"
    issue.explanation = ("The first time a document uses a package, it's downloaded once and then kept. "
                         "Connect to the internet and compile again. After that it works offline.")
    issue.category = "engine"


def explain(issue: Issue) -> Issue:
    for pattern, handler in RULES:
        m = pattern.search(issue.raw)
        if m:
            handler(issue, m)
            issue.rule = handler.__name__.lstrip("_")
            break
    if not issue.title:
        title = re.sub(r"^(LaTeX|Package \S+|Class \S+) (Error|Warning): ", "", issue.raw)
        title = re.sub(r"\s+on input line \d+\.?$", "", title).strip()
        issue.title = title[:1].upper() + title[1:] if title else issue.raw
    return issue


def explain_all(issues: list[Issue]) -> list[Issue]:
    return [explain(i) for i in issues]
