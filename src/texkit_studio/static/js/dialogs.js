// Dialogs: folder browser ("Open folder…"), new project from a template, settings; theme handling.

import { api } from "./api.js";
import { h, icon, dialog, promptDialog, toast, store, save } from "./dom.js";
import { state } from "./store.js";
import { settings, saveSettings } from "./editor.js";

// ── Theme ─────────────────────────────────────────────────────────────
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
export function themePref() { return store("theme", "system"); }
export function applyTheme(pref = themePref()) {
  save("theme", pref);
  const dark = pref === "dark" || (pref === "system" && darkQuery.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.dispatchEvent(new CustomEvent("texkit:theme"));
}
darkQuery.addEventListener("change", () => { if (themePref() === "system") applyTheme("system"); });

// ── Folder browser ────────────────────────────────────────────────────
/**
 * Browse the computer's folders. Resolves with the chosen absolute path, or null.
 * mode "open": choose a folder to work in. mode "choose": pick a location (e.g. for a new project).
 */
export function folderDialog({ mode = "open", start = null, title } = {}) {
  return new Promise((resolve) => {
    let current = null;
    const places = h("nav", { class: "fb-places", "aria-label": "Places" });
    const pathInput = h("input", { type: "text", spellcheck: "false", "aria-label": "Folder path" });
    const crumbs = h("div", { class: "fb-crumbs" });
    const list = h("div", { class: "fb-list", role: "listbox", "aria-label": "Folders" });
    const info = h("span", { class: "grow" });
    const okBtn = h("button", { class: "btn primary", onclick: () => d.close(current?.path) }, mode === "open" ? "Open" : "Choose");
    const upBtn = h("button", { class: "icon-btn", title: "Up one level", "aria-label": "Up one level", onclick: () => current?.parent && load(current.parent) }, icon("arrow-up"));
    const newBtn = h("button", { class: "btn small secondary", onclick: makeFolder }, icon("folder-plus", "sm"), "New folder");

    const d = dialog({
      title: title || (mode === "open" ? "Open folder" : "Choose a location"),
      wide: true,
      body: h("div", { class: "fb" }, places,
        h("div", { class: "fb-main" }, h("div", { class: "fb-bar" }, upBtn, pathInput, newBtn), crumbs, list)),
      footer: [info, h("button", { class: "btn plain", onclick: () => d.close(null) }, "Cancel"), okBtn],
      onClose: (r) => resolve(r || null),
    });
    d.el.querySelector(".dialog-body").style.padding = "0";

    pathInput.addEventListener("keydown", (e) => { if (e.key === "Enter") load(pathInput.value.trim()); });

    async function load(path) {
      list.replaceChildren(h("div", { class: "fb-empty" }, "Loading…"));
      try {
        current = await api.browse(path);
      } catch (e) {
        list.replaceChildren(h("div", { class: "fb-empty" }, e.message));
        return;
      }
      pathInput.value = current.path;
      upBtn.disabled = !current.parent;
      crumbs.replaceChildren(...current.crumbs.map((c) => h("button", { onclick: () => load(c.path) }, c.name)));
      crumbs.scrollLeft = crumbs.scrollWidth;
      okBtn.textContent = `${mode === "open" ? "Open" : "Choose"} “${current.name}”`;
      info.textContent = current.hasTex ? "This folder has LaTeX files." : mode === "open" ? "No LaTeX files here yet. You can start one from a template." : "";
      list.replaceChildren(...(current.entries.length ? current.entries.map((e) => h("button", {
        class: "fb-row", role: "option", title: e.path, onclick: () => load(e.path),
      }, icon("folder", "dir"), h("span", { class: "name" }, e.name), e.hasTex ? h("span", { class: "badge" }, "LaTeX") : null, icon("chev-r", "sm chev"))) : [h("div", { class: "fb-empty" }, "No folders inside.")]));
      list.scrollTop = 0;
      places.querySelectorAll(".place").forEach((p) => p.classList.toggle("current", p.dataset.path === current.path));
    }

    async function makeFolder() {
      if (!current) return;
      const name = await promptDialog({ title: "New folder", label: `Inside ${current.path}`, okLabel: "Create" });
      if (!name) return;
      try { const r = await api.mkdir(current.path, name); load(r.path); } catch (e) { toast(e.message, { kind: "error" }); }
    }

    api.shortcuts().then((s) => {
      const group = (label, items) => items.length ? [h("div", { class: "menu-head" }, label), ...items.map((p) =>
        h("button", { class: "place", "data-path": p.path, title: p.path, onclick: () => load(p.path) }, icon(p.icon, "sm"), h("span", null, p.name)))] : [];
      places.replaceChildren(...group("Places", s.places), ...group(state.session?.platform === "win32" ? "Drives" : "Computer", s.drives), ...group("Recent", s.recent));
      if (current) places.querySelectorAll(".place").forEach((p) => p.classList.toggle("current", p.dataset.path === current.path));
    }).catch(() => {});

    load(start || state.session?.root || null);
  });
}

// ── New project ───────────────────────────────────────────────────────
export async function newProjectDialog() {
  let data;
  try { data = await api.templates(); } catch (e) { toast(e.message, { kind: "error" }); return null; }
  return new Promise((resolve) => {
    let chosen = data.templates[0]?.id;
    let parent = data.defaultParent;
    let here = !data.currentHasTex;
    const grid = h("div", { class: "tpl-grid", role: "radiogroup", "aria-label": "Templates" });
    const nameInput = h("input", { type: "text", value: "my-paper", spellcheck: "false" });
    const whereCode = h("code");
    const err = h("div", { class: "error-text" });
    const nameField = h("div", { class: "field" }, h("label", null, "Project name"), nameInput,
      h("div", { class: "where" }, icon("folder", "sm"), whereCode,
        h("button", { class: "btn small secondary", onclick: async () => {
          const p = await folderDialog({ mode: "choose", start: parent, title: "Where should the project go?" });
          if (p) { parent = p; renderWhere(); }
        } }, "Change…")),
      h("div", { class: "hint" }, "A new folder with this name is created there."));
    const hereBox = h("input", { type: "checkbox", id: "tpl-here" });
    hereBox.checked = here;
    hereBox.addEventListener("change", () => { here = hereBox.checked; nameField.classList.toggle("hidden", here); });
    nameField.classList.toggle("hidden", here);

    function renderGrid() {
      grid.replaceChildren(...data.templates.map((t) => h("button", {
        class: "tpl", role: "radio", "aria-checked": String(t.id === chosen), onclick: () => { chosen = t.id; renderGrid(); },
        ondblclick: create,
      }, h("span", { class: "cat" }, t.category), h("span", { class: "nm" }, t.name), h("span", { class: "ds" }, t.description))));
    }
    function renderWhere() { whereCode.textContent = parent; whereCode.title = parent; }

    const createBtn = h("button", { class: "btn primary", onclick: create }, "Create");
    const d = dialog({
      title: "New project",
      wide: true,
      body: h("div", null,
        h("p", null, "Start from a template. Everything is saved as ordinary files you can open anywhere."),
        grid,
        !data.currentHasTex ? h("label", { class: "check-row", for: "tpl-here" }, hereBox, `Put the files in the current folder (${state.session?.name}) instead`) : null,
        nameField,
        err),
      footer: [h("span", { class: "grow" }), h("button", { class: "btn plain", onclick: () => d.close(null) }, "Cancel"), createBtn],
      onClose: (r) => resolve(r || null),
    });
    renderGrid();
    renderWhere();

    async function create() {
      const name = nameInput.value.trim();
      if (!here && (!name || /[<>:"/\\|?*]/.test(name))) { err.textContent = "Choose a folder name without < > : \" / \\ | ? *"; return; }
      createBtn.disabled = true;
      try {
        const r = await api.applyTemplate(here ? { id: chosen, here: true } : { id: chosen, parent, name });
        d.close(r);
      } catch (e) {
        err.textContent = e.message;
        createBtn.disabled = false;
      }
    }
  });
}

// ── Settings ──────────────────────────────────────────────────────────
function switchEl(checked, onChange, label) {
  const el = h("button", { class: "switch", role: "switch", "aria-checked": String(checked), "aria-label": label });
  el.addEventListener("click", () => {
    const v = el.getAttribute("aria-checked") !== "true";
    el.setAttribute("aria-checked", String(v));
    onChange(v);
  });
  return el;
}

function indentSeg() {
  const seg = h("div", { class: "segmented", role: "tablist", "aria-label": "Indentation" });
  const render = () => seg.replaceChildren(...[[2, "2 spaces"], [4, "4 spaces"]].map(([n, l]) =>
    h("button", { role: "tab", "aria-selected": String(settings.formatIndent === n), onclick: () => { saveSettings({ formatIndent: n }); render(); } }, l)));
  render();
  return seg;
}

export function settingsDialog() {
  const themeSeg = h("div", { class: "segmented", role: "tablist", "aria-label": "Appearance" });
  const renderTheme = () => themeSeg.replaceChildren(...[["system", "System"], ["light", "Light"], ["dark", "Dark"]].map(([k, l]) =>
    h("button", { role: "tab", "aria-selected": String(themePref() === k), onclick: () => { applyTheme(k); renderTheme(); } }, l)));
  renderTheme();
  const sizeVal = h("span", null, `${settings.fontSize}px`);
  const step = (d) => { const v = Math.max(11, Math.min(22, settings.fontSize + d)); saveSettings({ fontSize: v }); sizeVal.textContent = `${v}px`; };
  const row = (label, sub, control) => h("div", { class: "setting" }, h("div", { class: "lbl" }, label, sub ? h("small", null, sub) : null), control);
  const s = state.session || {};
  dialog({
    title: "Settings",
    body: h("div", null,
      row("Appearance", null, themeSeg),
      row("Compile automatically", "A moment after you stop typing", switchEl(settings.autoCompile, (v) => saveSettings({ autoCompile: v }), "Compile automatically")),
      row("Wrap long lines", null, switchEl(settings.wrap, (v) => saveSettings({ wrap: v }), "Wrap long lines")),
      h("div", { class: "settings-head" }, "Formatting"),
      row("Format when I press Ctrl/⌘+S", "Tidies the file before compiling, like Prettier's format on save",
        switchEl(settings.formatOnSave, (v) => saveSettings({ formatOnSave: v }), "Format on save")),
      row("Indentation", null, indentSeg()),
      row("Line up table columns", "Aligns the & in tables and equations", switchEl(settings.formatAlign, (v) => saveSettings({ formatAlign: v }), "Line up table columns")),
      h("div", { class: "settings-head" }, "Other"),
      row("Spell check", "Uses your browser's dictionary", switchEl(settings.spellcheck, (v) => saveSettings({ spellcheck: v }), "Spell check")),
      row("Work offline", "Downloads the packages the templates use, once", h("button", {
        class: "btn small secondary",
        onclick: (e) => { e.currentTarget.disabled = true; e.currentTarget.textContent = "Preparing…"; document.dispatchEvent(new CustomEvent("texkit:prepare-offline")); },
      }, "Prepare")),
      row("Editor text size", null, h("div", { class: "stepper" },
        h("button", { class: "icon-btn sm", "aria-label": "Smaller", onclick: () => step(-1) }, icon("minus", "sm")), sizeVal,
        h("button", { class: "icon-btn sm", "aria-label": "Larger", onclick: () => step(1) }, icon("plus", "sm")))),
      h("p", { style: { marginTop: "14px", fontSize: "12px" } },
        `${s.product || "TexKit Studio"} ${s.version || ""} · LaTeX engine: Tectonic ${s.engine?.version || ""}${s.engine?.installed ? "" : " (downloads on first compile)"}`),
    ),
  });
}
