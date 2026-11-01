// Insert tools: table builder, symbols, equations, lists, and the editor's Insert menu.

import { h, icon, dialog, toast } from "./dom.js";
import { state } from "./store.js";
import { picker, SYMBOLS } from "./palette.js";
import * as editor from "./editor.js";
import { refPicker, citePicker, doiDialog } from "./refs.js";

const escapeTex = (s) => s.replace(/\\/g, "\\textbackslash{}").replace(/([&%$#_{}])/g, "\\$1").replace(/~/g, "\\textasciitilde{}").replace(/\^/g, "\\textasciicircum{}");
const STOP = new Set(["a", "an", "the", "of", "and", "for", "in", "on", "with", "to", "at", "by"]);
const slug = (s) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w)).slice(0, 3).join("-");

/** Add \usepackage{pkg} to the main file if the document doesn't load it yet. */
export function ensurePackage(pkg) {
  const pk = state.analysis?.packages;
  if (!pk || pk.includes(pkg)) return;
  editor.applyFix({}, { kind: "insertPackage", package: pkg });
}

// ── Table builder ──────────────────────────────────────────────────────
export function tableDialog() {
  let rows = 3, cols = 3;
  let data = [["Method", "Accuracy", "Time (s)"], ["", "", ""], ["", "", ""]];
  let header = true, booktabs = true;
  const grid = h("div", { class: "tb-grid" });
  const caption = h("input", { type: "text", value: "", placeholder: "What the table shows" });
  const align = h("select", { "aria-label": "Column alignment" },
    h("option", { value: "l" }, "Left"), h("option", { value: "c" }, "Centre"), h("option", { value: "r" }, "Right"));
  const rowsVal = h("span"), colsVal = h("span");
  const paste = h("textarea", { class: "tb-paste", rows: "3", placeholder: "Or paste cells copied from Excel, Sheets or Numbers here" });

  const resize = (r, c) => {
    rows = Math.max(1, Math.min(40, r));
    cols = Math.max(1, Math.min(12, c));
    data = Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => (data[i] && data[i][j]) || ""));
    render();
  };

  function render() {
    rowsVal.textContent = `${rows} rows`;
    colsVal.textContent = `${cols} columns`;
    grid.style.gridTemplateColumns = `repeat(${cols}, minmax(70px, 1fr))`;
    grid.replaceChildren(...data.flatMap((row, i) => row.map((cell, j) => {
      const inp = h("input", { type: "text", value: cell, class: i === 0 && header ? "head" : "", "aria-label": `Row ${i + 1}, column ${j + 1}` });
      inp.addEventListener("input", () => { data[i][j] = inp.value; });
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          if (i === rows - 1) { resize(rows + 1, cols); grid.children[(i + 1) * cols + j]?.focus(); }
          else grid.children[(i + 1) * cols + j]?.focus();
        }
      });
      return inp;
    })));
  }

  paste.addEventListener("input", () => {
    const lines = paste.value.replace(/\r/g, "").split("\n").filter((l) => l.trim());
    if (!lines.length) return;
    const parsed = lines.map((l) => (l.includes("\t") ? l.split("\t") : l.split(/\s*[,;]\s*/)));
    const c = Math.max(...parsed.map((r) => r.length));
    data = parsed.map((r) => Array.from({ length: c }, (_, j) => (r[j] || "").trim()));
    rows = data.length; cols = c;
    paste.value = "";
    render();
  });

  const stepper = (label, get, setter) => h("div", { class: "stepper" },
    h("button", { class: "icon-btn sm", "aria-label": `Fewer ${label}`, onclick: () => setter(get() - 1) }, icon("minus", "sm")),
    label === "rows" ? rowsVal : colsVal,
    h("button", { class: "icon-btn sm", "aria-label": `More ${label}`, onclick: () => setter(get() + 1) }, icon("plus", "sm")));
  const toggle = (label, get, setter) => {
    const box = h("input", { type: "checkbox" });
    box.checked = get();
    box.addEventListener("change", () => { setter(box.checked); render(); });
    return h("label", { class: "check-row" }, box, label);
  };

  const d = dialog({
    title: "Insert a table",
    wide: true,
    body: h("div", null,
      h("div", { class: "tb-controls" },
        stepper("rows", () => rows, (v) => resize(v, cols)),
        stepper("columns", () => cols, (v) => resize(rows, v)),
        h("label", { class: "check-row" }, "Align ", align),
        toggle("First row is a header", () => header, (v) => { header = v; }),
        toggle("Professional lines (booktabs)", () => booktabs, (v) => { booktabs = v; })),
      grid,
      paste,
      h("div", { class: "field", style: { marginTop: "12px" } }, h("label", null, "Caption"), caption)),
    footer: [h("span", { class: "grow" }, "Press Enter in the last row to add another."),
      h("button", { class: "btn plain", onclick: () => d.close() }, "Cancel"),
      h("button", { class: "btn primary", onclick: insert }, "Insert table")],
  });
  render();

  function insert() {
    const a = align.value;
    const spec = data[0].map((_, j) => (j === 0 && a !== "l" ? "l" : a)).join("");
    const line = (r) => `    ${r.map((c) => escapeTex(c.trim())).join(" & ")} \\\\`;
    const body = [];
    body.push(booktabs ? "    \\toprule" : "    \\hline");
    data.forEach((r, i) => {
      body.push(line(r));
      if (i === 0 && header) body.push(booktabs ? "    \\midrule" : "    \\hline");
    });
    body.push(booktabs ? "    \\bottomrule" : "    \\hline");
    const cap = caption.value.trim() || "Describe this table.";
    const key = `tab:${slug(caption.value) || "table"}`;
    const text = `\\begin{table}[htbp]\n  \\centering\n  \\caption{${escapeTex(cap)}}\n  \\label{${key}}\n  \\begin{tabular}{${spec}}\n${body.join("\n")}\n  \\end{tabular}\n\\end{table}\n`;
    d.close();
    editor.insertAtCursor(`\n${text}`).then((ok) => {
      if (!ok) return;
      if (booktabs) ensurePackage("booktabs");
      toast(`Table inserted with \\label{${key}}. Refer to it with Insert → Reference.`, { kind: "ok" });
    });
  }
}

// ── Symbols, equations, lists ─────────────────────────────────────────
export function symbolPicker() {
  picker({
    title: "Insert a symbol",
    placeholder: "Search: alpha, arrow, less equal, sum…",
    items: SYMBOLS.map(([glyph, cmd, name]) => ({ glyph, label: name, sub: cmd, keywords: cmd, run: () => insertSymbol(cmd) })),
  });
}

function insertSymbol(cmd) {
  const slot = cmd.indexOf("{}");
  editor.insertAtCursor(cmd, slot >= 0 ? { selectFrom: slot + 1, selectLen: 0 } : {});
}

export function insertEquation() {
  const n = (state.analysis?.labels || []).filter((l) => l.kind === "equation").length + 1;
  const text = `\n\\begin{equation}\n  E = mc^2\n  \\label{eq:${n}}\n\\end{equation}\n`;
  editor.insertAtCursor(text, { selectFrom: text.indexOf("E = mc^2"), selectLen: "E = mc^2".length });
}

export function insertList(kind) {
  editor.insertAtCursor(`\n\\begin{${kind}}\n  \\item \n\\end{${kind}}\n`, { selectFrom: `\n\\begin{${kind}}\n  \\item `.length, selectLen: 0 });
}

export function pickImage() {
  const input = h("input", { type: "file", accept: ".png,.jpg,.jpeg,.pdf,.eps,image/png,image/jpeg", multiple: true });
  input.addEventListener("change", () => input.files.length && editor.insertImages([...input.files]));
  input.click();
}

export function insertMenuItems() {
  return [
    { label: "Figure from an image…", sub: "Or drag an image into the text, or paste a screenshot", icon: "image", onSelect: pickImage },
    { label: "Table…", sub: "Build it in a grid, or paste from a spreadsheet", icon: "table", onSelect: tableDialog },
    { label: "Equation", icon: "sigma", onSelect: insertEquation },
    { label: "Bulleted list", icon: "list", onSelect: () => insertList("itemize") },
    { label: "Numbered list", icon: "list", onSelect: () => insertList("enumerate") },
    "sep",
    { label: "Reference to a figure, table…", icon: "link", kbd: "Alt-R", onSelect: refPicker },
    { label: "Citation…", icon: "quote", kbd: "Alt-C", onSelect: citePicker },
    { label: "Add a source by DOI or arXiv…", icon: "plus", onSelect: doiDialog },
    "sep",
    { label: "Symbol…", icon: "omega", kbd: "Alt-S", onSelect: symbolPicker },
  ];
}
