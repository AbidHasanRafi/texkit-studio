// Toolbar: folder menu, layout control, status pill, Download menu, theme, settings, Compile.

import { api, download } from "./api.js";
import { h, icon, logo, setIcon, toggleMenu, toast, kbd } from "./dom.js";
import { state, set, on, allIssues } from "./store.js";
import { settings, saveSettings } from "./editor.js";
import { applyTheme, themePref, settingsDialog } from "./dialogs.js";
import { revealLabel } from "./sidebar.js";

export function initToolbar(header, a) {
  const nameEl = h("span", { class: "name" }, "…");
  const folderBtn = h("button", { class: "folder-btn", "aria-haspopup": "menu", title: "Folder" }, icon("folder"), nameEl, icon("chev-d", "sm"));
  folderBtn.addEventListener("click", () => toggleMenu(folderBtn, folderItems));

  const seg = h("div", { class: "segmented", role: "tablist", "aria-label": "Layout" },
    ...[["editor", "Editor", "Mod-1"], ["split", "Split", "Mod-2"], ["pdf", "PDF", "Mod-3"]].map(([k, l, s]) =>
      h("button", { role: "tab", "data-layout": k, title: `${l} (${kbd(s)})`, onclick: () => a.setLayout(k) }, l)));

  const pill = h("button", { class: "status-pill", title: `Show issues (${kbd("Mod-Shift-M")})`, onclick: () => set({ issuesOpen: !state.issuesOpen }) });

  const dlBtn = h("button", { class: "dl-btn tb-extra", "aria-haspopup": "menu", title: "Download" }, icon("download"), h("span", { class: "tb-label" }, "Download"));
  dlBtn.addEventListener("click", () => toggleMenu(dlBtn, downloadItems, { align: "end" }));

  const themeBtn = h("button", { class: "icon-btn tb-extra", "aria-haspopup": "menu", title: "Appearance" }, icon("moon"));
  themeBtn.addEventListener("click", () => toggleMenu(themeBtn, themeItems, { align: "end" }));
  const syncThemeIcon = () => setIcon(themeBtn.firstChild, document.documentElement.dataset.theme === "dark" ? "moon" : "sun");
  document.addEventListener("texkit:theme", syncThemeIcon);
  syncThemeIcon();

  const settingsBtn = h("button", { class: "icon-btn tb-extra", title: "Settings", "aria-label": "Settings", onclick: settingsDialog }, icon("sliders"));
  const checkBtn = h("button", { class: "dl-btn tb-extra", title: "Check everything before you submit", onclick: a.check }, icon("checklist"), h("span", { class: "tb-label" }, "Check"));
  const paletteBtn = h("button", { class: "icon-btn tb-extra", title: `All commands (${kbd("Mod-K")})`, "aria-label": "All commands", onclick: a.palette }, icon("command"));

  const mainLabel = h("span", { class: "tb-label" }, "Compile");
  const mainIcon = h("span", { style: { display: "contents" } }, icon("play", "fill"));
  const compileMain = h("button", { class: "main", title: `Compile (${kbd("Mod-Enter")})`, onclick: () => a.compile() }, mainIcon, mainLabel);
  const compileMore = h("button", { class: "more", "aria-label": "Compile options", "aria-haspopup": "menu" }, icon("chev-d", "sm"));
  compileMore.addEventListener("click", () => toggleMenu(compileMore, compileItems, { align: "end" }));

  const moreBtn = h("button", { class: "icon-btn tb-more", "aria-label": "More", "aria-haspopup": "menu" }, icon("more"));
  moreBtn.addEventListener("click", () => toggleMenu(moreBtn, () => [
    { heading: "Download" }, ...downloadItems(), "sep",
    { label: "All commands…", icon: "command", kbd: "Mod-K", onSelect: a.palette },
    { label: "Version history…", icon: "history", onSelect: a.history },
    { label: "Recompile from scratch", icon: "refresh", onSelect: () => a.compile({ clean: true }) },
    { label: `Auto-compile`, checked: settings.autoCompile, onSelect: () => saveSettings({ autoCompile: !settings.autoCompile }) },
    "sep", ...themeItems(), "sep",
    { label: "Settings…", icon: "sliders", onSelect: settingsDialog },
  ], { align: "end" }));

  const sideBtn = h("button", { class: "icon-btn tb-sidebar", title: `Files (${kbd("Mod-\\")})`, "aria-label": "Show files", onclick: a.toggleSidebar }, icon("menu"));

  header.append(
    h("div", { class: "tb-left" }, sideBtn, logo(), folderBtn),
    seg,
    h("div", { class: "tb-right" }, pill, checkBtn, dlBtn, paletteBtn, themeBtn, settingsBtn,
      h("div", { class: "compile-btn" }, compileMain, compileMore), moreBtn),
  );

  // ── menus ──
  function folderItems() {
    const s = state.session || {};
    const recent = (s.recent || []).filter((p) => p !== s.root).slice(0, 6);
    return [
      { label: "Open folder…", icon: "folder-open", kbd: "Mod-O", onSelect: a.openFolder },
      { label: "New project…", icon: "plus", onSelect: a.newProject },
      { label: "Import a ZIP…", sub: "For example a project downloaded from Overleaf", icon: "archive", onSelect: a.importZip },
      { label: "Version history…", sub: "See and restore earlier versions", icon: "history", onSelect: a.history },
      recent.length ? "sep" : null,
      recent.length ? { heading: "Recent" } : null,
      ...recent.map((p) => ({ label: p.split(/[\\/]/).filter(Boolean).pop() || p, sub: p, icon: "clock", onSelect: () => a.switchFolder(p) })),
      "sep",
      { label: revealLabel(), icon: "external", onSelect: () => api.reveal(null).catch((e) => toast(e.message, { kind: "error" })) },
      { label: "Copy folder path", icon: "copy", onSelect: () => navigator.clipboard?.writeText(s.root || "").then(() => toast("Path copied.", { kind: "ok" })) },
    ];
  }

  function downloadItems() {
    const run = async (kind, label) => {
      const dismiss = toast(`Preparing ${label}…`, { timeout: 0 });
      try {
        const name = await download(kind);
        dismiss();
        toast(`Downloaded ${name}`, { kind: "ok" });
      } catch (e) {
        dismiss();
        toast(e.message, { kind: "error", timeout: 8000 });
      }
    };
    return [
      { label: "PDF", sub: "The compiled document (.pdf)", icon: "file-pdf", onSelect: () => run("pdf", "PDF") },
      { label: "Word", sub: "Editable .docx; formatting is approximate", icon: "word", onSelect: () => run("docx", "Word document") },
      { label: "Project", sub: "All files in this folder (.zip)", icon: "archive", onSelect: () => run("zip", "zip") },
      { label: "Submission package", sub: "One .tex with its .bbl and images, for arXiv and journals", icon: "cloud", onSelect: () => run("submission", "submission package") },
      "sep",
      { label: "Check before submitting…", icon: "checklist", onSelect: a.check },
    ];
  }

  function themeItems() {
    const pref = themePref();
    return [["system", "Match system"], ["light", "Light"], ["dark", "Dark"]].map(([k, l]) => ({ label: l, checked: pref === k, onSelect: () => applyTheme(k) }));
  }

  function compileItems() {
    return [
      { label: "Compile now", icon: "play", kbd: "Mod-Enter", onSelect: () => a.compile() },
      { label: "Recompile from scratch", sub: "Clears cached build files first", icon: "refresh", onSelect: () => a.compile({ clean: true }) },
      { label: "Stop compiling", icon: "stop", disabled: !state.compiling, onSelect: a.cancel },
      "sep",
      { label: "Compile automatically", checked: settings.autoCompile, onSelect: () => saveSettings({ autoCompile: !settings.autoCompile }) },
    ];
  }

  // ── rendering ──
  let tick;
  function renderStatus() {
    const c = state.compile || {};
    const issues = allIssues();
    const e = issues.filter((i) => i.severity === "error").length;
    const w = issues.filter((i) => i.severity === "warning").length;
    const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
    clearInterval(tick);
    let cls = "", text = "", short = "", busy = false;
    if (state.engineProgress) {
      const { done, total } = state.engineProgress;
      const pct = total ? Math.round((done / total) * 100) : 0;
      cls = "busy"; busy = true; text = `Setting up LaTeX engine… ${pct}%`; short = `${pct}%`;
    } else if (state.compiling) {
      cls = "busy"; busy = true; text = "Compiling…";
      const started = Date.now();
      tick = setInterval(() => {
        const s = Math.round((Date.now() - started) / 1000);
        const t = pill.querySelector(".txt");
        if (t && s >= 3) t.textContent = `Compiling… ${s}s`;
      }, 1000);
    } else if (c.status === "failed") {
      cls = "error"; text = e > 1 ? `Couldn't compile · ${plural(e, "error")}` : "Couldn't compile"; short = String(Math.max(e, 1));
    } else if (e) {
      cls = "error"; text = plural(e, "error") + (w ? ` · ${plural(w, "warning")}` : ""); short = String(e);
    } else if (w) {
      cls = "warning"; text = plural(w, "warning"); short = String(w);
    } else if (c.status === "ok") {
      cls = "ok"; text = `Compiled · ${((c.durationMs || 0) / 1000).toFixed(1)} s`;
    } else {
      text = "Not compiled yet";
    }
    pill.className = `status-pill ${cls}`;
    pill.replaceChildren(...[busy ? h("span", { class: "spinner" }) : h("span", { class: "dot" }), h("span", { class: "txt" }, text),
      short ? h("span", { class: "short" }, short) : null].filter(Boolean));
    pill.setAttribute("aria-label", text);
    mainIcon.replaceChildren(state.compiling ? h("span", { class: "spinner" }) : icon("play", "fill"));
    mainLabel.textContent = state.compiling ? "Compiling" : "Compile";
  }

  function renderLayout() {
    const narrow = window.matchMedia("(max-width: 1023px)").matches;
    const current = narrow ? state.pane : state.layout;
    seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.layout === current)));
  }

  function renderName() {
    const s = state.session;
    nameEl.textContent = s ? s.name : "…";
    folderBtn.title = s ? s.root : "";
  }

  on(["compile", "compiling", "engineProgress", "analysis"], renderStatus);
  on(["layout", "pane"], renderLayout);
  on(["session"], renderName);
  window.matchMedia("(max-width: 1023px)").addEventListener("change", renderLayout);
  renderStatus();
  renderLayout();
}
