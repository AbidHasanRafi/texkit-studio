// Sidebar: file tree (create, rename, move, delete, upload, drag & drop) and document outline.

import { api } from "./api.js";
import { h, icon, toggleMenu, showMenu, promptDialog, confirmDialog, toast, store, save, debounce } from "./dom.js";
import { state, set, on } from "./store.js";
import * as editor from "./editor.js";
import { initRefsPanel } from "./refs.js";

const DRAG_TYPE = "application/x-texkit-path";
let treeEl, outlineEl, footEl, uploadInput, uploadDir = "";
let collapsed = new Set();
let refreshTree = async () => {};

const trashName = () => (state.session?.platform === "win32" ? "Recycle Bin" : "Trash");
const revealLabel = () => ({ win32: "Show in Explorer", darwin: "Reveal in Finder" }[state.session?.platform] || "Show in file manager");
export { trashName, revealLabel };

function kindIcon(n) {
  if (n.type === "dir") return icon("folder", "sm ficon dir");
  return icon({ tex: "file-text", bib: "book", image: "image", pdf: "file-pdf" }[n.kind] || "file", "sm ficon");
}

export function initSidebar(aside, { reload, onFileOpened }) {
  refreshTree = reload;
  uploadInput = h("input", { type: "file", multiple: true, class: "hidden", onchange: () => doUpload(uploadDir, uploadInput.files) });
  treeEl = h("ul", { class: "tree", role: "tree", "aria-label": "Files" });
  const treeScroll = h("div", { class: "side-scroll" }, treeEl);
  outlineEl = h("ul", { class: "tree outline", "aria-label": "Outline" });
  footEl = h("div", { class: "side-foot" });
  const refsEl = h("div", { class: "refs-panel" });
  const searchEl = h("div", { class: "search-panel" });

  const fileActs = h("div", { class: "acts" },
    h("button", { class: "icon-btn sm", title: "New file", "aria-label": "New file", onclick: () => newFile("") }, icon("file-plus", "sm")),
    h("button", { class: "icon-btn sm", title: "New folder", "aria-label": "New folder", onclick: () => newFolder("") }, icon("folder-plus", "sm")),
    h("button", { class: "icon-btn sm", title: "Upload files", "aria-label": "Upload files", onclick: () => pickUpload("") }, icon("upload", "sm")),
  );
  const top = tabbed("top", [["files", "Files", treeScroll], ["search", "Search", searchEl]], fileActs);
  const bottom = tabbed("bottom", [["outline", "Outline", h("div", { class: "side-scroll" }, outlineEl)], ["refs", "References", h("div", { class: "side-scroll" }, refsEl)]]);
  top.el.classList.add("files");
  bottom.el.classList.add("outline");

  aside.append(top.el, bottom.el, footEl, uploadInput);
  initRefsPanel(refsEl);
  initSearch(searchEl);
  showSearch = () => { if (state.sidebarOpen === false && !window.matchMedia("(min-width: 1280px)").matches) set({ sidebarOpen: true }); top.select("search"); searchEl.querySelector("input")?.focus(); };
  showReferences = () => { if (!window.matchMedia("(min-width: 1280px)").matches) set({ sidebarOpen: true }); bottom.select("refs"); };
  // A badge on the References tab when something isn't referenced or cited.
  on(["analysis"], () => {
    const n = (state.analysis?.checks || []).filter((c) => c.severity !== "info").length;
    bottom.badge("refs", n ? String(n) : "");
  });

  // Dropping onto empty space in the tree targets the project root.
  treeScroll.addEventListener("dragover", (e) => {
    if (!acceptsDrop(e)) return;
    e.preventDefault();
    treeScroll.classList.add("drop-target");
  });
  treeScroll.addEventListener("dragleave", (e) => { if (e.target === treeScroll) treeScroll.classList.remove("drop-target"); });
  treeScroll.addEventListener("drop", (e) => { treeScroll.classList.remove("drop-target"); handleDrop(e, ""); });

  on(["tree", "active", "mainFile", "compile", "session"], renderTree);
  on(["docTick", "cursorLine", "active", "analysis"], renderOutline);
  on(["session"], renderFoot);

  sidebarOpened = onFileOpened;
}
let sidebarOpened = () => {};
export let showSearch = () => {};
export let showReferences = () => {};

/** A sidebar section with switchable tabs (e.g. Files | Search). Remembers the choice. */
function tabbed(id, tabs, actions) {
  const saved = store(`sideTab:${id}`, tabs[0][0]);
  const buttons = new Map();
  const head = h("div", { class: "side-head tabbed", role: "tablist" });
  const bodies = new Map();
  const el = h("section", { class: "side-section" }, head);
  for (const [key, label, body] of tabs) {
    const b = h("button", { class: "side-tab", role: "tab", onclick: () => select(key) }, h("span", null, label), h("span", { class: "tab-badge hidden" }));
    buttons.set(key, b);
    head.append(b);
    bodies.set(key, body);
    el.append(body);
  }
  if (actions) head.append(h("span", { class: "grow" }), actions);
  function select(key) {
    save(`sideTab:${id}`, key);
    for (const [k, b] of buttons) {
      b.setAttribute("aria-selected", String(k === key));
      bodies.get(k).classList.toggle("hidden", k !== key);
    }
    if (actions) actions.classList.toggle("hidden", key !== tabs[0][0]);
  }
  select(buttons.has(saved) ? saved : tabs[0][0]);
  return {
    el, select,
    badge(key, text) { const bd = buttons.get(key).querySelector(".tab-badge"); bd.textContent = text; bd.classList.toggle("hidden", !text); },
  };
}

// ── Search across all files ───────────────────────────────────────────
function initSearch(el) {
  const input = h("input", { type: "text", placeholder: "Search all files", spellcheck: "false", "aria-label": "Search all files" });
  const opts = { kase: false, regex: false, whole: false };
  const optBtn = (key, label, title) => {
    const b = h("button", { class: "opt", title, "aria-pressed": "false", onclick: () => { opts[key] = !opts[key]; b.setAttribute("aria-pressed", String(opts[key])); run(); } }, label);
    return b;
  };
  const results = h("div", { class: "search-results" });
  el.append(h("div", { class: "search-box" }, icon("search", "sm"), input,
    optBtn("kase", "Aa", "Match case"), optBtn("whole", "ab", "Whole word"), optBtn("regex", ".*", "Regular expression")), results);
  let seq = 0;
  async function run() {
    const q = input.value;
    const my = ++seq;
    if (!q.trim()) { results.replaceChildren(); return; }
    let r;
    try { r = await api.search(q, opts); } catch (e) { results.replaceChildren(h("div", { class: "side-empty" }, e.message)); return; }
    if (my !== seq) return;
    if (!r.results.length) { results.replaceChildren(h("div", { class: "side-empty" }, "No matches.")); return; }
    const byFile = new Map();
    r.results.forEach((m) => { if (!byFile.has(m.file)) byFile.set(m.file, []); byFile.get(m.file).push(m); });
    results.replaceChildren(
      h("div", { class: "side-empty" }, `${r.results.length}${r.truncated ? "+" : ""} matches in ${byFile.size} file${byFile.size === 1 ? "" : "s"}`),
      ...[...byFile].map(([file, ms]) => h("div", { class: "sr-file" },
        h("div", { class: "sr-name" }, icon("file-text", "sm"), h("span", null, file), h("span", { class: "rf-count" }, ms.length)),
        ...ms.slice(0, 50).map((m) => {
          const start = Math.max(0, m.col - 30);
          const pre = (start ? "…" : "") + m.text.slice(start, m.col).trimStart();
          return h("button", { class: "sr-hit", title: `${file}:${m.line}`, onclick: () => { editor.jumpTo(file, m.line); sidebarOpened(); } },
            h("span", { class: "sr-line" }, m.line), h("span", { class: "sr-text" }, pre, h("mark", null, m.text.substr(m.col, m.len)), m.text.slice(m.col + m.len, m.col + m.len + 80)));
        }))));
  }
  input.addEventListener("input", debounce(run, 250));
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });
  on(["tree"], () => { if (input.value.trim()) run(); });
}

export function loadCollapsed() {
  collapsed = new Set(store(`collapsed:${state.session?.root}`, []));
}

// ── Tree ───────────────────────────────────────────────────────────────
function renderTree() {
  const errorsIn = new Set((state.compile.issues || []).filter((i) => i.severity === "error" && i.file).map((i) => i.file));
  const rows = [];
  const walk = (nodes, depth) => {
    for (const n of nodes) {
      const isDir = n.type === "dir";
      const open = isDir && !collapsed.has(n.path);
      const row = h("li", {
        class: `row${n.path === state.active ? " selected" : ""}`, role: "treeitem", tabindex: "0",
        "aria-expanded": isDir ? String(open) : null, title: n.path, draggable: "true",
        style: { paddingLeft: `${6 + depth * 14}px` },
        onclick: () => (isDir ? toggleDir(n.path) : openFromTree(n.path)),
        onkeydown: (e) => {
          if (e.key === "Enter") (isDir ? toggleDir(n.path) : openFromTree(n.path));
          if (e.key === "F2") rename(n);
          if (e.key === "Delete") remove(n);
          if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) { e.preventDefault(); rowMenu(row, n); }
        },
        oncontextmenu: (e) => { e.preventDefault(); rowMenu(row, n); },
        ondragstart: (e) => { e.dataTransfer.setData(DRAG_TYPE, n.path); e.dataTransfer.effectAllowed = "move"; },
      },
        h("span", { class: "twisty" }, isDir ? icon(open ? "chev-d" : "chev-r", "sm") : null),
        kindIcon(n),
        h("span", { class: "name" }, n.name),
        n.path === state.mainFile ? h("span", { class: "badge", title: {
          chosen: "This file is compiled. You chose it.",
          "main.tex": "This file is compiled (it's named main.tex).",
          auto: `This file is compiled. It was picked automatically from ${state.mainCandidates.length} documents; use ⋯ → Set as main file on another to change it.`,
        }[state.mainSource] || "This file is compiled" }, "main") : null,
        errorsIn.has(n.path) ? h("span", { class: "err-dot", title: "Has errors" }) : null,
        h("button", { class: "icon-btn sm row-menu", "aria-label": `Actions for ${n.name}`, onclick: (e) => { e.stopPropagation(); rowMenu(e.currentTarget, n); } }, icon("more", "sm")),
      );
      if (isDir) {
        row.addEventListener("dragover", (e) => { if (acceptsDrop(e)) { e.preventDefault(); e.stopPropagation(); row.classList.add("drop"); } });
        row.addEventListener("dragleave", () => row.classList.remove("drop"));
        row.addEventListener("drop", (e) => { e.stopPropagation(); row.classList.remove("drop"); handleDrop(e, n.path); });
      }
      rows.push(row);
      if (open) walk(n.children || [], depth + 1);
    }
  };
  walk(state.tree, 0);
  if (!rows.length) rows.push(h("li", { class: "side-empty" }, "This folder is empty."));
  treeEl.replaceChildren(...rows);
}

function toggleDir(path) {
  collapsed.has(path) ? collapsed.delete(path) : collapsed.add(path);
  save(`collapsed:${state.session?.root}`, [...collapsed]);
  renderTree();
}

function openFromTree(path) {
  editor.openFile(path);
  sidebarOpened();
}

function rowMenu(anchor, n) {
  const isDir = n.type === "dir";
  const dir = isDir ? n.path : n.path.split("/").slice(0, -1).join("/");
  toggleMenu(anchor, () => [
    !isDir && { label: "Open", icon: "file-text", onSelect: () => openFromTree(n.path) },
    !isDir && n.kind === "tex" && n.path !== state.mainFile && { label: "Set as main file", sub: "This is the file that gets compiled", icon: "star", onSelect: () => setMain(n.path) },
    isDir && { label: "New file here…", icon: "file-plus", onSelect: () => newFile(dir) },
    isDir && { label: "New folder here…", icon: "folder-plus", onSelect: () => newFolder(dir) },
    isDir && { label: "Upload files here…", icon: "upload", onSelect: () => pickUpload(dir) },
    { label: "Rename…", icon: "pencil", kbd: "F2", onSelect: () => rename(n) },
    { label: revealLabel(), icon: "external", onSelect: () => api.reveal(n.path).catch((e) => toast(e.message, { kind: "error" })) },
    "sep",
    { label: `Move to ${trashName()}`, icon: "trash", danger: true, onSelect: () => remove(n) },
  ].filter(Boolean), { align: "start" });
}

const validName = (v) => (!v ? "Please enter a name." : /[<>:"|?*\\]/.test(v) ? "Names can't contain < > : \" | ? * or \\" : v.split("/").some((p) => p === ".." || p === ".") ? "That isn't a valid name." : null);
const join = (dir, name) => (dir ? `${dir}/${name}` : name);

async function newFile(dir) {
  const name = await promptDialog({ title: "New file", label: dir ? `In ${dir}/` : "In the project folder", value: "untitled.tex", okLabel: "Create", validate: validName });
  if (!name) return;
  const path = join(dir, name);
  try {
    await api.create(path, "file");
    if (dir) { collapsed.delete(dir); }
    await refreshTree();
    openFromTree(path);
  } catch (e) { toast(e.message, { kind: "error" }); }
}

async function newFolder(dir) {
  const name = await promptDialog({ title: "New folder", label: dir ? `In ${dir}/` : "In the project folder", value: "", okLabel: "Create", validate: validName });
  if (!name) return;
  try { await api.create(join(dir, name), "dir"); await refreshTree(); } catch (e) { toast(e.message, { kind: "error" }); }
}

async function rename(n) {
  const name = await promptDialog({ title: `Rename ${n.type === "dir" ? "folder" : "file"}`, value: n.name, okLabel: "Rename", validate: validName });
  if (!name || name === n.name) return;
  const to = join(n.path.split("/").slice(0, -1).join("/"), name);
  try {
    await api.move(n.path, to);
    editor.renamePath(n.path, to);
    if (state.mainFile === n.path) set({ mainFile: to });
    await refreshTree();
  } catch (e) { toast(e.message, { kind: "error" }); }
}

async function remove(n) {
  const ok = await confirmDialog({
    title: `Move “${n.name}” to the ${trashName()}?`,
    message: `You can restore it from the ${trashName()} later.`,
    okLabel: `Move to ${trashName()}`, danger: true,
  });
  if (!ok) return;
  try {
    await api.remove(n.path);
    editor.dropPath(n.path);
    await refreshTree();
  } catch (e) { toast(e.message, { kind: "error" }); }
}

export async function setMainFile(path) {
  try {
    const r = await api.setMain(path);
    set({ mainFile: path, mainSource: "chosen", wantAnalysis: Date.now() });
    toast(r.isDocument === false
      ? `${path} is now the main file, but it has no \\documentclass, so it may be a chapter. Pick the file that includes it if it won't compile.`
      : `${path} is now the main file. Compiling it…`, { kind: r.isDocument === false ? "info" : "ok", timeout: r.isDocument === false ? 8000 : 3000 });
    document.dispatchEvent(new CustomEvent("texkit:compile"));  // the PDF should match the new main file
  } catch (e) { toast(e.message, { kind: "error" }); }
}
const setMain = setMainFile;

function pickUpload(dir) {
  uploadDir = dir;
  uploadInput.value = "";
  uploadInput.click();
}

async function doUpload(dir, files) {
  if (!files || !files.length) return;
  try {
    const r = await api.upload(dir, files);
    if (dir) collapsed.delete(dir);
    await refreshTree();
    toast(`Uploaded ${r.saved.length} file${r.saved.length === 1 ? "" : "s"}.`, { kind: "ok" });
  } catch (e) { toast(`Upload failed: ${e.message}`, { kind: "error" }); }
}

function acceptsDrop(e) {
  const types = [...(e.dataTransfer?.types || [])];
  return types.includes("Files") || types.includes(DRAG_TYPE);
}

async function handleDrop(e, dir) {
  e.preventDefault();
  if (e.dataTransfer.files && e.dataTransfer.files.length) return doUpload(dir, e.dataTransfer.files);
  const from = e.dataTransfer.getData(DRAG_TYPE);
  if (!from) return;
  const name = from.split("/").pop();
  const to = join(dir, name);
  if (to === from || to.startsWith(`${from}/`)) return;
  try {
    await api.move(from, to);
    editor.renamePath(from, to);
    if (state.mainFile === from) set({ mainFile: to });
    await refreshTree();
  } catch (err) { toast(err.message, { kind: "error" }); }
}

// ── Outline ────────────────────────────────────────────────────────────
const LEVELS = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5 };

function renderOutline() {
  const tab = editor.activeTab();
  const a = state.analysis;
  // Whole document (every chapter file, in order) when the open file is part of it.
  if (a && a.sections.length && (!tab || a.files.includes(tab.path))) {
    const items = a.sections;
    const minLevel = Math.min(...items.map((s) => s.level));
    const cursor = (state.cursorLine ?? 0) + 1;
    let current = -1;
    items.forEach((s, i) => { if (tab && s.file === tab.path && s.line <= cursor) current = i; });
    if (current < 0 && tab) current = items.findIndex((s) => s.file === tab.path) - 1;
    let lastFile = null;
    const rows = [];
    items.forEach((s, i) => {
      if (s.file !== lastFile && a.files.length > 1) {
        rows.push(h("li", { class: "outline-file", title: s.file }, s.file));
        lastFile = s.file;
      }
      rows.push(h("li", {
        class: `row${i === current ? " current" : ""}`, role: "treeitem", tabindex: "0", title: `${s.title} · ${s.file}:${s.line}`,
        style: { paddingLeft: `${10 + (s.level - minLevel) * 14}px` },
        onclick: () => { editor.jumpTo(s.file, s.line); sidebarOpened(); },
        onkeydown: (e) => { if (e.key === "Enter") editor.jumpTo(s.file, s.line); },
      }, h("span", { class: "name" }, s.title), s.words ? h("span", { class: "rf-count" }, s.words) : null));
    });
    outlineEl.replaceChildren(...rows);
    return;
  }
  if (!tab || !tab.doc || tab.kind !== "tex") { outlineEl.replaceChildren(h("li", { class: "side-empty" }, "Open a .tex file to see its outline.")); return; }
  const items = [];
  tab.doc.eachLine((lh) => {
    const m = /^\s*\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\s*(?:\[[^\]]*\])?\{(.*)\}?/.exec(lh.text);
    if (m && !/^\s*%/.test(lh.text)) {
      let title = m[2];
      let depth = 0, end = title.length;
      for (let i = 0; i < title.length; i++) {
        if (title[i] === "{") depth++;
        else if (title[i] === "}") { if (depth === 0) { end = i; break; } depth--; }
      }
      title = title.slice(0, end).replace(/\\[a-zA-Z]+\*?\{([^}]*)\}/g, "$1").replace(/\\[a-zA-Z]+/g, "").trim() || "(untitled)";
      items.push({ level: LEVELS[m[1]], title, line: tab.doc.getLineNumber(lh) });
    }
  });
  if (!items.length) { outlineEl.replaceChildren(h("li", { class: "side-empty" }, "No headings in this file yet.")); return; }
  const minLevel = Math.min(...items.map((i) => i.level));
  const cursor = state.cursorLine ?? 0;
  let current = -1;
  items.forEach((it, i) => { if (it.line <= cursor) current = i; });
  outlineEl.replaceChildren(...items.map((it, i) => h("li", {
    class: `row${i === current ? " current" : ""}`, role: "treeitem", tabindex: "0", title: it.title,
    style: { paddingLeft: `${10 + (it.level - minLevel) * 14}px` },
    onclick: () => { editor.jumpTo(tab.path, it.line + 1); sidebarOpened(); },
    onkeydown: (e) => { if (e.key === "Enter") editor.jumpTo(tab.path, it.line + 1); },
  }, h("span", { class: "name" }, it.title))));
}

// ── Footer: where the files live ──────────────────────────────────────
function renderFoot() {
  const root = state.session?.root || "";
  const btn = h("button", { title: "Folder actions" }, h("div", null, "Saved in your folder"), h("code", null, root));
  btn.addEventListener("click", () => showMenu(btn, [
    { label: "Copy folder path", icon: "copy", onSelect: () => navigator.clipboard?.writeText(root).then(() => toast("Path copied.", { kind: "ok" })) },
    { label: revealLabel(), icon: "external", onSelect: () => api.reveal(null).catch((e) => toast(e.message, { kind: "error" })) },
  ]));
  footEl.replaceChildren(icon("drive", "sm"), btn);
}
