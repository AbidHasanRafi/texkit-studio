"""Check bibliography entries against open scholarly databases.

For each entry this answers: does the work exist, is the DOI really that work, has it been retracted
or corrected, and (when there is no DOI) is there a DOI we can suggest. Sources, all free and without
a key: Crossref (registration, corrections, retractions), DataCite (arXiv/Zenodo-style DOIs),
OpenAlex (an independent `is_retracted` flag, and a broader title search) and arXiv.

Nothing here runs on its own. The user starts a check, and each request sends only that entry's DOI,
title and first author to those services. With no internet connection `verify_entry` raises `Offline`.
"""

from __future__ import annotations

import difflib
import json
import re
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from typing import Callable

from .._meta import DIST_NAME, __version__

USER_AGENT = f"{DIST_NAME}/{__version__} (reference check; https://github.com/AbidHasanRafi/texkit-studio)"
CACHE_SECONDS = 600
TIMEOUT = 15
RATE_LIMIT_RETRIES = 2

_DOI = re.compile(r"10\.\d{4,9}/[^\s\"<>]+", re.I)
_LEVELS = {"bad": 3, "warn": 2, "info": 1, "ok": 0}

# Crossref `updated-by` types.
_RETRACTED = {"retraction", "withdrawal", "removal"}
_CONCERN = {"expression_of_concern"}
_CORRECTED = {"correction", "corrigendum", "erratum", "addendum"}
# Entry types for which "not found online" is unremarkable.
_OFFLINE_KINDS = {"book", "inbook", "booklet", "manual", "misc", "online", "techreport", "report", "phdthesis",
                  "mastersthesis", "thesis", "unpublished", "software", "dataset", "standard", "patent", "electronic"}


class Offline(RuntimeError):
    """No internet connection (as opposed to a service that answered with an error)."""


class ServiceError(RuntimeError):
    """A service answered, but not usefully (rate limit, outage)."""


Fetch = Callable[[str, str], "dict | str | None"]  # (url, "json" | "text") -> parsed body, or None on 404

_cache: dict[str, tuple[float, object]] = {}
_lock = threading.Lock()


def clear_cache() -> None:
    with _lock:
        _cache.clear()


def fetch(url: str, kind: str = "json"):
    """GET `url`. Returns the parsed JSON (or text), None for 404. Cached for a few minutes."""
    with _lock:
        hit = _cache.get(url)
        if hit and time.monotonic() - hit[0] < CACHE_SECONDS:
            return hit[1]
    req = urllib.request.Request(url, headers={"Accept": "application/json" if kind == "json" else "*/*", "User-Agent": USER_AGENT})
    for attempt in range(RATE_LIMIT_RETRIES + 1):
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
            body = json.loads(raw) if kind == "json" else raw
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                body = None
            elif exc.code == 429:
                # Crossref answers a burst of lookups with 429 now and then: wait as long as it asks (a few seconds at most) and try again.
                if attempt < RATE_LIMIT_RETRIES:
                    try:
                        wait = float(exc.headers.get("Retry-After", ""))
                    except (TypeError, ValueError):
                        wait = 1.0 + attempt
                    time.sleep(min(max(wait, 0.5), 5.0))
                    continue
                raise ServiceError("the service is rate-limiting requests right now") from exc
            else:
                raise ServiceError(f"the service answered with an error ({exc.code})") from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise Offline("Couldn't reach the internet.") from exc
        except ValueError as exc:
            raise ServiceError("the service sent an unreadable answer") from exc
        break
    with _lock:
        if len(_cache) > 2000:
            _cache.clear()
        _cache[url] = (time.monotonic(), body)
    return body


# ── Text helpers ─────────────────────────────────────────────────────────
def _norm(text: str) -> str:
    text = unicodedata.normalize("NFKD", text or "")
    text = "".join(c for c in text if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def similarity(a: str, b: str) -> float:
    """0..1 closeness of two titles, ignoring case, accents, punctuation and a trailing subtitle."""
    a, b = _norm(a), _norm(b)
    if not a or not b:
        return 0.0
    ratio = difflib.SequenceMatcher(None, a, b).ratio()
    short, long_ = sorted((a, b), key=len)
    if len(short) >= 20 and long_.startswith(short):
        ratio = max(ratio, 0.95)
    return ratio


def clean_doi(text: str) -> str:
    """The bare DOI inside `text` (a DOI, a doi.org link, or a field with LaTeX escapes), or ''."""
    m = _DOI.search((text or "").replace("\\_", "_").replace("\\&", "&").replace("\\%", "%"))
    return m.group(0).rstrip(".,;)}]").lower() if m else ""


def _surname(name: str) -> str:
    name = name.strip()
    last = name.split(",")[0] if "," in name else (name.split()[-1] if name.split() else "")
    return _norm(last)


def _bib_surnames(author: str) -> list[str]:
    return [s for s in (_surname(n) for n in re.split(r"\s+and\s+", author or "") if n.strip().lower() != "others") if s]


def _year(value) -> int | None:
    m = re.search(r"\b(1[5-9]\d\d|20\d\d)\b", str(value or ""))
    return int(m.group(1)) if m else None


def _short(text: str, n: int = 90) -> str:
    text = re.sub(r"\s+", " ", text or "").strip()
    return text if len(text) <= n else text[: n - 1].rstrip() + "…"


# ── Source adapters: each returns {title, authors:[surname], year, doi, retracted?, ...} or None ──
def _crossref_item(m: dict) -> dict:
    title = (m.get("title") or [""])[0]
    issued = ((m.get("issued") or {}).get("date-parts") or [[None]])[0]
    return {
        "title": re.sub(r"<[^>]+>", "", title or ""),
        "authors": [_norm(a.get("family") or a.get("name") or "") for a in m.get("author") or []],
        "year": _year(issued[0] if issued else None),
        "doi": (m.get("DOI") or "").lower(),
        "source": "Crossref",
    }


def crossref_work(doi: str, get: Fetch) -> dict | None:
    body = get(f"https://api.crossref.org/works/{urllib.parse.quote(doi, safe='/')}", "json")
    if not body or "message" not in body:
        return None
    m = body["message"]
    item = _crossref_item(m)
    item["updates"] = [(u.get("type", ""), (u.get("DOI") or "").lower(), u.get("label") or "") for u in m.get("updated-by") or []]
    item["is_notice"] = [u.get("type", "") for u in m.get("update-to") or []]
    item["raw_title"] = (m.get("title") or [""])[0]
    return item


def datacite_work(doi: str, get: Fetch) -> dict | None:
    body = get(f"https://api.datacite.org/dois/{urllib.parse.quote(doi, safe='/')}", "json")
    attrs = ((body or {}).get("data") or {}).get("attributes")
    if not attrs:
        return None
    titles = attrs.get("titles") or [{}]
    return {
        "title": titles[0].get("title", ""),
        "authors": [_norm(c.get("familyName") or c.get("name") or "") for c in attrs.get("creators") or []],
        "year": _year(attrs.get("publicationYear")),
        "doi": doi, "source": "DataCite", "updates": [], "is_notice": [],
    }


def crossref_search(title: str, author: str, get: Fetch) -> list[dict]:
    q = urllib.parse.quote(f"{title} {_bib_surnames(author)[0] if _bib_surnames(author) else ''}".strip())
    body = get(f"https://api.crossref.org/works?query.bibliographic={q}&rows=4&select=DOI,title,author,issued,type", "json")
    return [_crossref_item(m) for m in ((body or {}).get("message") or {}).get("items") or []]


def _openalex_item(w: dict) -> dict:
    return {
        "title": w.get("title") or w.get("display_name") or "",
        "authors": [_surname(((a.get("author") or {}).get("display_name")) or "") for a in w.get("authorships") or []],
        "year": w.get("publication_year"),
        "doi": clean_doi(w.get("doi") or ""),
        "retracted": bool(w.get("is_retracted")),
        "source": "OpenAlex",
    }


_OA_SELECT = "select=id,doi,title,publication_year,is_retracted,authorships"


def openalex_work(doi: str, get: Fetch) -> dict | None:
    w = get(f"https://api.openalex.org/works/doi:{urllib.parse.quote(doi, safe='/')}?{_OA_SELECT}", "json")
    return _openalex_item(w) if w else None


def openalex_search(title: str, get: Fetch) -> list[dict]:
    body = get(f"https://api.openalex.org/works?search={urllib.parse.quote(title)}&per-page=4&{_OA_SELECT}", "json")
    return [_openalex_item(w) for w in (body or {}).get("results") or []]


def arxiv_work(eprint: str, get: Fetch) -> dict | None:
    arxiv_id = re.sub(r"^arxiv[:\s]*", "", eprint.strip(), flags=re.I)
    xml = get(f"https://export.arxiv.org/api/query?id_list={urllib.parse.quote(arxiv_id)}", "text")
    if not xml:
        return None
    try:
        entry = ET.fromstring(xml).find("{http://www.w3.org/2005/Atom}entry")
    except ET.ParseError:
        return None
    if entry is None:
        return None
    ns = "{http://www.w3.org/2005/Atom}"
    title = re.sub(r"\s+", " ", entry.findtext(f"{ns}title") or "").strip()
    if not title or title == "Error":
        return None
    return {
        "title": title,
        "authors": [_surname(a.findtext(f"{ns}name") or "") for a in entry.findall(f"{ns}author")],
        "year": _year((entry.findtext(f"{ns}published") or "")[:4]), "doi": "", "source": "arXiv", "updates": [], "is_notice": [],
    }


# ── The check ────────────────────────────────────────────────────────────
class _Notes:
    def __init__(self) -> None:
        self.items: list[dict] = []

    def add(self, level: str, text: str, code: str) -> None:
        self.items.append({"level": level, "text": text, "code": code})

    def sorted(self) -> list[dict]:
        return sorted(self.items, key=lambda n: -_LEVELS[n["level"]])


def _compare(entry: dict, found: dict, notes: _Notes, *, via_doi: bool) -> bool:
    """Compare what the entry says with what the database says. Returns False for a different work."""
    title = entry.get("title", "")
    sim = similarity(title, found["title"]) if title else None
    where = found["source"]
    if sim is not None and via_doi:
        if sim < 0.5:
            notes.add("bad", f"This DOI belongs to a different work: “{_short(found['title'])}”. {where} has it as "
                             f"{', '.join(a.title() for a in found['authors'][:2])}{' ' if found['authors'] else ''}({found['year'] or 'n.d.'}). "
                             "The entry's title, or its DOI, is wrong.", "wrong-doi")
            return False
        if sim < 0.8:
            notes.add("warn", f"The title differs from the one registered for this DOI: “{_short(found['title'])}”.", "mismatch")
    mine = _bib_surnames(entry.get("author", ""))
    theirs = [a for a in found["authors"] if a]
    if mine and theirs and not (set(mine) & set(theirs)):
        notes.add("warn", f"None of the authors match {where}'s record ({', '.join(a.title() for a in theirs[:3])}"
                          f"{' et al.' if len(theirs) > 3 else ''}).", "mismatch")
    elif mine and theirs and mine[0] not in theirs:
        notes.add("info", f"The first author differs from {where}'s record ({theirs[0].title()}).", "author")
    y_mine, y_found = _year(entry.get("year")), found.get("year")
    if y_mine and y_found and abs(y_mine - y_found) > 1:
        notes.add("warn", f"The year is {y_mine}, but {where} says {y_found}.", "mismatch")
    return True


def _status_notes(doi: str, crossref: dict | None, get: Fetch, notes: _Notes) -> None:
    """Retractions, expressions of concern and corrections from Crossref plus OpenAlex's own flag."""
    retracted_by, concern, corrected = [], [], []
    for kind, notice, _label in (crossref or {}).get("updates", []):
        (retracted_by if kind in _RETRACTED else concern if kind in _CONCERN else corrected if kind in _CORRECTED else []).append(notice)
    if crossref and any(k in _RETRACTED for k in crossref.get("is_notice", [])):
        notes.add("warn", "This DOI is a retraction notice, not the paper itself. Cite the original paper instead.", "notice")
    if re.match(r"\s*(retracted|withdrawn)\b", (crossref or {}).get("raw_title", ""), re.I):
        retracted_by = retracted_by or [""]
    oa = None
    try:
        oa = openalex_work(doi, get)
    except (ServiceError, Offline):
        pass  # a second opinion is a bonus, never a reason to fail the check
    if retracted_by or (oa and oa.get("retracted")):
        who = [s for s, hit in (("Crossref", bool(retracted_by)), ("OpenAlex", bool(oa and oa.get("retracted")))) if hit]
        notice = next((n for n in retracted_by if n), "")
        notes.add("bad", f"This paper has been retracted ({' and '.join(who)}). Don't cite it as sound evidence."
                         + (f" Retraction notice: https://doi.org/{notice}" if notice else ""), "retracted")
    if concern:
        notes.add("warn", "The publisher has issued an expression of concern about this paper."
                          + (f" Notice: https://doi.org/{concern[0]}" if concern[0] else ""), "concern")
    if corrected:
        notes.add("info", "A correction or erratum has been published for this paper. Check that you cite the corrected facts.", "corrected")


def _best(entry: dict, candidates: list[dict]) -> tuple[dict | None, float]:
    best, score = None, 0.0
    y = _year(entry.get("year"))
    for c in candidates:
        s = similarity(entry.get("title", ""), c["title"])
        if y and c.get("year") and abs(y - c["year"]) > 1:
            s -= 0.15  # same title, other year: a reprint or a different work, never a confident match
        s += 0.001 if c.get("doi") else 0  # on a tie, prefer the record we can give a DOI for
        if s > score:
            best, score = c, s
    return best, score


def verify_entry(entry: dict, get: Fetch = fetch) -> dict:
    """Check one entry: {key,title,author,year,doi,url,eprint,type}. Raises `Offline` without internet."""
    key = entry.get("key", "")
    notes = _Notes()
    doi = clean_doi(entry.get("doi", "")) or clean_doi(entry.get("url", ""))
    title = entry.get("title", "").strip()
    suggest = None
    link = None
    try:
        if doi:
            found = crossref_work(doi, get) or datacite_work(doi, get)
            if not found:
                notes.add("bad", f"The DOI {doi} doesn't exist. Crossref and DataCite have no record of it, "
                                 "so it's mistyped or invented.", "bad-doi")
            elif _compare(entry, found, notes, via_doi=True):
                if not any(n["level"] in ("bad", "warn") for n in notes.items):
                    notes.add("ok", f"Verified: the DOI resolves to “{_short(found['title'])}”.", "verified")
                _status_notes(doi, found, get, notes)
                link = f"https://doi.org/{doi}"
        elif entry.get("eprint") and not title:
            found = arxiv_work(entry["eprint"], get)
            notes.add("ok" if found else "bad", f"Verified on arXiv: “{_short(found['title'])}”." if found
                      else f"arXiv has no paper with the ID {entry['eprint']}.", "verified" if found else "not-found")
        elif not title:
            notes.add("info", "This entry has no title or DOI, so there is nothing to check it against.", "empty")
        else:
            # Pool both databases: Crossref lacks many conference papers and OpenAlex lacks some DOIs.
            match, score = _best(entry, crossref_search(title, entry.get("author", ""), get) + openalex_search(title, get))
            if entry.get("eprint") and (not match or score < 0.9):
                arx = arxiv_work(entry["eprint"], get)
                if arx and similarity(title, arx["title"]) >= 0.8:
                    match, score = arx, similarity(title, arx["title"])
            if match and score >= 0.9:
                _compare(entry, match, notes, via_doi=False)
                if match["doi"]:
                    suggest = match["doi"]
                    link = f"https://doi.org/{suggest}"
                    notes.add("info", f"Found it, but the entry has no DOI. Suggested: {suggest}", "no-doi")
                    _status_notes(suggest, None, get, notes)
                else:
                    notes.add("ok", f"Found on {match['source']}: “{_short(match['title'])}”.", "verified")
                    if match.get("retracted"):
                        notes.add("bad", "This paper has been retracted (OpenAlex).", "retracted")
            elif match and score >= 0.7:
                suggest = match["doi"] or None
                notes.add("warn", f"No exact match. The closest is “{_short(match['title'])}” "
                                  f"({', '.join(a.title() for a in match['authors'][:2])}, {match['year'] or 'n.d.'}). "
                                  "Check that your entry is the same work."
                                  + (f" Its DOI is {match['doi']}." if match["doi"] else ""), "near")
            elif (entry.get("type") or "").lower() in _OFFLINE_KINDS:
                notes.add("info", "Not found in Crossref or OpenAlex. Books, theses, reports and web pages often "
                                  "aren't indexed there, so check this one by hand.", "not-indexed")
            else:
                notes.add("warn", "No publication with this title was found in Crossref or OpenAlex, and the entry has no DOI. "
                                  "If it's real, add its DOI. If you're not sure it exists, check it by hand: "
                                  "AI assistants sometimes invent references.", "not-found")
    except ServiceError as exc:
        return {"key": key, "level": "info", "code": "error", "headline": f"Couldn't check this one: {exc}.", "notes": [], "doi": doi or None,
                "suggestDoi": None, "url": None, "error": True}

    ordered = notes.sorted()
    return {"key": key, "level": ordered[0]["level"], "code": ordered[0]["code"], "headline": ordered[0]["text"], "notes": ordered,
            "doi": doi or suggest, "suggestDoi": suggest if not doi else None, "url": link, "error": False}
