// HTTP API wrappers and the live event stream.

const enc = encodeURIComponent;

async function call(method, url, body) {
  const opts = { method, headers: {}, credentials: "same-origin" };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const isJson = (res.headers.get("content-type") || "").includes("json");
  const data = isJson ? await res.json().catch(() => ({})) : null;
  if (!res.ok) {
    const err = new Error((data && data.detail) || res.statusText || "Request failed");
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// The spelling preference lives in the editor settings (localStorage). Read it here so every
// analysis request carries it without each caller having to pass it along.
function spellingQuery() {
  try {
    const v = JSON.parse(localStorage.getItem("texkit.settings") || "{}").spelling;
    return v && v !== "auto" ? `?spelling=${enc(v)}` : "";
  } catch { return ""; }
}

export const api = {
  session: () => call("GET", "/api/session"),
  setRoot: (path) => call("POST", "/api/session/root", { path }),
  browse: (path) => call("GET", `/api/fs/browse${path ? `?path=${enc(path)}` : ""}`),
  shortcuts: () => call("GET", "/api/fs/shortcuts"),
  mkdir: (parent, name) => call("POST", "/api/fs/mkdir", { parent, name }),
  reveal: (path) => call("POST", "/api/system/reveal", { path }),
  tree: () => call("GET", "/api/tree"),
  read: (path) => call("GET", `/api/file?path=${enc(path)}`),
  write: (path, content, baseHash, force = false) => call("PUT", "/api/file", { path, content, baseHash, force }),
  create: (path, type = "file") => call("POST", "/api/file/create", { path, type }),
  move: (from, to) => call("POST", "/api/file/move", { from, to }),
  remove: (path) => call("POST", "/api/file/delete", { path }),
  upload: (dir, files) => {
    const fd = new FormData();
    fd.append("dir", dir || "");
    for (const f of files) fd.append("files", f, f.name);
    return call("POST", "/api/file/upload", fd);
  },
  setMain: (path) => call("POST", "/api/project/main", { path }),
  templates: () => call("GET", "/api/templates"),
  applyTemplate: (body) => call("POST", "/api/templates/apply", body),
  compile: (active, clean = false) => call("POST", "/api/compile", { active, clean }),
  cancel: () => call("POST", "/api/compile/cancel", {}),
  log: () => call("GET", "/api/log"),
  rawUrl: (path) => `/api/raw?path=${enc(path)}&t=${Date.now()}`,
  analysis: () => call("GET", `/api/analysis${spellingQuery()}`),
  check: () => call("GET", `/api/check${spellingQuery()}`),
  lookupCitation: (id) => call("POST", "/api/citations/lookup", { id }),
  verifyCitation: (e) => call("POST", "/api/citations/verify", {
    key: e.key, type: e.type || "", title: e.title || "", author: e.author || "", year: e.year || "",
    doi: e.doi || "", url: e.url || "", eprint: e.eprint || "",
  }),
  addCitation: (bibtex, file) => call("POST", "/api/citations/add", { bibtex, file }),
  syncForward: (file, line) => call("GET", `/api/synctex/forward?file=${enc(file)}&line=${line}`),
  syncInverse: (page, x, y) => call("GET", `/api/synctex/inverse?page=${page}&x=${x}&y=${y}`),
  history: () => call("GET", "/api/history"),
  historyDiff: (id, path) => call("GET", `/api/history/diff?id=${enc(id)}&path=${enc(path)}`),
  restore: (id, path) => call("POST", "/api/history/restore", { id, path }),
  snapshot: () => call("POST", "/api/history/snapshot", {}),
  search: (q, { regex = false, kase = false, whole = false } = {}) =>
    call("GET", `/api/search?q=${enc(q)}&regex=${regex}&case=${kase}&whole=${whole}`),
  importZip: (file, parent) => {
    const fd = new FormData();
    fd.append("file", file, file.name);
    fd.append("parent", parent);
    return call("POST", "/api/import", fd);
  },
  prepareOffline: () => call("POST", "/api/system/prepare-offline", {}),
  format: (path, content, { indent = 2, alignTables = true } = {}) =>
    call("POST", "/api/format", { path, content, indent, alignTables }),
};

/** Download an export (pdf | docx | zip) as a file, surfacing server errors as exceptions. */
export async function download(kind) {
  const res = await fetch(`/api/export/${kind}`, { credentials: "same-origin" });
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch { /* not JSON */ }
    throw new Error(detail);
  }
  const blob = await res.blob();
  const cd = res.headers.get("content-disposition") || "";
  const m = /filename\*=utf-8''([^;]+)|filename="?([^";]+)"?/i.exec(cd);
  const name = m ? decodeURIComponent(m[1] || m[2]) : `document.${kind}`;
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return name;
}

/** Live server events with automatic reconnect. */
export function connect(onMessage, onStatus) {
  let retry = 500;
  function open() {
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/events`);
    ws.onopen = () => { retry = 500; onStatus(true); };
    ws.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch (err) { console.error(err); } };
    ws.onclose = () => { onStatus(false); setTimeout(open, retry); retry = Math.min(retry * 2, 8000); };
  }
  open();
}
