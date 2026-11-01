// Version history: automatic snapshots (taken after each successful compile), with
// a side-by-side look at what changed and one-click restore of any file.

import { api } from "./api.js";
import { h, icon, dialog, toast, confirmDialog } from "./dom.js";
import { state } from "./store.js";

function ago(t) {
  const s = Math.round(Date.now() / 1000 - t);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export async function historyDialog({ onRestored } = {}) {
  let snaps;
  try { snaps = (await api.history()).snapshots; } catch (e) { toast(e.message, { kind: "error" }); return; }
  const list = h("div", { class: "hs-list", role: "listbox", "aria-label": "Snapshots" });
  const files = h("div", { class: "hs-files" });
  const view = h("div", { class: "hs-diff" });
  const restoreBtn = h("button", { class: "btn primary", disabled: true }, icon("restore", "sm"), "Restore this version");
  let current = null, currentFile = null;

  const d = dialog({
    title: "Version history",
    wide: true,
    body: snaps.length
      ? h("div", { class: "hs" }, list, h("div", { class: "hs-main" }, files, view))
      : h("div", { class: "empty-card", style: { margin: "24px auto" } },
        h("div", { class: "big-icon" }, icon("history", "lg")), h("h2", null, "No snapshots yet"),
        h("p", null, "A snapshot of your text files is saved automatically each time the document compiles successfully. Nothing to do: it just happens.")),
    footer: [h("span", { class: "grow" }, "Snapshots are kept on this computer, outside your project folder."),
      h("button", { class: "btn plain", onclick: () => d.close() }, "Close"), snaps.length ? restoreBtn : null],
  });
  d.el.querySelector(".dialog-body").style.padding = "0";

  function renderList() {
    list.replaceChildren(...snaps.map((s) => h("button", {
      class: `hs-item${current && current.id === s.id ? " active" : ""}`, role: "option", onclick: () => select(s),
    },
      h("span", { class: "hs-when" }, ago(s.time)),
      h("span", { class: "hs-what" }, s.reason === "before restore" ? "Before a restore" : s.reason === "manual" ? "Saved by you" : `${s.changed.length} file${s.changed.length === 1 ? "" : "s"} changed`),
    )));
  }

  async function select(s) {
    current = s;
    renderList();
    const changed = s.changed.length ? s.changed : [state.active || state.mainFile].filter(Boolean);
    currentFile = changed.includes(currentFile) ? currentFile : (changed.includes(state.active) ? state.active : changed[0]);
    files.replaceChildren(...changed.map((p) => h("button", { class: `chip`, "aria-pressed": String(p === currentFile), onclick: () => { currentFile = p; select(s); } }, p)));
    await showDiff();
  }

  async function showDiff() {
    if (!current || !currentFile) { view.replaceChildren(h("div", { class: "fb-empty" }, "Pick a snapshot.")); return; }
    view.replaceChildren(h("div", { class: "fb-empty" }, "Loading…"));
    let diff;
    try { diff = await api.historyDiff(current.id, currentFile); } catch (e) { view.replaceChildren(h("div", { class: "fb-empty" }, e.message)); return; }
    restoreBtn.disabled = !diff.existsThen || diff.same;
    restoreBtn.onclick = () => restore(diff);
    if (!diff.existsThen) { view.replaceChildren(h("div", { class: "fb-empty" }, `${currentFile} didn't exist in this snapshot.`)); return; }
    if (diff.same) { view.replaceChildren(h("div", { class: "fb-empty" }, `${currentFile} is the same now as in this snapshot.`)); return; }
    view.replaceChildren(h("div", { class: "hs-legend" }, h("span", { class: "del" }, "− in this snapshot"), h("span", { class: "add" }, "+ now")),
      h("pre", { class: "hs-rows" }, diff.rows.map((r) => h("div", { class: `hs-row ${{ "-": "del", "+": "add", "…": "gap", "=": "" }[r.t]}` },
        h("span", { class: "hs-mark" }, r.t === "=" ? " " : r.t), r.text || " "))));
  }

  async function restore(diff) {
    const ok = await confirmDialog({
      title: `Restore ${diff.path}?`,
      message: "The file goes back to how it was in this snapshot. Your current version is saved as a snapshot first, so you can undo this from here.",
      okLabel: "Restore",
    });
    if (!ok) return;
    try {
      await api.restore(current.id, diff.path);
      d.close();
      toast(`Restored ${diff.path}.`, { kind: "ok" });
      onRestored && onRestored(diff.path);
    } catch (e) { toast(e.message, { kind: "error" }); }
  }

  if (snaps.length) { renderList(); select(snaps[0]); }
}
