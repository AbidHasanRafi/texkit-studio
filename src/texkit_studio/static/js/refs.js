// References panel and connecting tools: every figure, table, equation and bibliography entry
// with how often it's referred to, plus "Insert reference", "Insert citation" and "Add by DOI".

import { api } from "./api.js";
import { h, icon, dialog, toast, showMenu } from "./dom.js";
import { state, set, on } from "./store.js";
import { picker } from "./palette.js";
import * as editor from "./editor.js";

const KIND_ICON = { figure: "image", table: "table", equation: "sigma", section: "hash", chapter: "hash", algorithm: "list", listing: "terminal", theorem: "bulb" };
const KIND_NAME = { figure: "Figures", table: "Tables", equation: "Equations", section: "Sections", chapter: "Chapters", algorithm: "Algorithms", listing: "Listings", theorem: "Theorems", other: "Other labels" };
const REQUIRED = new Set(["figure", "table", "algorithm", "listing"]);  // journals expect these to be referenced

export const requestAnalysis = () => set({ wantAnalysis: Date.now() });

function shortText(t, n = 54) { return !t ? "" : t.length > n ? `${t.slice(0, n - 1)}…` : t; }

function labelTitle(l) {
  if (l.number) return l.number;
  if (l.kind === "equation") return "Equation";
  if (l.kind === "section" || l.kind === "chapter") return l.caption || l.key;
  return l.key;
}

/** Text to insert for a reference to `label`, matching the document's packages. */
export function refText(key, kind) {
  const pk = new Set(state.analysis?.packages || []);
  if (pk.has("cleveref")) return `\\cref{${key}}`;
  const word = { figure: "Fig.~", table: "Table~", algorithm: "Algorithm~", listing: "Listing~", section: "Section~", chapter: "Chapter~" }[kind];
  if (kind === "equation") return `Eq.~\\eqref{${key}}`;
  return `${word || ""}\\ref{${key}}`;
}

export async function insertRef(key, kind) {
  const ok = await editor.insertAtCursor(refText(key, kind), { smartSpace: true });
  if (ok) toast(`Inserted a reference to ${key}.`, { kind: "ok", timeout: 2500 });
}

export async function insertCite(key) {
  const ok = await editor.insertCitation(key);
  if (ok) toast(`Cited ${key}.`, { kind: "ok", timeout: 2500 });
}

// ── Pickers ────────────────────────────────────────────────────────────
const KIND_ORDER = ["figure", "table", "equation", "algorithm", "listing", "theorem", "chapter", "section", "other"];

export function refPicker() {
  const labels = (state.analysis?.labels || []).filter((l) => l.kind !== "item")
    .sort((a, b) => (KIND_ORDER.indexOf(a.kind) + 1 || 99) - (KIND_ORDER.indexOf(b.kind) + 1 || 99));
  picker({
    title: "Insert a reference",
    placeholder: "Search figures, tables, equations, sections…",
    empty: "No labels yet. Add \\label{…} after a caption or heading.",
    items: labels.map((l) => ({
      label: `${labelTitle(l)}${l.caption && l.number ? ` · ${shortText(l.caption, 60)}` : ""}`,
      sub: `${l.key} · ${l.file}:${l.line}`,
      icon: KIND_ICON[l.kind] || "hash",
      group: KIND_NAME[l.kind] || "Other",
      keywords: `${l.key} ${l.caption} ${l.kind}`,
      badge: l.refs.length ? `${l.refs.length}×` : REQUIRED.has(l.kind) ? "not referenced" : "",
      badgeClass: !l.refs.length && REQUIRED.has(l.kind) ? "warn" : "",
      run: () => insertRef(l.key, l.kind),
    })),
  });
}

export function citePicker() {
  const entries = state.analysis?.bibliography?.entries || [];
  picker({
    title: "Insert a citation",
    placeholder: "Search by author, title, year or key…",
    items: [
      { label: "Add a new source by DOI or arXiv ID…", icon: "plus", group: "New", keywords: "doi arxiv new add", run: doiDialog },
      ...entries.map((e) => ({
        label: e.title || e.key,
        sub: `${e.short ? `${e.short} · ` : ""}${e.key}`,
        icon: "book",
        group: "Bibliography",
        keywords: `${e.key} ${e.author} ${e.year} ${e.title}`,
        badge: e.cites.length ? `${e.cites.length}×` : "not cited",
        badgeClass: e.cites.length ? "" : "warn",
        run: () => insertCite(e.key),
      })),
    ],
  });
}

export function doiDialog() {
  const input = h("input", { type: "text", placeholder: "10.1038/nature14539  or  arXiv:1706.03762", spellcheck: "false", autofocus: true });
  const status = h("div", { class: "hint" }, "Paste a DOI, a doi.org link, or an arXiv ID or link. This looks it up online once.");
  const preview = h("textarea", { class: "bib-preview hidden", spellcheck: "false", rows: "9", "aria-label": "BibTeX entry" });
  const lookBtn = h("button", { class: "btn secondary", onclick: look }, "Look up");
  const addBtn = h("button", { class: "btn primary", disabled: true, onclick: add }, "Add and cite");
  let found = null;
  const d = dialog({
    title: "Add a source",
    body: h("div", null, h("div", { class: "field" }, h("label", null, "DOI or arXiv ID"),
      h("div", { class: "row-input" }, input, lookBtn), status), preview),
    footer: [h("span", { class: "grow" }), h("button", { class: "btn plain", onclick: () => d.close() }, "Cancel"), addBtn],
  });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") look(); });

  async function look() {
    if (!input.value.trim()) return;
    lookBtn.disabled = true;
    status.replaceChildren(h("span", { class: "spinner" }), " Looking it up…");
    try {
      found = await api.lookupCitation(input.value.trim());
      preview.value = found.bibtex;
      preview.classList.remove("hidden");
      status.textContent = `Found “${found.title}”. It will be added to ${found.file} as ${found.key}.`;
      addBtn.disabled = false;
      addBtn.focus();
    } catch (e) {
      status.textContent = e.message;
      status.classList.add("error-text");
    } finally {
      lookBtn.disabled = false;
    }
  }

  async function add() {
    if (!found) return;
    addBtn.disabled = true;
    try {
      const keyMatch = /@\w+\s*\{\s*([^,\s]+)/.exec(preview.value);
      const key = keyMatch ? keyMatch[1] : found.key;
      await api.addCitation(preview.value, found.file);
      d.close();
      await insertCite(key);
      requestAnalysis();
      if (!found.bibIncluded) {
        toast("Your document doesn't print a bibliography yet.", {
          kind: "info", timeout: 0,
          actions: [{ label: "Add it", onClick: () => editor.applyFix({}, { kind: "insertBibliography", bib: found.file.replace(/\.bib$/, "") }) }],
        });
      }
    } catch (e) {
      toast(e.message, { kind: "error" });
      addBtn.disabled = false;
    }
  }
}

// ── The References panel ──────────────────────────────────────────────
export function initRefsPanel(container) {
  let onlyProblems = false;
  const collapsed = new Set(["equation", "section", "chapter", "other", "theorem"]);

  function render() {
    const a = state.analysis;
    if (!a) { container.replaceChildren(h("div", { class: "side-empty" }, "Reading your document…")); return; }
    const labels = a.labels.filter((l) => l.kind !== "item");
    const entries = a.bibliography.entries;
    const missingCites = [...new Map(a.cites.filter((c) => !c.found).map((c) => [c.key, c])).values()];
    const missingRefs = [...new Map(a.refs.filter((r) => !r.found).map((r) => [r.key, r])).values()];
    const problems = (a.checks || []).filter((c) => c.severity !== "info").length;

    const head = h("div", { class: "rf-head" },
      h("span", { class: `rf-summary${problems ? " warn" : ""}` }, problems ? icon("warn", "sm") : icon("check-circle", "sm"),
        problems ? `${problems} to fix` : "All connected"),
      h("button", { class: "chip", "aria-pressed": String(onlyProblems), onclick: () => { onlyProblems = !onlyProblems; render(); } }, "Only problems"),
    );

    const groups = [];
    // Broken links first: they print as ?? or [?].
    if (missingRefs.length || missingCites.length) {
      groups.push(section("broken", "Pointing nowhere", missingRefs.length + missingCites.length, [
        ...missingRefs.map((r) => row({ icon: "err", cls: "err", title: `\\ref{${r.key}}`, sub: `No \\label with this name · ${r.file}:${r.line}`, onclick: () => editor.jumpTo(r.file, r.line) })),
        ...missingCites.map((c) => row({ icon: "err", cls: "err", title: `\\cite{${c.key}}`, sub: `Not in the bibliography · ${c.file}:${c.line}`, onclick: () => editor.jumpTo(c.file, c.line) })),
      ], false));
    }
    for (const kind of ["figure", "table", "algorithm", "listing", "equation", "theorem", "chapter", "section", "other"]) {
      let items = labels.filter((l) => l.kind === kind);
      if (onlyProblems) items = items.filter((l) => !l.refs.length && REQUIRED.has(kind));
      if (!items.length) continue;
      groups.push(section(kind, KIND_NAME[kind], items.length, items.map((l) => {
        const unref = !l.refs.length;
        return row({
          icon: KIND_ICON[kind] || "hash",
          title: kind === "figure" || kind === "table" ? `${l.number || KIND_NAME[kind]}${l.caption ? ` · ${shortText(l.caption, 40)}` : ""}` : labelTitle(l),
          sub: l.key,
          badge: unref ? (REQUIRED.has(kind) ? "not referenced" : "unused") : `${l.refs.length}×`,
          badgeCls: unref && REQUIRED.has(kind) ? "warn" : unref ? "muted" : "ok",
          uses: l.refs,
          onclick: () => editor.jumpTo(l.file, l.line),
          onInsert: () => insertRef(l.key, l.kind),
          insertLabel: "Insert a reference to this at the cursor",
        });
      }), collapsed.has(kind)));
    }
    const bibItems = (onlyProblems ? entries.filter((e) => !e.cites.length) : entries);
    if (bibItems.length || !onlyProblems) {
      const addBtn = h("button", { class: "icon-btn sm", title: "Add a source by DOI or arXiv ID", "aria-label": "Add a source", onclick: (e) => { e.stopPropagation(); doiDialog(); } }, icon("plus", "sm"));
      groups.push(section("bib", "Bibliography", entries.length, bibItems.length ? bibItems.map((e) => {
        const uncited = !e.cites.length && !a.bibliography.nociteAll;
        return row({
          icon: "book",
          title: e.title || e.key,
          sub: `${e.short ? `${e.short} · ` : ""}${e.key}`,
          badge: uncited ? "not cited" : a.bibliography.nociteAll && !e.cites.length ? "nocite" : `${e.cites.length}×`,
          badgeCls: uncited ? "warn" : "ok",
          uses: e.cites,
          onclick: () => editor.jumpTo(e.file, e.line),
          onInsert: () => insertCite(e.key),
          insertLabel: "Cite this at the cursor",
        });
      }) : [h("div", { class: "side-empty" }, a.bibliography.files.length ? "No entries in your .bib file yet." : "No bibliography yet. Use + to add a source by DOI.")], false, addBtn));
    }
    if (!groups.length) groups.push(h("div", { class: "side-empty" }, onlyProblems ? "Nothing to fix. Everything is referenced and cited." : "No figures, tables or references yet."));
    container.replaceChildren(head, ...groups);
  }

  function section(id, title, count, rows, startCollapsed, extra) {
    const key = `rf:${id}`;
    const isCollapsed = sectionState.has(key) ? sectionState.get(key) : startCollapsed;
    const headBtn = h("button", { class: "rf-sec-head", "aria-expanded": String(!isCollapsed), onclick: () => { sectionState.set(key, !isCollapsed); render(); } },
      icon(isCollapsed ? "chev-r" : "chev-d", "sm"), h("span", { class: "caption" }, title), h("span", { class: "rf-count" }, count), h("span", { class: "grow" }), extra || null);
    return h("div", { class: "rf-sec" }, headBtn, isCollapsed ? null : h("div", { class: "rf-rows" }, rows));
  }

  function row({ icon: ic, cls = "", title, sub, badge, badgeCls = "", uses, onclick, onInsert, insertLabel }) {
    const badgeEl = badge ? h("button", {
      class: `rf-badge ${badgeCls}`,
      title: uses && uses.length ? "Show where it's used" : "",
      onclick: (e) => {
        e.stopPropagation();
        if (!uses || !uses.length) return;
        if (uses.length === 1) return editor.jumpTo(uses[0].file, uses[0].line);
        showMenu(e.currentTarget, uses.map((u) => ({ label: `${u.file}:${u.line}`, icon: "file-text", onSelect: () => editor.jumpTo(u.file, u.line) })), { align: "end" });
      },
    }, badge) : null;
    return h("div", { class: `rf-row ${cls}`, role: "button", tabindex: "0", title: sub, onclick, onkeydown: (e) => { if (e.key === "Enter") onclick(); } },
      icon(ic, "sm rf-icon"),
      h("span", { class: "rf-text" }, h("span", { class: "rf-title" }, title), sub ? h("span", { class: "rf-sub" }, sub) : null),
      badgeEl,
      onInsert ? h("button", { class: "icon-btn sm rf-insert", title: insertLabel, "aria-label": insertLabel, onclick: (e) => { e.stopPropagation(); onInsert(); } }, icon("plus", "sm")) : null,
    );
  }

  const sectionState = new Map();
  on(["analysis"], render);
  render();
}
