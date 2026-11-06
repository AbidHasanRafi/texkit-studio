// Reference check: asks Crossref, DataCite, OpenAlex and arXiv whether each bibliography entry is real,
// whether its DOI is the right one, and whether the paper was retracted or corrected.
//
// This module is the shared engine (results cached per project, only new or edited entries are
// re-checked) plus the dialog. The header button and the sidebar badges read from it. Nothing is
// sent online unless the user presses a button or has turned on "Check references automatically".

import { api } from "./api.js";
import { h, icon, dialog, toast, store, save, debounce } from "./dom.js";
import { state, set, on } from "./store.js";
import * as editor from "./editor.js";

const CONCURRENCY = 3;
const RETRY_MS = 2 * 60 * 1000;      // retry an entry the service couldn't answer
const OFFLINE_MS = 5 * 60 * 1000;    // after "no internet", stay quiet this long (automatic mode)
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;  // retractions appear over time, so look again after a week

/** result.code → [short badge text, level] */
export const BADGE = {
  verified: ["Verified", "ok"], retracted: ["Retracted", "bad"], "bad-doi": ["DOI not found", "bad"], "wrong-doi": ["Wrong DOI", "bad"],
  concern: ["Concern", "warn"], notice: ["Retraction notice", "warn"], mismatch: ["Details differ", "warn"], near: ["Unsure match", "warn"],
  "not-found": ["Not found", "warn"], corrected: ["Corrected", "info"], "no-doi": ["No DOI", "info"], author: ["Check authors", "info"],
  "not-indexed": ["Not indexed", "info"], empty: ["No title", "info"],
};
const ICON = { ok: "check-circle", info: "info", warn: "warn", bad: "err" };
const RANK = { bad: 0, warn: 1, info: 2, ok: 3 };

// ── Engine ──────────────────────────────────────────────────────────────
let loadedRoot = null;
let cache = new Map();   // key -> { sig, at, r }
let offlineUntil = 0;
export const run = { running: false, done: 0, total: 0, offline: false, stopped: false };

const notify = () => set({ refcheck: Date.now() + Math.random() });
const sig = (e) => [e.type, e.title, e.author, e.year, e.doi, e.url, e.eprint].join("\u0001");
export const checkable = (a) => (a ? a.bibliography.entries.filter((e) => e.type !== "bibitem") : []);

function ensureCache() {
  const root = state.session?.root || "";
  if (root === loadedRoot) return;
  loadedRoot = root;
  cache = new Map(Object.entries(store(`refcheck:${root}`, {})));
}

function persist() {
  save(`refcheck:${loadedRoot}`, Object.fromEntries([...cache].filter(([, v]) => !v.r.error)));
}

/** The saved result for this entry, or null if it was never checked or has been edited since. */
export function resultFor(e) {
  ensureCache();
  const c = cache.get(e.key);
  return c && c.sig === sig(e) ? c.r : null;
}

function isStale(e) {
  const c = cache.get(e.key);
  if (!c || c.sig !== sig(e)) return true;
  return Date.now() - c.at > (c.r.error ? RETRY_MS : MAX_AGE_MS);
}

export const staleEntries = () => { ensureCache(); return checkable(state.analysis).filter(isStale); };

export function summary() {
  ensureCache();
  const entries = checkable(state.analysis);
  const out = { bad: 0, warn: 0, info: 0, ok: 0, checked: 0, total: entries.length };
  for (const e of entries) {
    const r = resultFor(e);
    if (r && !r.error) { out[r.level] += 1; out.checked += 1; }
  }
  return out;
}

export async function checkEntries(entries) {
  ensureCache();
  if (run.running || !entries.length) return;
  Object.assign(run, { running: true, done: 0, total: entries.length, offline: false, stopped: false });
  notify();
  const queue = [...entries];
  const worker = async () => {
    while (queue.length && !run.stopped && !run.offline) {
      const e = queue.shift();
      try {
        cache.set(e.key, { sig: sig(e), at: Date.now(), r: await api.verifyCitation(e) });
      } catch (err) {
        if (err.status === 503) { run.offline = true; offlineUntil = Date.now() + OFFLINE_MS; break; }
        cache.set(e.key, { sig: sig(e), at: Date.now(), r: { key: e.key, level: "info", code: "error", error: true, notes: [], headline: `Couldn't check this one: ${err.message}` } });
      }
      run.done += 1;
      notify();
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  run.running = false;
  persist();
  notify();
  autoSoon();  // entries edited while we were busy
}

function autoCheck() {
  if (!editor.settings.autoVerify || run.running || Date.now() < offlineUntil || !state.analysis) return;
  const todo = staleEntries();
  if (todo.length) checkEntries(todo);
}
const autoSoon = debounce(autoCheck, 2500);
on(["analysis"], autoSoon);

export function setAutoVerify(on_) {
  editor.saveSettings({ autoVerify: on_ });
  if (on_) { offlineUntil = 0; autoCheck(); } else notify();
}

// ── Dialog ──────────────────────────────────────────────────────────────
export async function verifyDialog() {
  let a = state.analysis;
  if (!a) { try { a = await api.analysis(); } catch (e) { toast(`Couldn't read the bibliography: ${e.message}`, { kind: "error" }); return; } }
  const entries = checkable(a);
  const added = new Set();

  const summaryEl = h("div", { class: "ck-stats" });
  const list = h("div", { class: "ck-list" });
  const bar = h("div", { class: "vf-bar hidden" }, h("span"));
  const status = h("div", { class: "vf-status" });
  const startBtn = h("button", { class: "btn primary", onclick: start });
  const stopBtn = h("button", { class: "btn plain hidden", onclick: () => { run.stopped = true; } }, "Stop");

  const sw = h("button", { class: "switch", role: "switch", "aria-checked": String(!!editor.settings.autoVerify), "aria-label": "Check references automatically" });
  sw.addEventListener("click", () => {
    const v = sw.getAttribute("aria-checked") !== "true";
    sw.setAttribute("aria-checked", String(v));
    setAutoVerify(v);
  });
  const auto = h("div", { class: "setting vf-auto" }, h("div", { class: "lbl" }, "Check automatically",
    h("small", null, "Looks up new and edited references as you write, and shows a badge on each one.")), sw);

  const intro = h("div", { class: "vf-intro" },
    h("p", null, "Looks each reference up in Crossref, DataCite, OpenAlex and arXiv, and tells you if it can't be found, if its DOI belongs to a different paper, or if the paper was retracted or corrected."),
    h("p", { class: "hint" }, "This needs an internet connection and sends each entry's title, first author and DOI to those services. Nothing is sent unless you press the button or turn on automatic checking."));

  const body = h("div", { class: "ck" }, entries.length
    ? h("div", null, intro, auto, h("div", { class: "vf-controls" }, startBtn, stopBtn, status), bar, summaryEl, list)
    : h("div", { class: "fb-empty" }, a.bibliography.files.length ? "Your .bib file has no entries yet." : "This project has no bibliography yet. Add a source with Insert → Citation → Add by DOI."));
  const off = on(["refcheck"], render);
  const d = dialog({
    title: "Check references online", wide: true, body, onClose: () => off(),
    footer: [h("span", { class: "grow" }, "A missing match isn't proof of fraud: books, theses and web pages often aren't indexed. Use it as a prompt to look."),
      h("button", { class: "btn plain", onclick: () => d.close() }, "Close")],
  });

  function plan() {
    const stale = staleEntries();
    const never = entries.every((e) => !resultFor(e));
    if (never) return { label: `Check ${entries.length} reference${entries.length === 1 ? "" : "s"}`, entries };
    if (stale.length) return { label: `Check ${stale.length} new or changed`, entries: stale };
    return { label: "Check all again", entries, again: true };
  }

  async function start() {
    const p = plan();
    if (p.again) entries.forEach((e) => cache.delete(e.key));
    await checkEntries(p.entries);
  }

  function render() {
    const s = summary();
    const stat = (label, value, cls) => h("div", { class: `ck-stat ${cls}` }, h("div", { class: "ck-val" }, value), h("div", { class: "ck-lbl" }, label));
    summaryEl.replaceChildren(...(s.checked ? [stat("problems", s.bad, "bad"), stat("to check", s.warn, "warn"), stat("suggestions", s.info, "info"), stat("verified", s.ok, "ok")] : []));
    bar.classList.toggle("hidden", !run.running);
    bar.firstChild.style.width = `${run.total ? (run.done / run.total) * 100 : 0}%`;
    stopBtn.classList.toggle("hidden", !run.running);
    startBtn.disabled = run.running;
    const p = plan();
    startBtn.replaceChildren(icon(p.again ? "refresh" : "search", "sm"), p.label);
    status.textContent = run.running ? `Checking… ${run.done} of ${run.total}`
      : run.offline ? "No internet connection. Connect and press the button again."
      : run.stopped ? `Stopped after ${run.done} of ${run.total}.` : s.checked ? `${s.checked} of ${s.total} checked.` : "";
    status.classList.toggle("error-text", run.offline && !run.running);

    const rows = entries.map((e) => ({ e, r: resultFor(e) })).filter((x) => x.r)
      .sort((x, y) => RANK[x.r.level] - RANK[y.r.level]);
    const attention = rows.filter((x) => x.r.level !== "ok");
    const verified = rows.filter((x) => x.r.level === "ok");
    list.replaceChildren(...attention.map(row),
      ...(verified.length ? [h("details", { class: "ck-words" }, h("summary", null, `${verified.length} verified`), h("div", { class: "ck-list" }, verified.map(row)))] : []));
  }

  function row({ e, r }) {
    const uncited = !e.cites.length && !a.bibliography.nociteAll;
    const extra = (r.notes || []).slice(1).filter((n) => n.level !== "ok");
    return h("div", { class: `ck-row ${r.level}` },
      h("span", { class: "ck-icon" }, icon(ICON[r.level])),
      h("div", { class: "ck-body" },
        h("div", { class: "ck-title" }, e.title || e.key, " ", h("code", { class: "vf-key" }, e.key),
          uncited ? h("span", { class: "vf-badge" }, "never cited") : null),
        e.short ? h("div", { class: "ck-detail" }, e.short) : null,
        h("div", { class: "ck-detail vf-headline" }, r.headline),
        ...extra.map((n) => h("div", { class: "ck-detail" }, n.text)),
        h("div", { class: "vf-actions" },
          r.suggestDoi && !added.has(e.key) ? h("button", { class: "btn small secondary", onclick: () => addDoi(e, r.suggestDoi) }, icon("plus", "sm"), "Add DOI to the entry") : null,
          h("button", { class: "btn small plain", onclick: () => { d.close(); editor.openFile(e.file, { line: e.line }); } }, "Show in .bib"),
          r.url ? h("a", { class: "btn small plain", href: r.url, target: "_blank", rel: "noopener noreferrer" }, icon("external", "sm"), "Open") : null)));
  }

  async function addDoi(e, doi) {
    const ok = await editor.setBibField(e.file, e.line, e.key, "doi", doi);
    if (!ok) { toast(`Couldn't find ${e.key} in ${e.file}. Add doi = {${doi}} by hand.`, { kind: "error" }); return; }
    added.add(e.key);
    toast(`Added the DOI to ${e.key}.`, { kind: "ok", timeout: 3000 });
    render();
  }

  render();
}
