// Small DOM helpers, the icon sprite, and shared UI pieces (menus, dialogs, toasts).

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const MOD = isMac ? "⌘" : "Ctrl+";
export const kbd = (s) => s.replace("Mod-", MOD).replace("Shift-", isMac ? "⇧" : "Shift+").replace("Alt-", isMac ? "⌥" : "Alt+");

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k === "dataset") Object.assign(el.dataset, v);
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === "html") el.innerHTML = v;
      else if (v === true) el.setAttribute(k, "");
      else el.setAttribute(k, v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function icon(name, cls = "") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", `i ${cls}`.trim());
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

export function setIcon(svg, name) {
  svg.querySelector("use").setAttribute("href", `#i-${name}`);
}

// App logo: a LaTeX document with an orbit and a pen. Colours come from the theme (see .appmark in app.css).
const LOGO = `<svg viewBox="0 0 32 32" aria-hidden="true">
<path class="lg-doc" d="M9.5 3.5H17l6 6V23a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 7 23V6a2.5 2.5 0 0 1 2.5-2.5Z"/>
<path class="lg-fold" d="M17 3.5v4a2 2 0 0 0 2 2h4Z"/>
<path class="lg-ink" d="M10.5 12h6M13.5 12v5M10.5 20.5h5M10.5 23h3"/>
<path class="lg-orbit" d="M5.5 5.5C-.5 11 0 22 9 27.5c3 1.8 6 2.3 9 1.8"/>
<path class="lg-orbit lg-back" d="M26 4.5c2.6 1.6 3.6 4.4 3.2 7.5"/>
<g transform="translate(19.5 25) rotate(-45)"><rect class="lg-pen" x="0" y="-1.6" width="10.5" height="3.2" rx="1"/><path class="lg-nib" d="M0 -1.6L-3.8 0L0 1.6Z"/></g>
</svg>`;

export function logo(size) {
  return h("span", { class: "appmark", "aria-hidden": "true", style: size ? { width: `${size}px`, height: `${size}px` } : null, html: LOGO });
}

export function debounce(fn, ms) {
  let t;
  const wrapped = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

export function store(key, fallback) {
  try { const v = localStorage.getItem(`texkit.${key}`); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
}
export function save(key, value) {
  try { localStorage.setItem(`texkit.${key}`, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

// Lucide-style icons (ISC licence), drawn with strokes.
const PATHS = {
  "chev-r": '<path d="m9 18 6-6-6-6"/>',
  "chev-d": '<path d="m6 9 6 6 6-6"/>',
  "chev-l": '<path d="m15 18-6-6 6-6"/>',
  "arrow-up": '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  download: '<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>',
  upload: '<path d="M12 3v12"/><path d="m17 8-5-5-5 5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8M12 17v4"/>',
  sliders: '<path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4"/>',
  play: '<path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5Z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  "file-text": '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8M16 13H8M16 17H8"/>',
  "file-plus": '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M9 15h6M12 18v-6"/>',
  "file-pdf": '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M8 13h1.5a1.5 1.5 0 0 1 0 3H8v-5M14 11v5h1a2 2 0 0 0 0-4h-1"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  "folder-open": '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
  "folder-plus": '<path d="M12 10v6M9 13h6"/><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  archive: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/>',
  book: '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>',
  plus: '<path d="M5 12h14M12 5v14"/>',
  minus: '<path d="M5 12h14"/>',
  fit: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  err: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
  warn: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  ruler: '<path d="M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0Z"/><path d="m14.5 12.5 2-2M11.5 9.5l2-2M8.5 6.5l2-2M17.5 15.5l2-2"/>',
  bulb: '<path d="M9 18h6M10 22h4"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5M12 7v5l4 2"/>',
  terminal: '<path d="m4 17 6-6-6-6M12 19h8"/>',
  home: '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .71-1.53l7-6a2 2 0 0 1 2.58 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  drive: '<path d="M22 12H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z"/><path d="M6 16h.01M10 16h.01"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  "check-circle": '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  pencil: '<path d="M21.17 6.81a1 1 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z"/>',
  trash: '<path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  star: '<path d="M11.52 2.3a.53.53 0 0 1 .95 0l2.31 4.68a2.12 2.12 0 0 0 1.6 1.16l5.16.76a.53.53 0 0 1 .3.9l-3.74 3.64a2.12 2.12 0 0 0-.61 1.88l.88 5.14a.53.53 0 0 1-.77.56l-4.62-2.43a2.12 2.12 0 0 0-1.97 0L6.4 21.01a.53.53 0 0 1-.77-.56l.88-5.14a2.12 2.12 0 0 0-.61-1.88L2.16 9.8a.53.53 0 0 1 .3-.9l5.16-.76a2.12 2.12 0 0 0 1.6-1.16z"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  external: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  sparkle: '<path d="M9.94 14.06 2 22M12 2l1.8 5.2L19 9l-5.2 1.8L12 16l-1.8-5.2L5 9l5.2-1.8z"/>',
  word: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="m8 12 1.5 6 2.5-4.5 2.5 4.5 1.5-6"/>',
  panel: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/><path d="M22 12h-4M6 12H2M12 6V2M12 22v-4"/>',
  table: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/>',
  sigma: '<path d="M18 7V5a1 1 0 0 0-1-1H6.5a.5.5 0 0 0-.4.8l4.5 6a2 2 0 0 1 0 2.4l-4.5 6a.5.5 0 0 0 .4.8H17a1 1 0 0 0 1-1v-2"/>',
  hash: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  quote: '<path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/><path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/>',
  omega: '<path d="M3 20h4.5a.5.5 0 0 0 .5-.5v-.28a.5.5 0 0 0-.25-.43A8 8 0 1 1 16.25 18.8a.5.5 0 0 0-.25.43v.28a.5.5 0 0 0 .5.5H21"/>',
  checklist: '<rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="m9 14 2 2 4-4"/>',
  focus: '<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>',
  command: '<path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"/>',
  keyboard: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10"/>',
  cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
  restore: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  wand: '<path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72"/><path d="m14 7 3 3M5 6v4M19 14v4M10 2v2M7 8H3M21 16h-4M11 3H9"/>',
};

export function injectSprite() {
  const symbols = Object.entries(PATHS)
    .map(([id, d]) => `<symbol id="i-${id}" viewBox="0 0 24 24">${d}</symbol>`).join("");
  const holder = h("div", { "aria-hidden": "true", style: { position: "absolute", width: "0", height: "0", overflow: "hidden" } });
  holder.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg">${symbols}</svg>`;
  document.body.prepend(holder);
}

// ── Menus ────────────────────────────────────────────────────────────────
let openMenu = null;

export function closeMenu() {
  if (openMenu) { openMenu.close(); openMenu = null; }
}

/**
 * items: [{label, sub, icon, kbd, checked, danger, disabled, onSelect}] | "sep" | {heading}
 */
export function showMenu(anchor, items, { align = "start", sheetOnPhone = true } = {}) {
  closeMenu();
  const el = h("div", { class: "menu", role: "menu" });
  const buttons = [];
  for (const it of items) {
    if (!it) continue;
    if (it === "sep") { el.append(h("div", { class: "menu-sep", role: "separator" })); continue; }
    if (it.heading) { el.append(h("div", { class: "menu-head" }, it.heading)); continue; }
    const btn = h("button", {
      class: `menu-item${it.danger ? " danger" : ""}`, role: it.checked == null ? "menuitem" : "menuitemcheckbox",
      "aria-checked": it.checked == null ? null : String(!!it.checked), disabled: it.disabled, title: it.title,
      onclick: () => { closeMenu(); it.onSelect && it.onSelect(); },
    },
      it.checked != null ? h("span", { class: "check" }, it.checked ? icon("check", "sm") : null) : (it.icon ? icon(it.icon) : null),
      h("span", { class: "text" }, h("span", { class: "label" }, it.label), it.sub ? h("span", { class: "sub" }, it.sub) : null),
      it.kbd ? h("kbd", null, kbd(it.kbd)) : null,
    );
    buttons.push(btn);
    el.append(btn);
  }
  document.body.append(el);

  const phone = sheetOnPhone && window.matchMedia("(max-width: 639px)").matches;
  if (phone) {
    el.classList.add("sheet");
  } else {
    const r = anchor.getBoundingClientRect();
    const mw = el.offsetWidth, mh = el.offsetHeight;
    let left = align === "end" ? r.right - mw : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - mw - 8));
    let top = r.bottom + 6;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }
  anchor.setAttribute("aria-expanded", "true");

  let index = -1;
  const focus = (i) => { index = (i + buttons.length) % buttons.length; buttons[index]?.focus(); };
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); closeMenu(); anchor.focus(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); focus(index + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); focus(index - 1); }
    else if (e.key === "Tab") closeMenu();
  };
  const onDown = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) closeMenu(); };
  document.addEventListener("keydown", onKey, true);
  setTimeout(() => document.addEventListener("pointerdown", onDown, true));
  window.addEventListener("resize", closeMenu, { once: true });

  openMenu = {
    anchor,
    close() {
      el.remove();
      anchor.setAttribute("aria-expanded", "false");
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown, true);
    },
  };
  if (buttons.length) requestAnimationFrame(() => { if (document.activeElement === document.body || anchor.contains(document.activeElement)) focus(0); });
  return openMenu;
}

export function toggleMenu(anchor, itemsFn, opts) {
  if (openMenu && openMenu.anchor === anchor) { closeMenu(); return; }
  showMenu(anchor, itemsFn(), opts);
}

// ── Dialogs ──────────────────────────────────────────────────────────────
export function dialog({ title, body, footer, wide = false, onClose }) {
  const prevFocus = document.activeElement;
  const closeBtn = h("button", { class: "icon-btn", "aria-label": "Close", onclick: () => close() }, icon("x"));
  const box = h("div", { class: `dialog${wide ? " wide" : ""}`, role: "dialog", "aria-modal": "true", "aria-label": title },
    h("div", { class: "dialog-head" }, h("h2", null, title), closeBtn),
    h("div", { class: "dialog-body" }, body),
    footer ? h("div", { class: "dialog-foot" }, footer) : null,
  );
  const overlay = h("div", { class: "overlay", onmousedown: (e) => { if (e.target === overlay) close(); } }, box);
  const onKey = (e) => {
    if (e.key === "Escape") { e.stopPropagation(); close(); }
    if (e.key === "Tab") {
      const f = [...box.querySelectorAll("button, input, select, textarea, [tabindex]")].filter((n) => !n.disabled && n.offsetParent);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    }
  };
  document.addEventListener("keydown", onKey, true);
  document.body.append(overlay);
  let closed = false;
  function close(result) {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
    prevFocus && prevFocus.focus && prevFocus.focus();
    onClose && onClose(result);
  }
  requestAnimationFrame(() => (box.querySelector("[autofocus]") || box.querySelector("input, .btn.primary") || closeBtn).focus());
  return { el: box, close };
}

export function promptDialog({ title, label, value = "", okLabel = "OK", hint, validate }) {
  return new Promise((resolve) => {
    const input = h("input", { type: "text", value, autofocus: true, spellcheck: "false" });
    const err = h("div", { class: "error-text" });
    const ok = h("button", { class: "btn primary", onclick: submit }, okLabel);
    const d = dialog({
      title,
      body: h("div", { class: "field" }, label ? h("label", null, label) : null, input, hint ? h("div", { class: "hint" }, hint) : null, err),
      footer: [h("span", { class: "grow" }), h("button", { class: "btn plain", onclick: () => d.close(null) }, "Cancel"), ok],
      onClose: (r) => resolve(r ?? null),
    });
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.isComposing) return;
      // Closing hands focus back to the button that opened this dialog; without this, the same Enter would press it again.
      e.preventDefault();
      submit();
    });
    requestAnimationFrame(() => {
      input.focus();
      const dot = value.lastIndexOf(".");
      input.setSelectionRange(0, dot > 0 ? dot : value.length);
    });
    function submit() {
      const v = input.value.trim();
      const problem = validate ? validate(v) : (!v ? "Please enter a name." : null);
      if (problem) { err.textContent = problem; return; }
      d.close(v);
    }
  });
}

export function confirmDialog({ title, message, okLabel = "OK", danger = false }) {
  return new Promise((resolve) => {
    const d = dialog({
      title,
      body: h("p", null, message),
      footer: [h("span", { class: "grow" }),
        h("button", { class: "btn plain", onclick: () => d.close(false) }, "Cancel"),
        h("button", { class: `btn ${danger ? "danger" : "primary"}`, onclick: () => d.close(true) }, okLabel)],
      onClose: (r) => resolve(!!r),
    });
  });
}

// ── Toasts ───────────────────────────────────────────────────────────────
let toastHost;
export function toast(message, { kind = "info", actions = [], timeout = 4500 } = {}) {
  if (!toastHost) { toastHost = h("div", { class: "toasts", role: "status", "aria-live": "polite" }); document.body.append(toastHost); }
  const kindIcon = { error: "err", ok: "check-circle", info: "info" }[kind] || "info";
  const el = h("div", { class: `toast glass ${kind}` },
    icon(kindIcon, "kind"),
    h("div", { class: "msg" }, message),
    actions.length ? h("div", { class: "acts" }, actions.map((a) => h("button", { class: "btn small secondary", onclick: () => { remove(); a.onClick(); } }, a.label))) : null,
    h("button", { class: "icon-btn sm", "aria-label": "Dismiss", onclick: () => remove() }, icon("x", "sm")),
  );
  toastHost.append(el);
  let timer = timeout ? setTimeout(remove, timeout) : null;
  el.addEventListener("mouseenter", () => clearTimeout(timer));
  el.addEventListener("mouseleave", () => { if (timeout) timer = setTimeout(remove, 2000); });
  function remove() { clearTimeout(timer); el.remove(); }
  return remove;
}
