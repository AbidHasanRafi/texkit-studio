// Pickers: the command palette (Ctrl/⌘+K), and the searchable lists behind
// "Insert reference", "Insert citation" and "Insert symbol". Also the shortcuts sheet.

import { h, icon, kbd, dialog, closeMenu } from "./dom.js";

/**
 * A searchable list in a floating panel.
 * items: [{label, sub, icon, kbd, group, keywords, badge, run}] (or a function returning them)
 */
export function picker({ title, placeholder = "Search…", items, empty = "Nothing found.", onPick }) {
  closeMenu();
  const prevFocus = document.activeElement;
  const input = h("input", { type: "text", class: "pk-input", placeholder, spellcheck: "false", "aria-label": title || placeholder });
  const list = h("div", { class: "pk-list", role: "listbox" });
  const panel = h("div", { class: "pk glass", role: "dialog", "aria-label": title || "Search" },
    title ? h("div", { class: "pk-title" }, title) : null,
    h("div", { class: "pk-search" }, icon("search"), input),
    list,
  );
  const overlay = h("div", { class: "pk-overlay", onmousedown: (e) => { if (e.target === overlay) close(); } }, panel);
  document.body.append(overlay);

  const all = typeof items === "function" ? items() : items;
  let shown = [];
  let active = 0;

  function score(it, terms) {
    const label = it.label.toLowerCase();
    const hay = `${label} ${it.sub || ""} ${it.keywords || ""} ${it.group || ""}`.toLowerCase();
    let s = 0;
    for (const t of terms) {
      if (!hay.includes(t)) return -1;
      if (label.startsWith(t)) s += 4;
      else if (new RegExp(`(^|[\\s\\-_:/.])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(label)) s += 3;
      else if (label.includes(t)) s += 2;
      else s += 1;
    }
    return s - label.length / 200;  // shorter labels win ties
  }

  function render() {
    const terms = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    shown = terms.length
      ? all.map((it) => [it, score(it, terms)]).filter(([, s]) => s >= 0).sort((a, b) => b[1] - a[1]).map(([it]) => it)
      : all;
    shown = shown.slice(0, 200);
    active = Math.min(active, Math.max(0, shown.length - 1));
    const rows = [];
    let lastGroup = null;
    shown.forEach((it, i) => {
      if (!terms.length && it.group && it.group !== lastGroup) {
        rows.push(h("div", { class: "pk-group" }, it.group));
        lastGroup = it.group;
      }
      rows.push(h("button", {
        class: `pk-item${i === active ? " active" : ""}`, role: "option", "aria-selected": String(i === active),
        onmousemove: () => { if (active !== i) { active = i; highlight(); } },
        onclick: () => pick(it),
      },
        it.icon ? icon(it.icon) : h("span", { class: "pk-glyph" }, it.glyph || ""),
        h("span", { class: "pk-text" }, h("span", { class: "pk-label" }, it.label), it.sub ? h("span", { class: "pk-sub" }, it.sub) : null),
        it.badge ? h("span", { class: `pk-badge ${it.badgeClass || ""}` }, it.badge) : null,
        it.kbd ? h("kbd", null, kbd(it.kbd)) : null,
      ));
    });
    list.replaceChildren(...(rows.length ? rows : [h("div", { class: "pk-empty" }, empty)]));
    highlight();
  }

  function highlight() {
    list.querySelectorAll(".pk-item").forEach((el, i) => {
      el.classList.toggle("active", i === active);
      el.setAttribute("aria-selected", String(i === active));
      if (i === active) el.scrollIntoView({ block: "nearest" });
    });
  }

  function pick(it) {
    close();
    (it.run || onPick)?.(it);
  }

  function close() {
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
    if (prevFocus && prevFocus.focus) prevFocus.focus();
  }

  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(shown.length - 1, active + 1); highlight(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(0, active - 1); highlight(); }
    else if (e.key === "Enter") { e.preventDefault(); if (shown[active]) pick(shown[active]); }
  }
  document.addEventListener("keydown", onKey, true);
  input.addEventListener("input", () => { active = 0; render(); });
  render();
  requestAnimationFrame(() => input.focus());
  return { close };
}

// ── Keyboard shortcuts sheet ────────────────────────────────────────────
export const SHORTCUTS = [
  ["Compile", "Mod-Enter"], ["Compile (also saves)", "Mod-S"], ["Format document", "Shift-Alt-F"],
  ["Command palette", "Mod-K"], ["Quick open a file", "Mod-P"],
  ["Insert reference", "Alt-R"], ["Insert citation", "Alt-C"], ["Insert symbol", "Alt-S"],
  ["Show this line in the PDF", "Mod-Shift-J"], ["Jump from PDF to source", "Double-click the PDF"],
  ["Go to a label, citation or file", `${kbd("Mod-")}click it`], ["Bold / italic", "Mod-B / Mod-I"],
  ["Comment / uncomment", "Mod-/"], ["Find in file", "Mod-F"], ["Search all files", "Mod-Shift-F"],
  ["Toggle issues", "Mod-Shift-M"], ["Toggle sidebar", "Mod-\\"], ["Editor / split / PDF", "Mod-1 / Mod-2 / Mod-3"],
  ["Focus mode", "Mod-Shift-Enter"], ["Open folder", "Mod-O"],
];

export function shortcutsDialog() {
  dialog({
    title: "Keyboard shortcuts",
    body: h("div", { class: "shortcuts" }, SHORTCUTS.map(([what, keys]) =>
      h("div", { class: "setting" }, h("span", null, what), h("kbd", { class: "keys" }, keys.split(" / ").map((k) => kbd(k)).join(" / "))))),
  });
}

// ── Symbols ────────────────────────────────────────────────────────────
export const SYMBOLS = [
  ["α", "\\alpha", "alpha"], ["β", "\\beta", "beta"], ["γ", "\\gamma", "gamma"], ["δ", "\\delta", "delta"],
  ["ε", "\\epsilon", "epsilon"], ["ε", "\\varepsilon", "varepsilon"], ["ζ", "\\zeta", "zeta"], ["η", "\\eta", "eta"],
  ["θ", "\\theta", "theta"], ["ι", "\\iota", "iota"], ["κ", "\\kappa", "kappa"], ["λ", "\\lambda", "lambda"],
  ["μ", "\\mu", "mu micro"], ["ν", "\\nu", "nu"], ["ξ", "\\xi", "xi"], ["π", "\\pi", "pi"], ["ρ", "\\rho", "rho"],
  ["σ", "\\sigma", "sigma"], ["τ", "\\tau", "tau"], ["φ", "\\phi", "phi"], ["φ", "\\varphi", "varphi"],
  ["χ", "\\chi", "chi"], ["ψ", "\\psi", "psi"], ["ω", "\\omega", "omega"], ["Γ", "\\Gamma", "Gamma"],
  ["Δ", "\\Delta", "Delta"], ["Θ", "\\Theta", "Theta"], ["Λ", "\\Lambda", "Lambda"], ["Π", "\\Pi", "Pi"],
  ["Σ", "\\Sigma", "Sigma sum"], ["Φ", "\\Phi", "Phi"], ["Ψ", "\\Psi", "Psi"], ["Ω", "\\Omega", "Omega ohm"],
  ["±", "\\pm", "plus minus"], ["∓", "\\mp", "minus plus"], ["×", "\\times", "times multiply"], ["÷", "\\div", "divide"],
  ["·", "\\cdot", "dot multiply"], ["≤", "\\leq", "less equal"], ["≥", "\\geq", "greater equal"], ["≠", "\\neq", "not equal"],
  ["≈", "\\approx", "approximately"], ["≡", "\\equiv", "equivalent identical"], ["∼", "\\sim", "similar tilde"],
  ["∝", "\\propto", "proportional"], ["≪", "\\ll", "much less"], ["≫", "\\gg", "much greater"],
  ["∞", "\\infty", "infinity"], ["∂", "\\partial", "partial derivative"], ["∇", "\\nabla", "nabla gradient"],
  ["∑", "\\sum", "sum"], ["∏", "\\prod", "product"], ["∫", "\\int", "integral"], ["∮", "\\oint", "contour integral"],
  ["√", "\\sqrt{}", "square root"], ["½", "\\frac{}{}", "fraction"], ["→", "\\rightarrow", "right arrow to"],
  ["←", "\\leftarrow", "left arrow"], ["↔", "\\leftrightarrow", "left right arrow"], ["⇒", "\\Rightarrow", "implies"],
  ["⇐", "\\Leftarrow", "implied by"], ["⇔", "\\Leftrightarrow", "if and only if iff"], ["↦", "\\mapsto", "maps to"],
  ["∈", "\\in", "element of in"], ["∉", "\\notin", "not in"], ["⊂", "\\subset", "subset"], ["⊆", "\\subseteq", "subset equal"],
  ["∪", "\\cup", "union"], ["∩", "\\cap", "intersection"], ["∅", "\\emptyset", "empty set"], ["∀", "\\forall", "for all"],
  ["∃", "\\exists", "exists"], ["¬", "\\neg", "not negation"], ["∧", "\\land", "and"], ["∨", "\\lor", "or"],
  ["ℝ", "\\mathbb{R}", "real numbers"], ["ℕ", "\\mathbb{N}", "natural numbers"], ["ℤ", "\\mathbb{Z}", "integers"],
  ["ℂ", "\\mathbb{C}", "complex numbers"], ["…", "\\ldots", "dots ellipsis"], ["⋯", "\\cdots", "centred dots"],
  ["°", "^\\circ", "degree"], ["′", "^\\prime", "prime"], ["ℏ", "\\hbar", "h bar planck"], ["ℓ", "\\ell", "ell script l"],
  ["⟨", "\\langle", "left angle"], ["⟩", "\\rangle", "right angle"], ["‖", "\\|", "norm double bar"],
  ["x̂", "\\hat{}", "hat"], ["x̄", "\\bar{}", "bar mean"], ["x⃗", "\\vec{}", "vector arrow"], ["ẋ", "\\dot{}", "dot derivative"],
  ["€", "\\euro", "euro (eurosym package)"], ["©", "\\copyright", "copyright"], ["§", "\\S", "section sign"],
  ["–", "--", "en dash range"], ["—", "---", "em dash"], ["“”", "``''", "quotes"], ["%", "\\%", "percent"],
  ["&", "\\&", "ampersand"], ["$", "\\$", "dollar"], ["#", "\\#", "hash"], ["_", "\\_", "underscore"],
];
