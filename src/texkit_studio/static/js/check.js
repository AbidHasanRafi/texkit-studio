// Submission check: everything worth fixing before you send the paper, in one list.

import { api } from "./api.js";
import { h, icon, dialog, toast } from "./dom.js";
import { state } from "./store.js";
import * as editor from "./editor.js";

export async function checkDialog({ pageCount, onCompile, onDownload } = {}) {
  const body = h("div", { class: "ck" }, h("div", { class: "fb-empty" }, h("span", { class: "spinner" }), " Checking your document…"));
  const d = dialog({
    title: "Submission check",
    wide: true,
    body,
    footer: [h("span", { class: "grow" }, "Journals differ: treat this as a checklist, not a verdict."),
      h("button", { class: "btn plain", onclick: () => d.close() }, "Close"),
      h("button", { class: "btn primary", onclick: () => { d.close(); onDownload && onDownload(); } }, icon("archive", "sm"), "Download submission package")],
  });

  let data;
  try { data = await api.check(); } catch (e) { body.replaceChildren(h("div", { class: "fb-empty" }, e.message)); return; }
  const a = data.analysis;
  const comp = data.compile;
  const checks = a.checks || [];
  const by = (rule) => checks.filter((c) => c.rule === rule);
  const jump = (c) => { d.close(); editor.jumpTo(c.file, c.line); };

  const rows = [];
  const add = (status, title, detail, items = [], action = null) => rows.push({ status, title, detail, items, action });

  // Compiles cleanly?
  if (!comp) add("todo", "Compile the document", "Compile once so it can be checked for LaTeX errors.", [], { label: "Compile now", run: () => { d.close(); onCompile(); } });
  else {
    const errs = (comp.issues || []).filter((i) => i.severity === "error");
    const boxes = (comp.issues || []).filter((i) => i.category === "typesetting");
    add(comp.status === "failed" ? "bad" : errs.length ? "bad" : "ok", errs.length ? `${errs.length} LaTeX error${errs.length === 1 ? "" : "s"}` : "Compiles without errors",
      errs.length ? "Errors can make the PDF differ from what you expect." : "", errs.slice(0, 6));
    add(boxes.length ? "warn" : "ok", boxes.length ? `${boxes.length} line${boxes.length === 1 ? "" : "s"} running into the margin` : "Nothing runs into the margin",
      boxes.length ? "Journals often reject PDFs with text in the margins." : "", boxes.slice(0, 6));
  }

  // Your request: everything referenced, everything cited, nothing pointing nowhere.
  const broken = [...by("ref-missing"), ...by("cite-missing")];
  add(broken.length ? "bad" : "ok", broken.length ? `${broken.length} reference${broken.length === 1 ? "" : "s"} or citation${broken.length === 1 ? "" : "s"} pointing nowhere` : "Every \\ref and \\cite points somewhere",
    broken.length ? "These print as ?? or [?] in the PDF." : "", broken);
  const unref = by("float-unreferenced");
  const floats = a.floats.filter((f) => f.depth === 0 && (f.kind === "figure" || f.kind === "table"));
  add(unref.length ? "warn" : "ok", unref.length ? `${unref.length} figure${unref.length === 1 ? "" : "s"} or table${unref.length === 1 ? "" : "s"} never referred to` : floats.length ? `All ${floats.length} figures and tables are referred to in the text` : "No figures or tables",
    unref.length ? "Most journals require every figure and table to be mentioned in the text." : "", unref);
  const nolabel = [...by("float-no-label"), ...by("float-no-caption")];
  if (nolabel.length) add("warn", `${nolabel.length} figure${nolabel.length === 1 ? "" : "s"} or table${nolabel.length === 1 ? "" : "s"} missing a label or caption`, "", nolabel);
  const order = by("float-order");
  if (order.length) add("warn", "Figures or tables mentioned out of order", "IEEE and many other journals require numerical order.", order);
  const uncited = by("bib-uncited");
  const entries = a.bibliography.entries.length;
  add(uncited.length ? "warn" : "ok", uncited.length ? `${uncited.length} bibliography entr${uncited.length === 1 ? "y is" : "ies are"} never cited` : entries ? `All ${entries} bibliography entries are cited` : "No bibliography entries",
    uncited.length ? "Cite them in the text, or remove them from the .bib file." : "", uncited);
  const bibProblems = [...by("no-bibliography"), ...by("bib-file-missing"), ...by("bib-duplicate"), ...by("label-duplicate")];
  if (bibProblems.length) add("bad", "Bibliography and label problems", "", bibProblems);
  const missingFiles = [...by("graphic-missing"), ...by("input-missing")];
  if (missingFiles.length) add("bad", `${missingFiles.length} missing file${missingFiles.length === 1 ? "" : "s"}`, "", missingFiles);
  if (data.unusedFiles.length) {
    add("info", `${data.unusedFiles.length} file${data.unusedFiles.length === 1 ? "" : "s"} in the folder the paper doesn't use`,
      "Not a problem, but leave them out of a submission. The submission package already does.",
      data.unusedFiles.slice(0, 12).map((f) => ({ title: f, file: f, line: null, open: true })));
  }

  const s = data.stats;
  const stat = (label, value) => h("div", { class: "ck-stat" }, h("div", { class: "ck-val" }, value ?? "—"), h("div", { class: "ck-lbl" }, label));
  const stats = h("div", { class: "ck-stats" },
    stat("pages", pageCount || "—"), stat("words", s.words.toLocaleString()), stat("abstract words", s.abstractWords),
    stat("figures", s.figures), stat("tables", s.tables), stat("sources cited", s.citations));

  const statusIcon = { ok: "check-circle", warn: "warn", bad: "err", info: "info", todo: "info" };
  const list = h("div", { class: "ck-list" }, rows.map((r) => h("div", { class: `ck-row ${r.status}` },
    h("span", { class: "ck-icon" }, icon(statusIcon[r.status])),
    h("div", { class: "ck-body" },
      h("div", { class: "ck-title" }, r.title),
      r.detail ? h("div", { class: "ck-detail" }, r.detail) : null,
      r.items.length ? h("div", { class: "ck-items" }, r.items.slice(0, 12).map((c) => h("button", {
        class: "ck-item", onclick: () => (c.open ? (d.close(), editor.openFile(c.file)) : jump(c)),
      }, h("span", null, c.title), c.file && !c.open ? h("code", null, `${c.file}${c.line ? `:${c.line}` : ""}`) : null))) : null,
      r.action ? h("button", { class: "btn small secondary", style: { marginTop: "6px" }, onclick: r.action.run }, r.action.label) : null,
    ))));

  const sections = s.sections.filter((x) => x.level <= 2 && x.words);
  const words = sections.length ? h("details", { class: "ck-words" }, h("summary", null, "Words per section"),
    h("div", null, sections.map((x) => h("div", { class: "setting" }, h("span", null, x.title), h("span", { class: "rf-count" }, x.words.toLocaleString()))))) : null;

  const bad = rows.filter((r) => r.status === "bad").length, warn = rows.filter((r) => r.status === "warn").length;
  const verdict = h("div", { class: `ck-verdict ${bad ? "bad" : warn ? "warn" : "ok"}` },
    icon(bad ? "err" : warn ? "warn" : "check-circle", "lg"),
    h("div", null, h("div", { class: "ck-title" }, bad ? "A few things need fixing" : warn ? "Nearly ready" : "Looks ready to submit"),
      h("div", { class: "ck-detail" }, bad || warn ? `${bad ? `${bad} problem${bad === 1 ? "" : "s"}` : ""}${bad && warn ? " and " : ""}${warn ? `${warn} thing${warn === 1 ? "" : "s"} to review` : ""}.` : "Every check passed.")));
  body.replaceChildren(verdict, stats, list, words);
  if (state.compile.status === "idle") toast("Compile first for the full check.", { timeout: 3000 });
}
