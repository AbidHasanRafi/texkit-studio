// Editor pane: tabs, CodeMirror, autosave, completions, issue markers and quick fixes.

import { api } from "./api.js";
import { h, icon, debounce, toast, kbd, isMac, store, save, toggleMenu } from "./dom.js";
import { state, set, on, allIssues } from "./store.js";

const CM = window.CodeMirror;
export const settings = Object.assign(
  { autoCompile: true, fontSize: 14, wrap: true, spellcheck: false, formatIndent: 2, formatAlign: true, formatOnSave: false },
  store("settings", {}),
);
export function saveSettings(patch) {
  Object.assign(settings, patch);
  save("settings", settings);
  applySettings();
}

let cm, host, tabsEl, previewEl, emptyEl, statusEl, posEl, wordsEl, mainEl, autoBtn;
let suppressChange = false;
const saveTimers = new Map();
const issueMarks = [];
const index = new Map(); // path -> {labels, keys}

// ── Commands and environments offered by autocomplete ─────────────────
const COMMANDS = [
  ["section", "{}", "Section"], ["subsection", "{}", "Subsection"], ["subsubsection", "{}", "Sub-subsection"],
  ["chapter", "{}", "Chapter"], ["paragraph", "{}", "Paragraph heading"], ["textbf", "{}", "Bold"],
  ["textit", "{}", "Italic"], ["emph", "{}", "Emphasis"], ["texttt", "{}", "Monospace"], ["underline", "{}", "Underline"],
  ["textsc", "{}", "Small caps"], ["footnote", "{}", "Footnote"], ["cite", "{}", "Citation"], ["citep", "{}", "Citation (natbib)"],
  ["citet", "{}", "Textual citation (natbib)"], ["ref", "{}", "Reference"], ["eqref", "{}", "Equation reference"],
  ["autoref", "{}", "Reference with name"], ["cref", "{}", "Clever reference"], ["pageref", "{}", "Page reference"],
  ["label", "{}", "Label"], ["caption", "{}", "Caption"], ["includegraphics", "[width=\\linewidth]{}", "Image"],
  ["input", "{}", "Insert file"], ["include", "{}", "Include file"], ["usepackage", "{}", "Load package"],
  ["documentclass", "{}", "Document class"], ["begin", "{}", "Environment"], ["end", "{}", "End environment"],
  ["title", "{}", "Title"], ["author", "{}", "Author"], ["date", "{}", "Date"], ["maketitle", "", "Print title"],
  ["tableofcontents", "", "Contents"], ["listoffigures", "", "List of figures"], ["listoftables", "", "List of tables"],
  ["bibliography", "{}", "Bibliography file"], ["bibliographystyle", "{}", "Bibliography style"],
  ["printbibliography", "", "Print bibliography (biblatex)"], ["addbibresource", "{}", "Bibliography file (biblatex)"],
  ["newpage", "", "New page"], ["clearpage", "", "Clear page"], ["centering", "", "Centre"], ["noindent", "", "No indent"],
  ["item", "", "List item"], ["hline", "", "Table rule"], ["toprule", "", "Top rule (booktabs)"],
  ["midrule", "", "Middle rule (booktabs)"], ["bottomrule", "", "Bottom rule (booktabs)"],
  ["multicolumn", "{}{}{}", "Merged cells"], ["url", "{}", "URL"], ["href", "{}{}", "Link"],
  ["frac", "{}{}", "Fraction"], ["sqrt", "{}", "Square root"], ["sum", "", "Sum"], ["int", "", "Integral"],
  ["prod", "", "Product"], ["lim", "", "Limit"], ["infty", "", "Infinity"], ["partial", "", "Partial"],
  ["mathbf", "{}", "Bold maths"], ["mathrm", "{}", "Upright maths"], ["mathcal", "{}", "Calligraphic"],
  ["mathbb", "{}", "Blackboard bold"], ["text", "{}", "Text in maths"], ["left", "", "Left delimiter"],
  ["right", "", "Right delimiter"], ["cdot", "", "Centre dot"], ["times", "", "Times"], ["leq", "", "≤"], ["geq", "", "≥"],
  ["neq", "", "≠"], ["approx", "", "≈"], ["rightarrow", "", "→"], ["Rightarrow", "", "⇒"], ["alpha", "", "α"],
  ["beta", "", "β"], ["gamma", "", "γ"], ["delta", "", "δ"], ["epsilon", "", "ε"], ["theta", "", "θ"], ["lambda", "", "λ"],
  ["mu", "", "μ"], ["pi", "", "π"], ["sigma", "", "σ"], ["phi", "", "φ"], ["omega", "", "ω"], ["Delta", "", "Δ"],
  ["Sigma", "", "Σ"], ["Omega", "", "Ω"], ["hspace", "{}", "Horizontal space"], ["vspace", "{}", "Vertical space"],
  ["quad", "", "Space"], ["today", "", "Today's date"], ["newcommand", "{}{}", "Define command"], ["appendix", "", "Appendix"],
  ["linewidth", "", "Line width"], ["textwidth", "", "Text width"], ["columnwidth", "", "Column width"],
];
const ENVIRONMENTS = [
  "document", "abstract", "figure", "figure*", "table", "table*", "tabular", "itemize", "enumerate", "description",
  "equation", "equation*", "align", "align*", "gather", "multline", "cases", "matrix", "pmatrix", "bmatrix",
  "center", "flushleft", "flushright", "quote", "quotation", "verbatim", "minipage", "theorem", "lemma", "proof",
  "definition", "array", "tabularx", "longtable", "subfigure", "algorithm", "lstlisting", "tikzpicture", "frame",
];
const ENV_BODY = {
  itemize: "  \\item ", enumerate: "  \\item ", description: "  \\item[] ",
  figure: "  \\centering\n  \\includegraphics[width=\\linewidth]{}\n  \\caption{}\n  \\label{fig:}",
  table: "  \\centering\n  \\caption{}\n  \\label{tab:}\n  \\begin{tabular}{ll}\n    \n  \\end{tabular}",
};

// ── Setup ──────────────────────────────────────────────────────────────
let hooks = {};

/**
 * hooks: onCompile, onSync (show cursor line in PDF), onRefPicker, onCitePicker, onSymbolPicker,
 *        insertMenuItems() -> menu items, onInsertRef(key, kind), onInsertCite(key)
 */
export function initEditor(pane, opts) {
  hooks = opts;
  const { onCompile, issuesDrawer } = opts;
  tabsEl = h("div", { class: "tabs", role: "tablist", "aria-label": "Open files" });
  host = h("div", { class: "editor-host" });
  previewEl = h("div", { class: "preview hidden" });
  emptyEl = h("div", { class: "empty hidden" });
  posEl = h("span");
  wordsEl = h("span");
  mainEl = h("button", { class: "wide-only", title: "Open the main file", onclick: () => state.mainFile && openFile(state.mainFile) });
  autoBtn = h("button", { title: "Compile automatically after you stop typing", onclick: () => saveSettings({ autoCompile: !settings.autoCompile }) });
  statusEl = h("div", { class: "statusbar" }, posEl, wordsEl, mainEl, h("span", { class: "grow" }), autoBtn,
    h("span", { class: "wide-only" }, "UTF-8"));

  pane.append(tabsEl, h("div", { class: "editor-body" }, host, previewEl, emptyEl), issuesDrawer, statusEl);

  const mod = isMac ? "Cmd-" : "Ctrl-";
  const compileKey = () => { onCompile(); };
  const saveKey = async () => {  // Ctrl/⌘+S: optionally tidy the file first, like Prettier's format on save
    if (settings.formatOnSave) await formatDocument({ quiet: true });
    onCompile();
  };
  cm = CM(host, {
    value: "",
    mode: "stex",
    lineNumbers: true,
    lineWrapping: settings.wrap,
    matchBrackets: true,
    autoCloseBrackets: { pairs: "()[]{}", explode: "[]{}" },
    styleActiveLine: true,
    gutters: ["CodeMirror-linenumbers", "issue-gutter"],
    indentUnit: 2,
    tabSize: 2,
    inputStyle: "contenteditable",
    spellcheck: settings.spellcheck,
    extraKeys: {
      [`${mod}S`]: saveKey,
      "Shift-Alt-F": () => formatDocument(),
      [`${mod}Enter`]: compileKey,
      [`${mod}B`]: () => wrapSelection("textbf"),
      [`${mod}I`]: () => wrapSelection("textit"),
      [`${mod}/`]: "toggleComment",
      [`${mod}F`]: "findPersistent",
      [`${mod}Shift-J`]: () => hooks.onSync && hooks.onSync(),
      "Alt-R": () => hooks.onRefPicker && hooks.onRefPicker(),
      "Alt-C": () => hooks.onCitePicker && hooks.onCitePicker(),
      "Alt-S": () => hooks.onSymbolPicker && hooks.onSymbolPicker(),
      "Ctrl-Space": () => showHints(true),
      Tab: (c) => (c.somethingSelected() ? c.execCommand("indentMore") : c.replaceSelection("  ")),
      "Shift-Tab": "indentLess",
    },
  });
  cm.on("inputRead", (_c, change) => {
    if (cm.state.completionActive) return;
    const ch = change.text.join("");
    if (/^[A-Za-z\\{,/]$/.test(ch)) showHints(false);
  });
  cm.on("cursorActivity", updatePosition);
  setupLinks();
  setupImageDrop();
  applySettings();

  on(["tabs", "active"], renderTabs);
  on(["active", "compile", "analysis"], renderMarkers);
  on(["mainFile"], renderStatus);
  renderTabs();
  renderStatus();
  showEmpty();
  return cm;
}

function applySettings() {
  if (!cm) return;
  document.documentElement.style.setProperty("--editor-font", `${settings.fontSize}px`);
  cm.setOption("lineWrapping", settings.wrap);
  cm.setOption("spellcheck", settings.spellcheck);
  cm.refresh();
  renderStatus();
}

export function refresh() { cm && cm.refresh(); }
export function activeTab() { return state.tabs.find((t) => t.path === state.active) || null; }
export function activeText() { const t = activeTab(); return t && t.doc ? t.doc.getValue() : ""; }

// ── Tabs ───────────────────────────────────────────────────────────────
function renderTabs() {
  tabsEl.replaceChildren(...state.tabs.map((t) => {
    const name = t.path.split("/").pop();
    const el = h("div", {
      class: `tab${t.path === state.active ? " active" : ""}${t.dirty ? " dirty" : ""}`, role: "tab", tabindex: "0",
      "aria-selected": String(t.path === state.active), title: t.path,
      onclick: () => openFile(t.path),
      onauxclick: (e) => { if (e.button === 1) closeTab(t.path); },
      onkeydown: (e) => { if (e.key === "Enter") openFile(t.path); },
    },
      icon(t.kind === "bib" ? "book" : t.kind === "image" ? "image" : t.kind === "pdf" ? "file-pdf" : "file-text", "sm"),
      h("span", { class: "label" }, name),
      h("button", { class: "x", "aria-label": `Close ${name}`, onclick: (e) => { e.stopPropagation(); closeTab(t.path); } }, icon("x", "sm")),
    );
    return el;
  }), h("span", { class: "spacer" }), ...editorTools());
  const activeEl = tabsEl.querySelector(".tab.active");
  if (activeEl) activeEl.scrollIntoView({ block: "nearest", inline: "nearest" });
}

const opening = new Map(); // path -> pending read, so two quick opens don't create two tabs

let toolButtons = null;
function editorTools() {
  if (!toolButtons) {
    const insertBtn = h("button", { class: "tool-btn", "aria-haspopup": "menu", title: "Insert a figure, table, reference, citation…" },
      icon("plus", "sm"), h("span", { class: "tb-label" }, "Insert"), icon("chev-d", "sm"));
    insertBtn.addEventListener("click", () => toggleMenu(insertBtn, () => hooks.insertMenuItems ? hooks.insertMenuItems() : [], { align: "end" }));
    const refBtn = h("button", { class: "icon-btn sm tool-wide", title: `Insert a reference (${kbd("Alt-R")})`, "aria-label": "Insert a reference", onclick: () => hooks.onRefPicker() }, icon("link", "sm"));
    const citeBtn = h("button", { class: "icon-btn sm tool-wide", title: `Insert a citation (${kbd("Alt-C")})`, "aria-label": "Insert a citation", onclick: () => hooks.onCitePicker() }, icon("quote", "sm"));
    const syncBtn = h("button", { class: "icon-btn sm", title: `Show this line in the PDF (${kbd("Mod-Shift-J")})`, "aria-label": "Show this line in the PDF", onclick: () => hooks.onSync() }, icon("target", "sm"));
    const formatBtn = h("button", { class: "icon-btn sm", title: `Format document (${kbd("Shift-Alt-F")})`, "aria-label": "Format document", onclick: () => formatDocument() }, icon("wand", "sm"));
    toolButtons = [refBtn, citeBtn, insertBtn, formatBtn, syncBtn];
  }
  return toolButtons;
}

/**
 * Tidy the open .tex or .bib file (indentation, aligned tables, tidy entries), like Prettier.
 * Only the changed lines are replaced, as one undo step, so the cursor and scroll stay put.
 */
export async function formatDocument({ quiet = false } = {}) {
  const tab = activeTab();
  if (!tab || !tab.doc || !/\.(tex|bib|sty|cls|ltx|dtx|tikz)$/i.test(tab.path)) {
    if (!quiet) toast("Formatting works for .tex and .bib files.");
    return false;
  }
  if (tab.readOnly) return false;
  const doc = tab.doc;
  const before = doc.getValue();
  let r;
  try {
    r = await api.format(tab.path, before, { indent: settings.formatIndent, alignTables: settings.formatAlign });
  } catch (e) {
    toast(`Couldn't format ${tab.path}: ${e.message}`, { kind: "error", timeout: 7000 });
    return false;
  }
  if (doc.getValue() !== before) return false;  // the user kept typing meanwhile: don't clobber it
  if (!r.changed) {
    if (!quiet) toast("Already tidy. Nothing to format.", { kind: "ok", timeout: 2000 });
    return true;
  }
  const a = before.split("\n"), b = r.content.replace(/\r\n/g, "\n").split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1, endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB--; }
  const replacement = b.slice(start, endB + 1).join("\n");
  if (endB < start) {  // only lines removed (e.g. extra blank lines): take their line breaks too
    if (endA + 1 < a.length) doc.replaceRange("", { line: start, ch: 0 }, { line: endA + 1, ch: 0 }, "+format");
    else doc.replaceRange("", { line: start - 1, ch: a[start - 1].length }, { line: endA, ch: a[endA].length }, "+format");
  } else if (endA < start) {  // only lines added
    doc.replaceRange(`${replacement}\n`, { line: start, ch: 0 }, { line: start, ch: 0 }, "+format");
  } else {
    doc.replaceRange(replacement, { line: start, ch: 0 }, { line: endA, ch: a[endA].length }, "+format");
  }
  if (!quiet) {
    const n = Math.max(endA, endB) - start + 1;
    toast(`Formatted ${tab.path.split("/").pop()} (${n} line${n === 1 ? "" : "s"} tidied).`, {
      kind: "ok", timeout: 3000, actions: [{ label: "Undo", onClick: () => doc.undo() }],
    });
  }
  return true;
}

/** Where the cursor is, for "show in PDF". */
export function cursorLocation() {
  const tab = activeTab();
  if (!tab || !tab.doc) return null;
  return { file: tab.path, line: tab.doc.getCursor().line + 1 };
}

export async function openFile(path, { line = null, focus = true } = {}) {
  let tab = state.tabs.find((t) => t.path === path);
  if (!tab && opening.has(path)) {
    await opening.get(path);
    tab = state.tabs.find((t) => t.path === path);
  }
  if (!tab) {
    let info;
    const read = api.read(path);
    opening.set(path, read.catch(() => null));
    try { info = await read; } catch (e) { toast(`Couldn't open ${path}: ${e.message}`, { kind: "error" }); return null; }
    finally { opening.delete(path); }
    tab = { path, kind: info.kind, hash: info.hash, dirty: false, readOnly: !!info.readOnly, gen: 0, saving: false, doc: null };
    if ("content" in info) {
      tab.doc = CM.Doc(info.content, "stex");
      tab.doc.on("change", () => onDocChange(tab));
    }
    set({ tabs: [...state.tabs, tab] });
  }
  set({ active: path });
  showTab(tab);
  if (line) jumpToLine(line);
  else if (focus && tab.doc && window.matchMedia("(pointer: fine)").matches) cm.focus();
  return tab;
}

function showTab(tab) {
  emptyEl.classList.add("hidden");
  if (tab.doc) {
    previewEl.classList.add("hidden");
    previewEl.replaceChildren();
    host.classList.remove("hidden");
    cm.swapDoc(tab.doc);
    cm.setOption("readOnly", tab.readOnly);
    cm.refresh();
  } else {
    host.classList.add("hidden");
    previewEl.classList.remove("hidden");
    const url = api.rawUrl(tab.path);
    if (tab.kind === "image" && !/\.(eps|tiff?)$/i.test(tab.path)) previewEl.replaceChildren(h("img", { src: url, alt: tab.path }));
    else if (tab.kind === "pdf") previewEl.replaceChildren(h("iframe", { src: url, title: tab.path }));
    else previewEl.replaceChildren(h("div", { class: "empty-card" }, h("div", { class: "big-icon" }, icon("file", "lg")),
      h("h2", null, tab.path.split("/").pop()), h("p", null, "This file can't be shown or edited here.")));
  }
  updatePosition();
  set({ docTick: Date.now() });
}

export function showEmpty(content) {
  if (state.tabs.length && !content) return;
  host.classList.add("hidden");
  previewEl.classList.add("hidden");
  emptyEl.classList.remove("hidden");
  emptyEl.replaceChildren(content || h("div", { class: "empty-card" },
    h("div", { class: "big-icon" }, icon("file-text", "lg")),
    h("h2", null, "No file open"),
    h("p", null, "Pick a file from the sidebar to start editing."),
  ));
}

export async function closeTab(path) {
  const tab = state.tabs.find((t) => t.path === path);
  if (!tab) return;
  if (tab.dirty) await saveTab(tab);
  const i = state.tabs.indexOf(tab);
  const tabs = state.tabs.filter((t) => t !== tab);
  let active = state.active;
  if (active === path) active = (tabs[i] || tabs[i - 1] || {}).path || null;
  set({ tabs, active });
  if (active) openFile(active, { focus: false });
  else showEmpty();
}

export function closeAll() {
  saveTimers.forEach((t) => clearTimeout(t));
  saveTimers.clear();
  index.clear();
  set({ tabs: [], active: null });
  cm.swapDoc(CM.Doc("", "stex"));
}

export function renamePath(from, to) {
  const tabs = state.tabs.map((t) => {
    if (t.path === from || t.path.startsWith(`${from}/`)) return Object.assign(t, { path: to + t.path.slice(from.length) });
    return t;
  });
  const active = state.active && (state.active === from || state.active.startsWith(`${from}/`)) ? to + state.active.slice(from.length) : state.active;
  set({ tabs, active });
}

export function dropPath(path) {
  for (const t of [...state.tabs]) if (t.path === path || t.path.startsWith(`${path}/`)) {
    t.dirty = false;
    closeTab(t.path);
  }
}

// ── Saving ─────────────────────────────────────────────────────────────
let onAfterSave = () => {};
export function setAfterSave(fn) { onAfterSave = fn; }

function onDocChange(tab) {
  if (suppressChange) return;
  tab.gen += 1;
  if (!tab.dirty) { tab.dirty = true; renderTabs(); }
  clearTimeout(saveTimers.get(tab.path));
  saveTimers.set(tab.path, setTimeout(() => saveTab(tab).then((ok) => ok && onAfterSave()), 700));
  if (tab.path === state.active) { updateWords(); bumpDoc(); }
  reindexSoon(tab);
}
const bumpDoc = debounce(() => set({ docTick: Date.now() }), 300);

async function saveTab(tab) {
  if (!tab.dirty || !tab.doc || tab.readOnly) return true;
  if (tab.saving) return tab.saving;
  const gen = tab.gen;
  const run = (async () => {
    try {
      const r = await api.write(tab.path, tab.doc.getValue(), tab.hash);
      tab.hash = r.hash;
      if (tab.gen === gen) tab.dirty = false;
      return true;
    } catch (e) {
      if (e.status === 409) conflict(tab);
      else toast(`Couldn't save ${tab.path}: ${e.message}`, { kind: "error" });
      return false;
    } finally {
      tab.saving = false;
      renderTabs();
    }
  })();
  tab.saving = run;
  return run;
}

export async function saveAll() {
  saveTimers.forEach((t) => clearTimeout(t));
  saveTimers.clear();
  const results = await Promise.all(state.tabs.filter((t) => t.dirty).map(saveTab));
  return results.every(Boolean);
}

function conflict(tab) {
  toast(`${tab.path} was changed by another program.`, {
    kind: "error", timeout: 0,
    actions: [
      { label: "Reload from disk", onClick: () => reloadTab(tab, true) },
      { label: "Keep mine", onClick: async () => {
        const r = await api.write(tab.path, tab.doc.getValue(), tab.hash, true);
        tab.hash = r.hash; tab.dirty = false; renderTabs(); onAfterSave();
      } },
    ],
  });
}

async function reloadTab(tab, force = false) {
  if (!tab.doc || (tab.dirty && !force)) return;
  let info;
  try { info = await api.read(tab.path); } catch { dropPath(tab.path); return; }
  if (info.hash === tab.hash && !force) return;
  const cursor = tab.doc.getCursor();
  const scroll = tab.path === state.active ? cm.getScrollInfo() : null;
  suppressChange = true;
  tab.doc.setValue(info.content);
  suppressChange = false;
  tab.doc.setCursor(cursor);
  if (scroll) cm.scrollTo(scroll.left, scroll.top);
  tab.hash = info.hash;
  tab.dirty = false;
  renderTabs();
}

/** Files changed outside the studio: reload clean tabs, warn about edited ones. */
export function externalChange(paths) {
  for (const tab of state.tabs) {
    if (!paths.includes(tab.path)) continue;
    if (tab.dirty) conflict(tab);
    else reloadTab(tab);
  }
}

// ── Navigation & fixes ────────────────────────────────────────────────
function jumpToLine(line) {
  const ln = Math.max(0, Math.min(line - 1, cm.lineCount() - 1));
  cm.setCursor({ line: ln, ch: 0 });
  cm.scrollIntoView({ line: ln, ch: 0 }, Math.round(cm.getScrollInfo().clientHeight / 3));
  const handle = cm.addLineClass(ln, "background", "cm-flash");
  setTimeout(() => cm.removeLineClass(handle, "background", "cm-flash"), 1200);
  cm.focus();
}

export async function jumpTo(file, line) {
  if (window.matchMedia("(max-width: 1023px)").matches) set({ pane: "editor" });
  const target = file || state.mainFile;
  if (!target) return;
  await openFile(target, { line: line || null });
}

export async function applyFix(issue, fix) {
  if (fix.kind === "replace") {
    const tab = await openFile(issue.file || state.mainFile, { line: issue.line });
    if (!tab || !tab.doc) return;
    const doc = tab.doc;
    const ln = (issue.line || 1) - 1;
    let pos = null;
    const idx = doc.getLine(ln)?.indexOf(fix.from) ?? -1;
    if (idx >= 0) pos = { line: ln, ch: idx };
    else {
      const cur = doc.getSearchCursor ? cm.getSearchCursor(fix.from) : null;
      if (cur && cur.findNext()) pos = cur.from();
    }
    if (!pos) { toast(`Couldn't find ${fix.from} in the file any more.`); return; }
    doc.replaceRange(fix.to, pos, { line: pos.line, ch: pos.ch + fix.from.length });
    toast(`Replaced ${fix.from} with ${fix.to}`, { kind: "ok", actions: [{ label: "Undo", onClick: () => doc.undo() }] });
  } else if (fix.kind === "insertPackage") {
    const tab = await openFile(state.mainFile);
    if (!tab || !tab.doc) return;
    const doc = tab.doc;
    let at = -1, docStart = -1, cls = -1;
    doc.eachLine((lh) => {
      const n = doc.getLineNumber(lh), t = lh.text;
      if (/^\s*\\usepackage/.test(t) && docStart < 0) at = n;
      if (/^\s*\\documentclass/.test(t) && cls < 0) cls = n;
      if (/^\s*\\begin\{document\}/.test(t) && docStart < 0) docStart = n;
    });
    const line = at >= 0 ? at + 1 : docStart >= 0 ? docStart : cls + 1;
    doc.replaceRange(`\\usepackage{${fix.package}}\n`, { line: Math.max(0, line), ch: 0 });
    jumpToLine(Math.max(0, line) + 1);
    toast(`Added \\usepackage{${fix.package}}`, { kind: "ok", actions: [{ label: "Undo", onClick: () => doc.undo() }] });
  } else if (fix.kind === "addLabel") {
    const tab = await openFile(issue.file, { line: fix.line });
    if (!tab || !tab.doc) return;
    const doc = tab.doc;
    // Put the label right after the caption (it must come after \caption to get the right number).
    let at = null, end = null;
    for (let i = fix.line - 1; i < Math.min(doc.lineCount(), fix.line + 60); i++) {
      const t = doc.getLine(i);
      if (/\\caption/.test(t)) at = i;
      if (/\\end\s*\{(figure|table|algorithm|lstlisting|listing|subfigure|subtable|wrapfigure|wraptable)\*?\}/.test(t)) { end = i; break; }
    }
    let line = at != null ? at : (end != null ? end - 1 : fix.line - 1);
    if (at != null) {  // a caption can span lines: move past its closing brace
      let depth = 0;
      for (let i = at; i <= (end ?? at + 10) && i < doc.lineCount(); i++) {
        for (const ch of doc.getLine(i)) { if (ch === "{") depth++; else if (ch === "}") depth--; }
        line = i;
        if (depth <= 0) break;
      }
    }
    const indent = /^\s*/.exec(doc.getLine(line))[0];
    doc.replaceRange(`\n${indent}\\label{${fix.labelKey}}`, { line, ch: doc.getLine(line).length });
    jumpToLine(line + 2);
    toast(`Added \\label{${fix.labelKey}}. Now refer to it with Insert → Reference.`, { kind: "ok", actions: [{ label: "Undo", onClick: () => doc.undo() }] });
  } else if (fix.kind === "insertRef") {
    hooks.onInsertRef && hooks.onInsertRef(fix.key, fix.refKind);
  } else if (fix.kind === "insertCite") {
    hooks.onInsertCite && hooks.onInsertCite(fix.key);
  } else if (fix.kind === "insertBibliography") {
    const tab = await openFile(state.mainFile);
    if (!tab || !tab.doc) return;
    const doc = tab.doc;
    let endLine = doc.lineCount();
    doc.eachLine((lh) => { if (/^\s*\\end\{document\}/.test(lh.text)) endLine = doc.getLineNumber(lh); });
    doc.replaceRange(`\\bibliographystyle{plain}\n\\bibliography{${fix.bib || "references"}}\n\n`, { line: endLine, ch: 0 });
    jumpToLine(endLine + 1);
    toast("Added the bibliography before \\end{document}.", { kind: "ok", actions: [{ label: "Undo", onClick: () => doc.undo() }] });
  }
}

/** Make sure the active tab is an editable .tex file (falling back to the main file). */
async function editableTab() {
  let tab = activeTab();
  if (!tab || !tab.doc || tab.readOnly || tab.kind !== "tex") {
    if (!state.mainFile) { toast("Open a .tex file first.", { kind: "error" }); return null; }
    tab = await openFile(state.mainFile);
  }
  if (window.matchMedia("(max-width: 1023px)").matches) set({ pane: "editor" });
  return tab && tab.doc ? tab : null;
}

/** Insert text at the cursor. With smartSpace, a space or ~ is added after a word. */
export async function insertAtCursor(text, { smartSpace = false, selectFrom = null, selectLen = 0 } = {}) {
  const tab = await editableTab();
  if (!tab) return false;
  const doc = tab.doc;
  const cur = doc.getCursor();
  let t = text;
  if (smartSpace) {
    const before = doc.getLine(cur.line).slice(0, cur.ch);
    if (/[^\s~({\[]$/.test(before)) t = (text.startsWith("\\") ? "~" : " ") + t;
  }
  doc.replaceRange(t, cur);
  if (selectFrom != null) {
    const start = doc.indexFromPos(cur) + (t.length - text.length) + selectFrom;
    doc.setSelection(doc.posFromIndex(start), doc.posFromIndex(start + selectLen));
  }
  cm.focus();
  return true;
}

/** Cite `key`: added to the \cite{...} the cursor is in, or as a new \cite. */
export async function insertCitation(key) {
  const tab = await editableTab();
  if (!tab) return false;
  const doc = tab.doc;
  const cur = doc.getCursor();
  const line = doc.getLine(cur.line);
  const before = line.slice(0, cur.ch);
  const m = /\\[a-zA-Z]*cite[a-zA-Z]*\*?(?:\[[^\]]*\])*\{([^}]*)$/.exec(before);
  if (m) {
    const close = line.indexOf("}", cur.ch);
    if (/[{,]\s*$/.test(before)) doc.replaceRange(key, cur);
    else doc.replaceRange(`,${key}`, { line: cur.line, ch: close >= 0 ? close : cur.ch });
    cm.focus();
    return true;
  }
  return insertAtCursor(`\\cite{${key}}`, { smartSpace: true });
}

/** Upload images into figures/ and insert a figure environment for each. */
export async function insertImages(files) {
  const tab = await editableTab();
  if (!tab) return;
  const existing = new Set();
  const walk = (nodes) => nodes.forEach((n) => (n.type === "dir" ? walk(n.children || []) : existing.add(n.path)));
  walk(state.tree);
  const renamed = files.map((f) => {
    let name = f.name.replace(/[^\w.-]+/g, "-").replace(/^-+/, "") || "image.png";
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : ".png";
    let n = 2;
    while (existing.has(`figures/${name}`)) name = `${stem}-${n++}${ext}`;
    existing.add(`figures/${name}`);
    return new File([f], name, { type: f.type });
  });
  let saved;
  try { saved = (await api.upload("figures", renamed)).saved; } catch (e) { toast(`Couldn't add the image: ${e.message}`, { kind: "error" }); return; }
  const doc = tab.doc;
  const cur = doc.getCursor();
  const indentAt = doc.getLine(cur.line).trim() ? "\n" : "";
  const blocks = saved.map((p) => {
    const stem = p.replace(/^figures\//, "").replace(/\.[^.]+$/, "");
    const slug = stem.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "figure";
    return `\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=0.8\\linewidth]{figures/${stem}}\n  \\caption{Describe this figure.}\n  \\label{fig:${slug}}\n\\end{figure}\n`;
  });
  const text = indentAt + blocks.join("\n");
  const start = doc.indexFromPos({ line: cur.line, ch: doc.getLine(cur.line).length });
  doc.replaceRange(text, doc.posFromIndex(start));
  // Select the first caption so the user can type over it.
  const cap = start + text.indexOf("Describe this figure.");
  doc.setSelection(doc.posFromIndex(cap), doc.posFromIndex(cap + "Describe this figure.".length));
  cm.focus();
  hooks.ensurePackage && hooks.ensurePackage("graphicx");
  toast(`Added ${saved.length === 1 ? saved[0] : `${saved.length} images`} as a figure. Type its caption now.`, { kind: "ok" });
}

function setupImageDrop() {
  const isImage = (f) => /\.(png|jpe?g|pdf|eps)$/i.test(f.name) || /^image\/(png|jpeg)$/.test(f.type);
  cm.on("drop", (_c, e) => {
    const files = [...(e.dataTransfer?.files || [])].filter(isImage);
    if (!files.length) return;
    e.preventDefault();
    cm.setCursor(cm.coordsChar({ left: e.clientX, top: e.clientY }, "window"));
    insertImages(files);
  });
  cm.on("paste", (_c, e) => {
    const items = [...(e.clipboardData?.items || [])].filter((it) => it.kind === "file" && /^image\//.test(it.type));
    if (!items.length) return;
    e.preventDefault();
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "").replace(/^(\d{8})/, "$1-");
    insertImages(items.map((it, i) => {
      const f = it.getAsFile();
      const ext = it.type === "image/jpeg" ? "jpg" : "png";
      return new File([f], `pasted-${stamp}${i ? `-${i + 1}` : ""}.${ext}`, { type: it.type });
    }));
  });
}

// ── Links: hover cards and Ctrl/⌘+click to go to definitions ──────────
const REF_CMD = /^(ref|eqref|autoref|Autoref|cref|Cref|pageref|nameref|vref|vpageref|subref|labelcref|cpageref|Cpageref)$/;

/** What's under `pos`: a \ref, \cite, \label, \input or \includegraphics key. */
function linkAt(pos) {
  const line = cm.getLine(pos.line) || "";
  for (const m of line.matchAll(/\\([a-zA-Z]+)\*?\s*(?:\[[^\]]*\]\s*)*\{([^}]*)\}/g)) {
    const open = m.index + m[0].lastIndexOf("{") + 1;
    const close = m.index + m[0].length - 1;
    if (pos.ch < open || pos.ch > close) continue;
    const cmd = m[1];
    let type = null;
    if (REF_CMD.test(cmd)) type = "ref";
    else if (/cite/i.test(cmd)) type = "cite";
    else if (cmd === "label") type = "label";
    else if (cmd === "input" || cmd === "include" || cmd === "subfile") type = "input";
    else if (cmd === "includegraphics") type = "graphic";
    if (!type) return null;
    let offset = open;
    for (const part of m[2].split(",")) {
      const lead = part.length - part.trimStart().length;
      const key = part.trim();
      if (pos.ch >= offset && pos.ch <= offset + part.length && key) {
        return { type, cmd, key, from: { line: pos.line, ch: offset + lead }, to: { line: pos.line, ch: offset + lead + key.length } };
      }
      offset += part.length + 1;
    }
    return null;
  }
  return null;
}

function describe(link) {
  const a = state.analysis;
  if (!a) return null;
  if (link.type === "ref") {
    const l = a.labels.find((x) => x.key === link.key);
    if (!l) return { warn: true, title: `No \\label{${link.key}} in the document`, sub: "This prints as ??." };
    const name = l.number || ({ equation: "Equation", section: "Section", chapter: "Chapter" }[l.kind] || "Label");
    return { title: `${name}${l.caption ? ` · ${l.caption}` : ""}`, sub: `${l.file}:${l.line} · ${kbd("Mod-")}click to go there` };
  }
  if (link.type === "cite") {
    const e = a.bibliography.entries.find((x) => x.key === link.key);
    if (!e) return { warn: true, title: `“${link.key}” isn't in your bibliography`, sub: "This prints as [?]. Add it with Insert → Citation → Add by DOI." };
    return { title: e.title || e.key, sub: `${e.short || e.key} · cited ${e.cites.length}× · ${kbd("Mod-")}click to open` };
  }
  if (link.type === "label") {
    const l = a.labels.find((x) => x.key === link.key);
    const n = l ? l.refs.length : 0;
    const required = l && ["figure", "table", "algorithm", "listing"].includes(l.kind);
    return n ? { title: `Referred to ${n}× in the text`, sub: `${kbd("Mod-")}click to go to the first mention` }
      : { warn: !!required, title: required ? "Never referred to in the text" : "Not referred to yet", sub: required ? "Journals usually require every figure and table to be mentioned." : "" };
  }
  if (link.type === "graphic") {
    const g = a.graphics.find((x) => x.key === link.key);
    return g && g.resolved ? { title: g.resolved, sub: `${kbd("Mod-")}click to view the image` } : { warn: true, title: `Image not found: ${link.key}`, sub: "" };
  }
  if (link.type === "input") return { title: `${link.key}`, sub: `${kbd("Mod-")}click to open the file` };
  return null;
}

async function follow(link) {
  const a = state.analysis;
  if (!a) return;
  if (link.type === "ref") {
    const l = a.labels.find((x) => x.key === link.key);
    if (l) jumpTo(l.file, l.line);
  } else if (link.type === "cite") {
    const e = a.bibliography.entries.find((x) => x.key === link.key);
    if (e) jumpTo(e.file, e.line);
  } else if (link.type === "label") {
    const l = a.labels.find((x) => x.key === link.key);
    if (l && l.refs.length) jumpTo(l.refs[0].file, l.refs[0].line);
  } else if (link.type === "graphic") {
    const g = a.graphics.find((x) => x.key === link.key);
    if (g && g.resolved) openFile(g.resolved);
  } else if (link.type === "input") {
    const target = a.files.find((f) => f === link.key || f === `${link.key}.tex` || f.endsWith(`/${link.key}.tex`) || f.endsWith(`/${link.key}`));
    if (target) openFile(target);
  }
}

let tip, tipTimer;
function hideTip() { clearTimeout(tipTimer); if (tip) tip.classList.add("hidden"); }
function showTip(x, y, info) {
  if (!tip) { tip = h("div", { class: "cm-tip hidden", role: "tooltip" }); document.body.append(tip); }
  tip.replaceChildren(h("div", { class: `tip-title${info.warn ? " warn" : ""}` }, info.warn ? icon("warn", "sm") : null, info.title),
    info.sub ? h("div", { class: "tip-sub" }, info.sub) : null);
  tip.classList.remove("hidden");
  const w = tip.offsetWidth, hgt = tip.offsetHeight;
  tip.style.left = `${Math.max(8, Math.min(x - 12, window.innerWidth - w - 8))}px`;
  tip.style.top = `${y + 18 + hgt > window.innerHeight ? y - hgt - 10 : y + 18}px`;
}

function setupLinks() {
  const wrapper = cm.getWrapperElement();
  let lastKey = null;
  wrapper.addEventListener("mousemove", (e) => {
    const pos = cm.coordsChar({ left: e.clientX, top: e.clientY }, "window");
    const link = linkAt(pos);
    const id = link ? `${link.type}:${link.key}:${pos.line}` : null;
    wrapper.classList.toggle("link-hover", !!link && (isMac ? e.metaKey : e.ctrlKey));
    if (id === lastKey) return;
    lastKey = id;
    hideTip();
    if (!link) return;
    const info = describe(link);
    if (info) tipTimer = setTimeout(() => showTip(e.clientX, e.clientY, info), 350);
  });
  wrapper.addEventListener("mouseleave", () => { lastKey = null; hideTip(); });
  wrapper.addEventListener("mousedown", (e) => {
    hideTip();
    if (!(isMac ? e.metaKey : e.ctrlKey) || e.button !== 0) return;
    const link = linkAt(cm.coordsChar({ left: e.clientX, top: e.clientY }, "window"));
    if (!link) return;
    e.preventDefault();
    follow(link);
  }, true);
  cm.on("keydown", hideTip);
  cm.on("scroll", hideTip);
}

function wrapSelection(command) {
  const sel = cm.getSelection();
  cm.replaceSelection(`\\${command}{${sel}}`, "around");
  if (!sel) {
    const c = cm.getCursor();
    cm.setCursor({ line: c.line, ch: c.ch - 1 });
  } else {
    const [s] = cm.listSelections();
    const from = CM.cmpPos(s.anchor, s.head) < 0 ? s.anchor : s.head;
    const to = CM.cmpPos(s.anchor, s.head) < 0 ? s.head : s.anchor;
    cm.setSelection({ line: from.line, ch: from.ch + command.length + 2 }, { line: to.line, ch: to.ch - 1 });
  }
}

// ── Issue markers ──────────────────────────────────────────────────────
function renderMarkers() {
  if (!cm) return;
  cm.clearGutter("issue-gutter");
  issueMarks.splice(0).forEach((m) => m.clear());
  const tab = activeTab();
  if (!tab || !tab.doc) return;
  for (const issue of allIssues()) {
    if (issue.file !== tab.path || !issue.line || issue.severity === "info") continue;
    const ln = issue.line - 1;
    if (ln >= cm.lineCount()) continue;
    const existing = cm.lineInfo(ln)?.gutterMarkers?.["issue-gutter"];
    if (!existing || (issue.severity === "error" && !existing.classList.contains("error"))) {
      cm.setGutterMarker(ln, "issue-gutter", h("div", { class: `gutter-mark ${issue.severity}`, title: issue.title }));
    }
    const token = issue.token || issue.key;
    if (!token) continue;
    const text = cm.getLine(ln);
    // Analysis checks know the exact column; compile errors only know the command.
    const idx = issue.col != null && text.substr(issue.col, token.length) === token ? issue.col : text.indexOf(token);
    if (idx >= 0) {
      const cls = issue.rule === "float-unreferenced" ? "cm-unref" : `cm-squiggle-${issue.severity}`;
      issueMarks.push(cm.markText({ line: ln, ch: idx }, { line: ln, ch: idx + token.length }, { className: cls }));
    }
  }
}

// ── Status bar ─────────────────────────────────────────────────────────
function updatePosition() {
  if (!cm) return;
  const tab = activeTab();
  if (!tab || !tab.doc) { posEl.textContent = ""; wordsEl.textContent = ""; return; }
  const c = cm.getCursor();
  posEl.textContent = `Ln ${c.line + 1}, Col ${c.ch + 1}`;
  if (state.cursorLine !== c.line) set({ cursorLine: c.line });
  updateWords();
}

function countWords(source) {
  const text = source
    .replace(/(^|[^\\])%.*$/gm, "$1")
    .replace(/\\(begin|end)\{[^}]*\}/g, " ")
    .replace(/\\[a-zA-Z@]+\*?(\[[^\]]*\])?/g, " ")
    .replace(/\$[^$]*\$/g, " x ")
    .replace(/[{}]/g, " ");
  return (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
}

let totalWords = { doc: null, gen: -1, n: 0 };  // whole-document count, recomputed only when the text changes

/** Shows the document's word count, or "N of M words" while text is selected. */
const updateWords = debounce(() => {
  const tab = activeTab();
  if (!tab || !tab.doc || tab.kind !== "tex") { wordsEl.textContent = ""; return; }
  const gen = tab.doc.changeGeneration();
  if (totalWords.doc !== tab.doc || totalWords.gen !== gen) totalWords = { doc: tab.doc, gen, n: countWords(tab.doc.getValue()) };
  const selection = cm.somethingSelected() ? cm.getSelections().join("\n") : "";
  const picked = selection ? countWords(selection) : 0;
  wordsEl.textContent = picked ? `${picked.toLocaleString()} of ${totalWords.n.toLocaleString()} words` : `${totalWords.n.toLocaleString()} words`;
  wordsEl.classList.toggle("selected", picked > 0);
}, 120);

function renderStatus() {
  if (!autoBtn) return;
  autoBtn.replaceChildren(h("span", { class: `led${settings.autoCompile ? " on" : ""}` }), `Auto-compile ${settings.autoCompile ? "on" : "off"}`);
  mainEl.textContent = state.mainFile ? `Main: ${state.mainFile}` : "No main file";
}

// ── Completions ────────────────────────────────────────────────────────
function showHints(explicit) {
  const result = latexHint(cm);
  if (!result || (!explicit && !result.list.length)) return;
  cm.showHint({ hint: latexHint, completeSingle: false, closeCharacters: /[\s()\[\]{};>,]/ });
}

function item(text, info, apply) {
  return {
    text,
    render: (el) => { el.append(h("span", null, text), info ? h("span", { class: "hint-info" }, info) : null); },
    hint: apply,
  };
}

function filesOfKind(exts, stripExt) {
  const out = [];
  const walk = (nodes) => nodes.forEach((n) => {
    if (n.type === "dir") walk(n.children || []);
    else if (exts.some((e) => n.name.toLowerCase().endsWith(e))) out.push(stripExt ? n.path.replace(/\.[^.\/]+$/, "") : n.path);
  });
  walk(state.tree);
  return out;
}

function latexHint(editor) {
  const cur = editor.getCursor();
  const before = editor.getLine(cur.line).slice(0, cur.ch);
  const Pos = CM.Pos;
  let m;
  const pick = (list, typed, start, mapper) => {
    const t = typed.toLowerCase();
    const items = list.filter((x) => x.toLowerCase().includes(t)).sort((a, b) => a.toLowerCase().indexOf(t) - b.toLowerCase().indexOf(t)).slice(0, 60);
    return { list: items.map(mapper || ((x) => item(x))), from: Pos(cur.line, start), to: cur };
  };
  if ((m = /\\(?:[a-zA-Z]*ref|cref|Cref)\{([^}]*)$/.exec(before))) {
    const typed = m[1].split(",").pop();
    return pick(allOf("labels"), typed, cur.ch - typed.length);
  }
  if ((m = /\\(?:[a-zA-Z]*cite[a-zA-Z]*|nocite)\*?(?:\[[^\]]*\])*\{([^}]*)$/.exec(before))) {
    const typed = m[1].split(",").pop().trimStart();
    return pick(allOf("keys"), typed, cur.ch - typed.length);
  }
  if ((m = /\\includegraphics(?:\[[^\]]*\])?\{([^}]*)$/.exec(before))) {
    return pick(filesOfKind([".png", ".jpg", ".jpeg", ".pdf", ".eps"], false), m[1], cur.ch - m[1].length);
  }
  if ((m = /\\(?:input|include)\{([^}]*)$/.exec(before))) {
    return pick(filesOfKind([".tex"], true), m[1], cur.ch - m[1].length);
  }
  if ((m = /\\(?:bibliography|addbibresource)\{([^}]*)$/.exec(before))) {
    return pick(filesOfKind([".bib"], false).map((p) => (/\\bibliography\{/.test(before) ? p.replace(/\.bib$/, "") : p)), m[1], cur.ch - m[1].length);
  }
  if ((m = /\\begin\{([^}]*)$/.exec(before))) {
    const typed = m[1];
    return pick(ENVIRONMENTS, typed, cur.ch - typed.length, (env) => item(env, "environment", (c, data) => {
      const indent = /^\s*/.exec(c.getLine(cur.line))[0];
      const body = (ENV_BODY[env] || "  ").split("\n").map((l) => indent + l).join("\n");
      const after = c.getLine(cur.line).slice(cur.ch).startsWith("}") ? 1 : 0;
      c.replaceRange(`${env}}\n${body}\n${indent}\\end{${env}}`, data.from, Pos(cur.line, cur.ch + after));
      const firstBody = body.split("\n")[0];
      c.setCursor(Pos(cur.line + 1, firstBody.length));
    }));
  }
  if ((m = /\\([a-zA-Z]*)$/.exec(before))) {
    const typed = m[1];
    const start = cur.ch - typed.length - 1;
    const list = COMMANDS.filter(([n]) => n.toLowerCase().startsWith(typed.toLowerCase())).slice(0, 60);
    return {
      list: list.map(([name, args, info]) => item(`\\${name}`, info, (c, data) => {
        const text = `\\${name}${args}`;
        c.replaceRange(text, data.from, data.to);
        const slot = text.indexOf("{}");  // put the cursor inside the first empty argument
        if (slot >= 0) {
          c.setCursor(Pos(data.from.line, data.from.ch + slot + 1));
          if (/^(begin|.*ref|.*cite.*|input|include|includegraphics|bibliography|addbibresource)$/.test(name)) {
            setTimeout(() => showHints(true), 0);
          }
        }
      })),
      from: Pos(cur.line, start),
      to: cur,
    };
  }
  return null;
}

// ── Project index (labels, citation keys) for completions ─────────────
function extract(path, text) {
  if (path.endsWith(".bib")) {
    const keys = [...text.matchAll(/@\w+\s*\{\s*([^,\s]+)\s*,/g)].map((m) => m[1]);
    return { labels: [], keys };
  }
  const labels = [...text.matchAll(/\\label\{([^}]+)\}/g)].map((m) => m[1]);
  const keys = [...text.matchAll(/\\bibitem(?:\[[^\]]*\])?\{([^}]+)\}/g)].map((m) => m[1]);
  return { labels, keys };
}

function allOf(kind) {
  const out = new Set();
  index.forEach((v) => v[kind].forEach((x) => out.add(x)));
  return [...out].sort();
}

const reindexSoon = debounce((tab) => index.set(tab.path, extract(tab.path, tab.doc.getValue())), 800);

export async function buildIndex() {
  const paths = filesOfKind([".tex", ".bib"], false).slice(0, 150);
  index.clear();
  await Promise.all(paths.map(async (p) => {
    const open = state.tabs.find((t) => t.path === p && t.doc);
    if (open) { index.set(p, extract(p, open.doc.getValue())); return; }
    try {
      const info = await api.read(p);
      if (info.content != null) index.set(p, extract(p, info.content));
    } catch { /* skip unreadable files */ }
  }));
}

export { kbd };
