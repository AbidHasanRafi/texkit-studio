// Boot, layout (responsive panes, splitter, slide-over sidebar), live events and the compile flow.

import { api, connect, download } from "./api.js";
import { h, icon, logo, injectSprite, debounce, toast, store, save, isMac, closeMenu } from "./dom.js";
import { state, set, on } from "./store.js";
import * as editor from "./editor.js";
import { initPdf } from "./pdfview.js";
import { initSidebar, loadCollapsed } from "./sidebar.js";
import { initIssues } from "./issues.js";
import { initToolbar } from "./toolbar.js";
import { folderDialog, newProjectDialog, applyTheme, settingsDialog } from "./dialogs.js";
import { refPicker, citePicker, doiDialog, insertRef, insertCite } from "./refs.js";
import { insertMenuItems, symbolPicker, tableDialog, ensurePackage, pickImage, insertEquation } from "./inserts.js";
import { picker, shortcutsDialog } from "./palette.js";
import { historyDialog } from "./history.js";
import { checkDialog } from "./check.js";
import { showSearch, showReferences } from "./sidebar.js";

injectSprite();
applyTheme();

const wide = window.matchMedia("(min-width: 1280px)");
const narrow = window.matchMedia("(max-width: 1023px)");

// ── Skeleton ───────────────────────────────────────────────────────────
const app = document.getElementById("app");
const header = h("header", { class: "toolbar glass" });
const sidebar = h("aside", { class: "sidebar glass", "aria-label": "Project" });
const editorPane = h("section", { class: "editor-pane", "aria-label": "Editor" });
const splitter = h("div", { class: "splitter", role: "separator", "aria-orientation": "vertical", "aria-label": "Resize editor and PDF", tabindex: "0" });
const pdfPane = h("section", { class: "pdf-pane", "aria-label": "PDF preview" });
const sideResizer = h("div", { class: "side-resizer", role: "separator", "aria-orientation": "vertical", "aria-label": "Resize file sidebar", tabindex: "0", title: "Drag to resize, double-click to reset" });
const workspace = h("main", { class: "workspace" }, sidebar, editorPane, splitter, pdfPane, sideResizer);
const scrim = h("div", { class: "scrim", onclick: () => set({ sidebarOpen: false }) });
app.append(header, workspace, scrim);

const SIDE_DEFAULT = 248, SIDE_MIN = 180;

set({ layout: store("layout", "split"), pane: store("pane", "editor") });
if (store("sidebarHidden", false)) app.classList.add("sidebar-hidden");
setRatio(store("ratio", 0.5));
setSideWidth(store("sideWidth", SIDE_DEFAULT));

const actions = {
  compile: (opts) => compile(opts),
  cancel: () => api.cancel(),
  openFolder,
  newProject,
  switchFolder,
  toggleSidebar,
  setLayout,
  check: () => checkDialog({ pageCount: pdf.pageCount(), onCompile: () => compile(), onDownload: () => runDownload("submission") }),
  palette: () => commandPalette(),
  importZip,
  history: () => historyDialog({ onRestored: (path) => editor.externalChange([path]) }),
};

const drawer = initIssues({ onJump: (file, line) => editor.jumpTo(file, line), onFix: (issue, fix) => editor.applyFix(issue, fix) });
editor.initEditor(editorPane, {
  onCompile: () => compile(),
  issuesDrawer: drawer,
  onSync: syncForward,
  onRefPicker: refPicker,
  onCitePicker: citePicker,
  onSymbolPicker: symbolPicker,
  insertMenuItems,
  onInsertRef: insertRef,
  onInsertCite: insertCite,
  ensurePackage,
});
const pdf = initPdf(pdfPane, { onCompile: () => compile(), onInverse: syncInverse });
initSidebar(sidebar, { reload: loadTree, onFileOpened: () => { if (!wide.matches) set({ sidebarOpen: false }); if (narrow.matches) set({ pane: "editor" }); } });
initToolbar(header, actions);

// ── Layout ─────────────────────────────────────────────────────────────
function setLayout(value) {
  if (narrow.matches) set({ pane: value === "pdf" ? "pdf" : "editor" });
  else set({ layout: value });
}

on(["layout", "pane"], () => {
  workspace.dataset.layout = state.layout;
  workspace.dataset.pane = state.pane;
  save("layout", state.layout);
  save("pane", state.pane);
  requestAnimationFrame(() => { editor.refresh(); pdf.refresh(); });
});
workspace.dataset.layout = state.layout;
workspace.dataset.pane = state.pane;

function toggleSidebar() {
  if (wide.matches) {
    app.classList.toggle("sidebar-hidden");
    save("sidebarHidden", app.classList.contains("sidebar-hidden"));
    requestAnimationFrame(() => { editor.refresh(); pdf.refresh(); });
  } else {
    set({ sidebarOpen: !state.sidebarOpen });
  }
}
on(["sidebarOpen"], () => app.classList.toggle("sidebar-open", state.sidebarOpen));
wide.addEventListener("change", () => { set({ sidebarOpen: false }); editor.refresh(); });
narrow.addEventListener("change", () => { set({ pane: state.pane }); });

function setRatio(r) {
  const ratio = Math.min(0.8, Math.max(0.2, r));
  workspace.style.setProperty("--ed", `${ratio}fr`);
  workspace.style.setProperty("--pdf", `${1 - ratio}fr`);
  return ratio;
}

function setSideWidth(px) {
  const max = Math.max(SIDE_MIN, Math.min(560, workspace.clientWidth * 0.45 || 560));
  const width = Math.round(Math.min(max, Math.max(SIDE_MIN, px)));
  workspace.style.setProperty("--side-pref", `${width}px`);
  return width;
}

sideResizer.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  sideResizer.setPointerCapture(e.pointerId);
  sideResizer.classList.add("dragging");
  app.classList.add("resizing");
  const left = workspace.getBoundingClientRect().left;
  const move = (ev) => setSideWidth(ev.clientX - left);
  const up = (ev) => {
    sideResizer.releasePointerCapture(e.pointerId);
    sideResizer.classList.remove("dragging");
    app.classList.remove("resizing");
    sideResizer.removeEventListener("pointermove", move);
    sideResizer.removeEventListener("pointerup", up);
    save("sideWidth", setSideWidth(ev.clientX - left));
    editor.refresh(); pdf.refresh();
  };
  sideResizer.addEventListener("pointermove", move);
  sideResizer.addEventListener("pointerup", up);
});
sideResizer.addEventListener("dblclick", () => { save("sideWidth", setSideWidth(SIDE_DEFAULT)); editor.refresh(); pdf.refresh(); });
sideResizer.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  e.preventDefault();
  save("sideWidth", setSideWidth(sidebar.offsetWidth + (e.key === "ArrowLeft" ? -16 : 16)));
  editor.refresh(); pdf.refresh();
});
window.addEventListener("resize", () => setSideWidth(store("sideWidth", SIDE_DEFAULT)));

splitter.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  splitter.setPointerCapture(e.pointerId);
  splitter.classList.add("dragging");
  app.classList.add("resizing");
  const left = editorPane.getBoundingClientRect().left;
  const total = editorPane.offsetWidth + pdfPane.offsetWidth;
  const move = (ev) => setRatio((ev.clientX - left) / total);
  const up = (ev) => {
    splitter.releasePointerCapture(e.pointerId);
    splitter.classList.remove("dragging");
    app.classList.remove("resizing");
    splitter.removeEventListener("pointermove", move);
    splitter.removeEventListener("pointerup", up);
    save("ratio", setRatio((ev.clientX - left) / total));
    editor.refresh();
  };
  splitter.addEventListener("pointermove", move);
  splitter.addEventListener("pointerup", up);
});
splitter.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  const current = editorPane.offsetWidth / (editorPane.offsetWidth + pdfPane.offsetWidth);
  save("ratio", setRatio(current + (e.key === "ArrowLeft" ? -0.05 : 0.05)));
  editor.refresh();
});

// ── Project loading ───────────────────────────────────────────────────
async function loadTree() {
  const t = await api.tree();
  set({ tree: t.tree, mainFile: t.mainFile });
  return t;
}
const loadTreeSoon = debounce(() => loadTree().then(() => editor.buildIndex()).catch(() => {}), 300);

// ── Reference & citation analysis (refreshed after saves, compiles and file changes) ──
let analysisSeq = 0;
async function refreshAnalysis() {
  const my = ++analysisSeq;
  try {
    const a = await api.analysis();
    if (my === analysisSeq) set({ analysis: a });
  } catch { /* the next refresh will try again */ }
}
const refreshAnalysisSoon = debounce(refreshAnalysis, 500);
on(["wantAnalysis"], refreshAnalysisSoon);

let lastRev = -1;
async function loadProject() {
  let s;
  try {
    s = await api.session();
  } catch (e) {
    if (e.status === 401) return signedOut();
    toast(`Couldn't reach TexKit Studio: ${e.message}`, { kind: "error", timeout: 0 });
    return;
  }
  editor.closeAll();
  lastRev = -1;
  set({ analysis: null });
  set({
    session: s,
    mainFile: s.mainFile,
    compile: s.compile || { status: "idle", issues: [], rev: s.rev, hasPdf: s.hasPdf },
    compiling: s.compiling,
    log: [],
  });
  document.title = `${s.name} — ${s.product}`;
  loadCollapsed();
  const t = await loadTree();

  if (s.hasPdf) { lastRev = s.rev; pdf.load(`/api/output.pdf?rev=${s.rev}&t=${Date.now()}`); }
  else pdf.showEmpty({ action: !!t.mainFile });
  updateBanner();

  refreshAnalysis();
  const first = firstTex(t.tree);
  if (!first) { showStartHere(s); return; }
  const last = store(`active:${s.root}`, null);
  await editor.openFile(last && hasPath(t.tree, last) ? last : t.mainFile || first, { focus: false });
  editor.buildIndex();
  // Compile once on open so the PDF and the issues list reflect the files as they are now.
  if (t.mainFile && !s.compile && !s.compiling && (editor.settings.autoCompile || !s.hasPdf)) compile();
}

function hasPath(nodes, path) {
  return nodes.some((n) => n.path === path || (n.type === "dir" && path.startsWith(`${n.path}/`) && hasPath(n.children || [], path)));
}

/** After a reconnect: refresh status and files without closing open tabs. */
async function resync() {
  try {
    const s = await api.session();
    if (s.root !== state.session?.root) return loadProject();
    set({ session: s, compile: s.compile || state.compile, compiling: s.compiling });
    await loadTree();
    editor.externalChange(state.tabs.map((t) => t.path));
    if (s.hasPdf && s.rev !== lastRev) { lastRev = s.rev; pdf.load(`/api/output.pdf?rev=${s.rev}&t=${Date.now()}`); }
  } catch (e) {
    if (e.status === 401) signedOut();
  }
}

function firstTex(nodes) {
  for (const n of nodes) {
    if (n.type === "file" && n.name.endsWith(".tex")) return n.path;
    if (n.type === "dir") { const f = firstTex(n.children || []); if (f) return f; }
  }
  return null;
}

on(["active"], () => { if (state.session && state.active) save(`active:${state.session.root}`, state.active); });

function showStartHere(s) {
  editor.showEmpty(h("div", { class: "empty-card" },
    h("div", { class: "big-icon" }, icon("sparkle", "lg")),
    h("h2", null, "Start writing here"),
    h("p", null, `“${s.name}” has no LaTeX files yet. Start from a template, or open a folder that already has your paper.`),
    h("div", { class: "actions" },
      h("button", { class: "btn primary", onclick: newProject }, icon("plus", "sm"), "New from template…"),
      h("button", { class: "btn secondary", onclick: openFolder }, icon("folder-open", "sm"), "Open another folder…"),
    ),
  ));
  pdf.showEmpty({ message: "Your PDF will appear here once there's a document.", action: false });
}

function signedOut() {
  app.replaceChildren(h("div", { class: "fullscreen-msg" }, h("div", { class: "card" },
    logo(56),
    h("h2", null, "Open TexKit Studio from your terminal"),
    h("p", null, "For your privacy, this page only works through the link the command opens. In a terminal, go to your project folder and run:"),
    h("code", null, "texkit"),
  )));
}

async function switchFolder(path) {
  await editor.saveAll();
  try { await api.setRoot(path); await loadProject(); }
  catch (e) { toast(e.message, { kind: "error" }); }
}

async function openFolder() {
  closeMenu();
  const path = await folderDialog({ mode: "open" });
  if (path && path !== state.session?.root) switchFolder(path);
}

async function newProject() {
  closeMenu();
  await editor.saveAll();
  const r = await newProjectDialog();
  if (r) { await loadProject(); toast("Project created. Happy writing!", { kind: "ok" }); }
}

// ── Compile ────────────────────────────────────────────────────────────
async function compile({ clean = false } = {}) {
  await editor.saveAll();
  set({ compiling: true });
  try {
    const r = await api.compile(state.active, clean);
    if (r.status !== "cancelled" && !state.connected) finished(r);
  } catch (e) {
    set({ compiling: false });
    toast(`Compile failed: ${e.message}`, { kind: "error" });
  }
}
const compileSoon = debounce(() => compile(), 900);
editor.setAfterSave(() => { refreshAnalysisSoon(); if (editor.settings.autoCompile) compileSoon(); });

function finished(r) {
  set({ compiling: false, engineProgress: null, compile: r });
  refreshAnalysisSoon();
  if (r.offline) toast("You're offline, so this used only packages already downloaded.", { timeout: 5000 });
  if (r.hasPdf && r.rev !== lastRev) {
    lastRev = r.rev;
    pdf.load(`/api/output.pdf?rev=${r.rev}&t=${Date.now()}`);
  } else if (!r.hasPdf) {
    pdf.showEmpty({ message: "There's no PDF yet. Check the issues panel.", action: false });
  }
  updateBanner();
  if (r.status === "failed") set({ issuesOpen: true });
}

function updateBanner() {
  const c = state.compile;
  pdf.setBanner(c && c.status === "failed" && c.hasPdf ? "Showing last successful build" : null);
}

function onEvent(msg) {
  switch (msg.type) {
    case "compile.started": set({ compiling: true, log: [], engineProgress: null }); break;
    case "compile.log": set({ log: state.log.concat(msg.lines).slice(-5000) }); break;
    case "engine.progress": set({ engineProgress: msg }); break;
    case "compile.finished": finished(msg); break;
    case "compile.cancelled": set({ compiling: false, engineProgress: null }); break;
    case "fs.changed": loadTreeSoon(); editor.externalChange(msg.paths); refreshAnalysisSoon(); break;
    case "offline.progress": set({ offline: msg }); break;
    case "offline.done": offlineDone(msg); break;
    case "root.changed": if (msg.root !== state.session?.root) loadProject(); break;
    default: break;
  }
}

// ── Keyboard shortcuts (outside the editor) ───────────────────────────
document.addEventListener("keydown", (e) => {
  const mod = isMac ? e.metaKey : e.ctrlKey;
  const inEditor = !!e.target.closest?.(".CodeMirror");
  if (!mod) {
    if (e.key === "Escape" && state.sidebarOpen) set({ sidebarOpen: false });
    else if (e.key === "Escape" && state.focus && !document.querySelector(".overlay, .pk-overlay, .menu")) toggleFocus(false);
    else if (e.altKey && e.shiftKey && e.code === "KeyF" && !inEditor) { e.preventDefault(); editor.formatDocument(); }
    else if (e.altKey && !inEditor && !e.shiftKey) {
      const k = e.code;
      if (k === "KeyR") { e.preventDefault(); refPicker(); }
      else if (k === "KeyC") { e.preventDefault(); citePicker(); }
      else if (k === "KeyS") { e.preventDefault(); symbolPicker(); }
    }
    return;
  }
  const k = e.key.toLowerCase();
  if (k === "enter" && e.shiftKey) { e.preventDefault(); toggleFocus(); }
  else if (k === "k" || k === "p") { e.preventDefault(); commandPalette(k === "p" ? "files" : null); }
  else if (k === "f" && e.shiftKey) { e.preventDefault(); showSearch(); }
  else if (k === "j" && e.shiftKey) { if (!inEditor) { e.preventDefault(); syncForward(); } }
  else if (k === "s") {
    e.preventDefault();
    if (editor.settings.formatOnSave) editor.formatDocument({ quiet: true }).then(() => compile());
    else compile();
  } else if (k === "enter") { e.preventDefault(); compile(); }
  else if (k === "o") { e.preventDefault(); openFolder(); }
  else if (k === "\\") { e.preventDefault(); toggleSidebar(); }
  else if (["1", "2", "3"].includes(k) && !e.shiftKey) { e.preventDefault(); setLayout(["editor", "split", "pdf"][+k - 1]); }
  else if (k === "m" && e.shiftKey) { e.preventDefault(); set({ issuesOpen: !state.issuesOpen }); }
});

window.addEventListener("beforeunload", (e) => {
  if (state.tabs.some((t) => t.dirty)) { editor.saveAll(); e.preventDefault(); }
});

// ── SyncTeX: source ⇄ PDF ─────────────────────────────────────────────
async function syncForward() {
  const loc = editor.cursorLocation();
  if (!loc) return;
  if (!state.compile.hasPdf && !state.session?.hasPdf) { toast("Compile first, then you can jump to the PDF."); return; }
  if (narrow.matches) set({ pane: "pdf" });
  else if (state.layout === "editor") set({ layout: "split" });
  try { pdf.highlight(await api.syncForward(loc.file, loc.line)); }
  catch (e) { toast(e.message); }
}

async function syncInverse(page, x, y) {
  try {
    const hit = await api.syncInverse(page, x, y);
    await editor.jumpTo(hit.file, hit.line);
  } catch (e) { toast(e.message); }
}

// ── Focus mode: just the text ─────────────────────────────────────────
function toggleFocus(force) {
  const enable = force ?? !state.focus;
  set({ focus: enable });
  app.classList.toggle("focus", enable);
  if (enable) toast(`Focus mode. Press Esc or ${isMac ? "⌘⇧↵" : "Ctrl+Shift+Enter"} to leave.`, { timeout: 2500 });
  requestAnimationFrame(() => editor.refresh());
}

// ── Downloads, ZIP import, offline ────────────────────────────────────
async function runDownload(kind) {
  const dismiss = toast("Preparing your download…", { timeout: 0 });
  try { const name = await download(kind); dismiss(); toast(`Downloaded ${name}`, { kind: "ok" }); }
  catch (e) { dismiss(); toast(e.message, { kind: "error", timeout: 8000 }); }
}

function importZip() {
  closeMenu();
  const input = h("input", { type: "file", accept: ".zip,application/zip" });
  input.addEventListener("change", async () => {
    const file = input.files[0];
    if (!file) return;
    const parent = await folderDialog({ mode: "choose", title: "Where should the project go?" });
    if (!parent) return;
    const dismiss = toast(`Importing ${file.name}…`, { timeout: 0 });
    try {
      await editor.saveAll();
      await api.importZip(file, parent);
      dismiss();
      await loadProject();
      toast(`Imported ${file.name}.`, { kind: "ok" });
    } catch (e) { dismiss(); toast(e.message, { kind: "error", timeout: 8000 }); }
  });
  input.click();
}

let offlineToast = null;
on(["offline"], () => {
  const o = state.offline;
  if (!o) return;
  if (offlineToast) offlineToast();
  offlineToast = toast(`Preparing for offline use: ${o.name === "done" ? "finishing" : o.name} (${Math.min(o.done + 1, o.total)}/${o.total})…`, { timeout: 0 });
});
function offlineDone(msg) {
  if (offlineToast) offlineToast();
  set({ offline: null });
  if (msg.error) toast(`Couldn't prepare for offline use: ${msg.error}`, { kind: "error", timeout: 0 });
  else {
    const bad = (msg.results || []).filter((r) => !r.ok);
    toast(bad.length ? `Ready, except: ${bad.map((r) => r.template).join(", ")}.` : "Ready for offline use. The built-in templates now compile without internet.",
      { kind: bad.length ? "error" : "ok", timeout: 8000 });
  }
}
document.addEventListener("texkit:prepare-offline", () => api.prepareOffline().catch((e) => toast(e.message, { kind: "error" })));

// ── Command palette ────────────────────────────────────────────────────
function commandPalette(only) {
  const a = state.analysis;
  const files = [];
  const walk = (nodes) => nodes.forEach((n) => (n.type === "dir" ? walk(n.children || []) : files.push(n.path)));
  walk(state.tree);
  const fileItems = files.map((f) => ({ label: f.split("/").pop(), sub: f, icon: "file-text", group: "Files", keywords: f, run: () => editor.openFile(f) }));
  if (only === "files") return picker({ title: "Open a file", placeholder: "Type a file name…", items: fileItems });
  const cmd = (label, run, extra = {}) => ({ label, run, group: "Commands", ...extra });
  const items = [
    cmd("Compile", () => compile(), { icon: "play", kbd: "Mod-Enter" }),
    cmd("Recompile from scratch", () => compile({ clean: true }), { icon: "refresh" }),
    cmd("Check before submitting", actions.check, { icon: "checklist", keywords: "submission journal arxiv" }),
    cmd("Show this line in the PDF", syncForward, { icon: "target", kbd: "Mod-Shift-J", keywords: "synctex forward" }),
    cmd("Insert a reference to a figure, table…", refPicker, { icon: "link", kbd: "Alt-R", keywords: "ref label cross" }),
    cmd("Insert a citation", citePicker, { icon: "quote", kbd: "Alt-C", keywords: "cite bibliography" }),
    cmd("Add a source by DOI or arXiv ID", doiDialog, { icon: "plus", keywords: "bibtex reference" }),
    cmd("Insert a figure from an image", pickImage, { icon: "image" }),
    cmd("Insert a table", tableDialog, { icon: "table" }),
    cmd("Insert an equation", insertEquation, { icon: "sigma" }),
    cmd("Insert a symbol", symbolPicker, { icon: "omega", kbd: "Alt-S", keywords: "greek math" }),
    cmd("Format document", () => editor.formatDocument(), { icon: "wand", kbd: "Shift-Alt-F", keywords: "prettier tidy indent beautify align clean" }),
    cmd(`Format on save: ${editor.settings.formatOnSave ? "turn off" : "turn on"}`, () => {
      editor.saveSettings({ formatOnSave: !editor.settings.formatOnSave });
      toast(`Format on save is ${editor.settings.formatOnSave ? "on" : "off"}.`, { kind: "ok", timeout: 2000 });
    }, { icon: "wand", keywords: "prettier ctrl+s" }),
    cmd("Show the references panel", showReferences, { icon: "link", keywords: "figures tables bibliography uncited unreferenced" }),
    cmd("Search all files", showSearch, { icon: "search", kbd: "Mod-Shift-F" }),
    cmd("Version history", actions.history, { icon: "history", keywords: "snapshot restore undo" }),
    cmd("Focus mode", () => toggleFocus(), { icon: "focus", kbd: "Mod-Shift-Enter", keywords: "zen distraction" }),
    cmd("Download PDF", () => runDownload("pdf"), { icon: "file-pdf" }),
    cmd("Download Word document", () => runDownload("docx"), { icon: "word", keywords: "docx" }),
    cmd("Download project as ZIP", () => runDownload("zip"), { icon: "archive" }),
    cmd("Download submission package", () => runDownload("submission"), { icon: "cloud", keywords: "arxiv journal flatten" }),
    cmd("Open folder", openFolder, { icon: "folder-open", kbd: "Mod-O" }),
    cmd("New project from a template", newProject, { icon: "plus" }),
    cmd("Import a ZIP", importZip, { icon: "archive", keywords: "overleaf upload" }),
    cmd("Layout: editor only", () => setLayout("editor"), { icon: "panel", kbd: "Mod-1" }),
    cmd("Layout: editor and PDF", () => setLayout("split"), { icon: "panel", kbd: "Mod-2" }),
    cmd("Layout: PDF only", () => setLayout("pdf"), { icon: "panel", kbd: "Mod-3" }),
    cmd("Toggle the issues panel", () => set({ issuesOpen: !state.issuesOpen }), { icon: "warn", kbd: "Mod-Shift-M" }),
    cmd("Appearance: light", () => applyTheme("light"), { icon: "sun" }),
    cmd("Appearance: dark", () => applyTheme("dark"), { icon: "moon" }),
    cmd("Appearance: match system", () => applyTheme("system"), { icon: "monitor" }),
    cmd("Settings", settingsDialog, { icon: "sliders" }),
    cmd("Keyboard shortcuts", shortcutsDialog, { icon: "keyboard" }),
    cmd("Prepare for offline use", () => document.dispatchEvent(new CustomEvent("texkit:prepare-offline")), { icon: "download", keywords: "internet cache packages" }),
    ...fileItems,
    ...(a ? a.sections.map((s) => ({ label: s.title, sub: `${s.file}:${s.line}`, icon: "hash", group: "Sections", run: () => editor.jumpTo(s.file, s.line) })) : []),
    ...(a ? a.labels.filter((l) => l.kind !== "item").map((l) => ({
      label: l.key, sub: `${l.number || l.kind}${l.caption ? ` · ${l.caption}` : ""}`, icon: "link", group: "Labels", run: () => editor.jumpTo(l.file, l.line),
    })) : []),
  ];
  picker({ placeholder: "Type a command, file, section or label…", items });
}

// ── Start ──────────────────────────────────────────────────────────────
connect(onEvent, (ok) => {
  const was = state.connected;
  set({ connected: ok });
  if (ok && !was) resync();  // the server restarted or the laptop woke up
});
loadProject();
