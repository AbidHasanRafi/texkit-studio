// Tiny shared state: `set()` merges a patch and notifies listeners of the keys that changed.

export const state = {
  session: null,        // /api/session payload
  tree: [],             // file tree
  mainFile: null,
  mainSource: null,     // "chosen" | "main.tex" | "auto": how the main file was picked
  mainCandidates: [],   // every complete document in the folder
  tabs: [],             // [{path, kind, doc, hash, dirty, readOnly, savedGen, gen}]
  active: null,         // active tab path
  compile: { status: "idle", issues: [], rev: 0, hasPdf: false },
  compiling: false,
  engineProgress: null, // {done, total} while the engine downloads
  log: [],              // live compile output lines
  issuesOpen: false,
  layout: "split",      // wide screens: editor | split | pdf
  pane: "editor",       // narrow screens: editor | pdf
  sidebarOpen: false,   // slide-over sidebar on narrower screens
  connected: true,
  analysis: null,       // /api/analysis: labels, refs, cites, bibliography, checks
  focus: false,         // focus mode: just the text
  offline: null,        // {done, total, name} while preparing for offline use
};

/** All problems: compile issues plus reference/citation checks, without double-reporting. */
export function allIssues() {
  const checks = (state.analysis && state.analysis.checks) || [];
  const covered = new Set(checks.filter((c) => c.key).map((c) => c.key));
  const compile = (state.compile.issues || []).filter((i) => {
    // The analyser already explains missing references and citations, with fixes.
    const m = /^(?:Citation|Reference) [`'](.+?)'/.exec(i.raw || "");
    return !(m && covered.has(m[1])) && i.rule !== "undef_refs";
  });
  return [...compile, ...checks];
}

const listeners = new Set();

export function set(patch) {
  Object.assign(state, patch);
  const keys = new Set(Object.keys(patch));
  for (const l of listeners) {
    if (!l.keys || l.keys.some((k) => keys.has(k))) l.fn(state, keys);
  }
}

export function on(keys, fn) {
  const entry = { keys: keys === "*" ? null : [].concat(keys), fn };
  listeners.add(entry);
  return () => listeners.delete(entry);
}
