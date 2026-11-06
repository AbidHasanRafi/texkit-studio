// Issues drawer: friendly compile problems with jump-to-line and one-click fixes, plus the raw log.

import { api } from "./api.js";
import { h, icon } from "./dom.js";
import { state, set, on, allIssues } from "./store.js";

const FILTERS = [
  ["all", "All", () => true],
  ["error", "Errors", (i) => i.severity === "error"],
  ["warning", "Warnings", (i) => i.severity === "warning" && i.category !== "references" && i.category !== "language"],
  ["references", "References", (i) => i.category === "references"],
  ["language", "Language", (i) => i.category === "language"],
  ["info", "Typesetting", (i) => i.category === "typesetting"],
];

export function initIssues({ onJump, onFix }) {
  let filter = "all";
  let view = "issues"; // issues | log
  let fullLog = null;
  const expanded = new Set();

  const chips = h("div", { class: "chips", role: "group", "aria-label": "Filter issues" });
  const logBtn = h("button", { class: "btn small plain", "aria-pressed": "false", onclick: () => { view = view === "log" ? "issues" : "log"; fullLog = null; render(); } },
    icon("terminal", "sm"), "Raw log");
  const body = h("div", { class: "issues", role: "list" });
  const log = h("pre", { class: "rawlog hidden" });
  const drawer = h("div", { class: "drawer hidden", role: "region", "aria-label": "Issues" },
    h("div", { class: "drawer-head" },
      h("h2", null, "Issues"),
      chips,
      h("div", { class: "right" },
        logBtn,
        h("button", { class: "icon-btn sm", title: "Hide issues", "aria-label": "Hide issues", onclick: () => set({ issuesOpen: false }) }, icon("x", "sm")),
      ),
    ),
    body,
    log,
  );

  function counts() {
    const all = allIssues();
    return Object.fromEntries(FILTERS.map(([k, , test]) => [k, all.filter(test).length]));
  }

  function card(issue, key) {
    const sevIcon = issue.category === "references" && issue.severity !== "error" ? "link" : { error: "err", warning: "warn", info: "ruler" }[issue.severity];
    const where = issue.file ? `${issue.file}${issue.line ? `:${issue.line}` : ""}` : issue.line ? `line ${issue.line}` : null;
    const open = expanded.has(key);
    const fixes = (issue.fixes || []).map((f) => h("button", { class: "btn tinted", onclick: () => onFix(issue, f) }, icon("bulb", "sm"), f.label));
    const showRaw = issue.raw && issue.raw !== issue.title && issue.source !== "analysis";
    return h("article", { class: `issue ${issue.severity}`, role: "listitem" },
      h("span", { class: "sev" }, icon(sevIcon)),
      h("div", { class: "title" }, issue.title || issue.raw),
      where ? h("button", { class: "loc", title: "Go to this line", onclick: () => onJump(issue.file, issue.line) }, where) : h("span"),
      issue.explanation ? h("div", { class: "why" }, issue.explanation) : null,
      fixes.length || showRaw ? h("div", { class: "actions" }, fixes,
        showRaw ? h("button", { class: "btn small plain", "aria-expanded": String(open), onclick: () => { open ? expanded.delete(key) : expanded.add(key); render(); } },
          icon(open ? "chev-d" : "chev-r", "sm"), open ? "Hide original message" : "Show original message") : null) : null,
      open ? h("div", { class: "raw" }, issue.raw + (issue.context ? `\n\n${issue.context}` : "")) : null,
    );
  }

  function render() {
    drawer.classList.toggle("hidden", !state.issuesOpen);
    if (!state.issuesOpen) return;
    const c = counts();
    chips.replaceChildren(...FILTERS.filter(([k]) => k === "all" || c[k] || filter === k).map(([k, label]) => h("button", {
      class: "chip", "aria-pressed": String(filter === k), onclick: () => { filter = k; view = "issues"; render(); },
    }, label, h("span", { class: "ct" }, c[k]))));
    logBtn.setAttribute("aria-pressed", String(view === "log"));
    body.classList.toggle("hidden", view === "log");
    log.classList.toggle("hidden", view !== "log");
    if (view === "log") {
      log.textContent = fullLog ?? (state.log.length ? state.log.join("\n") : "No compiler output yet.");
      if (fullLog == null) {
        log.append(h("div", { style: { marginTop: "10px" } },
          h("button", { class: "btn small secondary", onclick: async () => { const r = await api.log(); fullLog = r.log || "The engine didn't write a log file."; render(); } }, "Show the full TeX log")));
      }
      log.scrollTop = log.scrollHeight;
      return;
    }
    const test = (FILTERS.find(([k]) => k === filter) || FILTERS[0])[2];
    const list = allIssues().filter(test);
    if (!list.length) {
      const msg = state.compiling ? "Compiling…" : state.compile.status === "idle" ? "Compile to check for problems." : "No problems found.";
      body.replaceChildren(h("div", { class: "issues-empty" }, state.compiling ? h("span", { class: "spinner" }) : icon("check-circle"), msg));
      return;
    }
    body.replaceChildren(...list.map((issue, i) => card(issue, `${issue.file}:${issue.line}:${issue.raw}:${i}`)));
  }

  on(["compile", "issuesOpen", "compiling", "analysis"], render);
  on(["log"], () => { if (state.issuesOpen && view === "log" && fullLog == null) render(); });
  return drawer;
}
