// PDF preview built on PDF.js: lazy page rendering, zoom, and scroll kept across recompiles.

import * as pdfjs from "../vendor/pdfjs/build/pdf.min.mjs";
import { h, icon, store, save } from "./dom.js";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdfjs/build/pdf.worker.min.mjs", import.meta.url).href;

const GAP = 20;
const MIN_SCALE = 0.25, MAX_SCALE = 4;

export function initPdf(pane, { onCompile, onInverse }) {
  const banner = h("div", { class: "pdf-banner glass hidden", role: "status" });
  const scroll = h("div", { class: "pdf-scroll", tabindex: "0", "aria-label": "PDF pages" });
  const empty = h("div", { class: "pdf-empty" });
  const zoomVal = h("button", { class: "val", title: "Fit to width" }, "100%");
  const pageVal = h("span", { class: "pages" }, "– / –");
  const capsule = h("div", { class: "capsule glass hidden", role: "toolbar", "aria-label": "PDF controls" },
    h("button", { class: "icon-btn", title: "Zoom out", "aria-label": "Zoom out", onclick: () => zoomBy(1 / 1.15) }, icon("minus", "sm")),
    zoomVal,
    h("button", { class: "icon-btn", title: "Zoom in", "aria-label": "Zoom in", onclick: () => zoomBy(1.15) }, icon("plus", "sm")),
    h("span", { class: "vsep" }),
    h("button", { class: "icon-btn", title: "Fit whole page", "aria-label": "Fit whole page", onclick: () => setZoom("page") }, icon("fit", "sm")),
    h("span", { class: "vsep" }),
    pageVal,
  );
  zoomVal.addEventListener("click", () => setZoom("fit"));
  pane.append(banner, scroll, empty, capsule);

  let doc = null, sizes = [], pages = [], scale = 1, loadSeq = 0;
  let zoom = store("pdfZoom", "fit");

  function fitScale() {
    if (!sizes.length) return 1;
    const maxW = Math.max(...sizes.map((s) => s.w));
    const pad = parseFloat(getComputedStyle(scroll).paddingLeft) * 2 || 48;
    const width = Math.max(120, scroll.clientWidth - pad);
    if (zoom === "page") {
      const maxH = Math.max(...sizes.map((s) => s.h));
      return Math.min(width / maxW, (scroll.clientHeight - 40) / maxH);
    }
    return width / maxW;
  }

  function anchor() {
    const top = scroll.scrollTop;
    for (let i = 0; i < pages.length; i++) {
      const el = pages[i].el;
      if (el.offsetTop + el.offsetHeight + GAP / 2 > top) {
        return { index: i, frac: Math.max(0, (top - el.offsetTop) / el.offsetHeight) };
      }
    }
    return { index: 0, frac: 0 };
  }

  function restore(a) {
    const p = pages[Math.min(a.index, pages.length - 1)];
    if (p) scroll.scrollTop = p.el.offsetTop + a.frac * p.el.offsetHeight;
  }

  function layout() {
    scale = typeof zoom === "number" ? zoom : fitScale();
    zoomVal.textContent = `${Math.round(scale * 100)}%`;
    pages.forEach((p, i) => {
      p.el.style.width = `${Math.floor(sizes[i].w * scale)}px`;
      p.el.style.height = `${Math.floor(sizes[i].h * scale)}px`;
    });
  }

  const currentKey = () => `${loadSeq}:${scale.toFixed(4)}`;

  async function renderPage(i) {
    const p = pages[i];
    const key = currentKey();
    if (!p || p.rendered === key || p.pending === key) return;
    p.pending = key;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const vp = sizes[i].page.getViewport({ scale: scale * dpr });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    try {
      p.task = sizes[i].page.render({ canvasContext: canvas.getContext("2d"), viewport: vp });
      await p.task.promise;
    } catch {
      if (p.pending === key) p.pending = null;
      return;
    }
    if (p.pending !== key || key !== currentKey()) return;  // zoom or document changed meanwhile
    p.el.querySelector("canvas")?.remove();
    p.el.prepend(canvas);  // swap only when ready: no blank flash (and keep any highlight on top)
    p.rendered = key;
    p.pending = null;
  }

  function renderVisible() {
    if (!pages.length) return;
    const top = scroll.scrollTop - scroll.clientHeight;
    const bottom = scroll.scrollTop + scroll.clientHeight * 2;
    const order = [];
    pages.forEach((p, i) => {
      const t = p.el.offsetTop, b = t + p.el.offsetHeight;
      if (b >= top && t <= bottom) order.push(i);
    });
    order.forEach((i) => renderPage(i));
    const a = anchor();
    pageVal.textContent = `${Math.min(a.index + (a.frac > 0.6 ? 2 : 1), pages.length)} / ${pages.length}`;
  }

  let rafPending = false, fadeTimer;
  scroll.addEventListener("scroll", () => {
    capsule.classList.add("faded");
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => capsule.classList.remove("faded"), 700);
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; renderVisible(); });
  }, { passive: true });

  // Double-click a spot in the PDF to jump to its source line (SyncTeX).
  scroll.addEventListener("dblclick", (e) => {
    const pageEl = e.target.closest(".pdf-page");
    if (!pageEl || !onInverse) return;
    const index = pages.findIndex((p) => p.el === pageEl);
    const r = pageEl.getBoundingClientRect();
    window.getSelection()?.removeAllRanges();
    onInverse(index + 1, +((e.clientX - r.left) / scale).toFixed(2), +((e.clientY - r.top) / scale).toFixed(2));
  });

  scroll.addEventListener("wheel", (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 1.08 : 1 / 1.08);
  }, { passive: false });

  let resizeTimer;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!pages.length || typeof zoom === "number") return renderVisible();
      const a = anchor();
      layout();
      restore(a);
      renderVisible();
    }, 80);
  }).observe(scroll);

  function setZoom(z) {
    const a = anchor();
    zoom = z;
    save("pdfZoom", typeof z === "number" ? z : z);
    layout();
    restore(a);
    renderVisible();
  }

  function zoomBy(f) {
    setZoom(Math.min(MAX_SCALE, Math.max(MIN_SCALE, +(scale * f).toFixed(3))));
  }

  async function load(url) {
    const seq = ++loadSeq;
    let next;
    try {
      next = await pdfjs.getDocument({ url, isEvalSupported: false }).promise;
    } catch (e) {
      console.error(e);
      return false;
    }
    if (seq !== loadSeq) { next.destroy(); return false; }
    const nextSizes = await Promise.all(Array.from({ length: next.numPages }, async (_, i) => {
      const page = await next.getPage(i + 1);
      const vp = page.getViewport({ scale: 1 });
      return { page, w: vp.width, h: vp.height };
    }));
    if (seq !== loadSeq) { next.destroy(); return false; }

    const a = pages.length ? anchor() : { index: 0, frac: 0 };
    const old = doc;
    doc = next;
    sizes = nextSizes;
    // Reuse page boxes so old canvases stay visible until the new ones are drawn.
    while (pages.length > sizes.length) pages.pop().el.remove();
    while (pages.length < sizes.length) {
      const el = h("div", { class: "pdf-page" });
      scroll.append(el);
      pages.push({ el });
    }
    pages.forEach((p) => { p.rendered = null; p.pending = null; });
    empty.classList.add("hidden");
    capsule.classList.remove("hidden");
    layout();
    restore(a);
    renderVisible();
    if (old) setTimeout(() => old.destroy(), 2000);
    return true;
  }

  function showEmpty({ message = "Your PDF will appear here.", action = true } = {}) {
    loadSeq++;
    pages.forEach((p) => p.el.remove());
    pages = [];
    sizes = [];
    if (doc) { doc.destroy(); doc = null; }
    capsule.classList.add("hidden");
    empty.classList.remove("hidden");
    empty.replaceChildren(h("div", { class: "inner" },
      icon("file-pdf", "lg"),
      h("div", null, message),
      action ? h("button", { class: "btn primary", onclick: onCompile }, icon("play", "fill"), "Compile") : null,
    ));
  }

  function setBanner(text) {
    banner.classList.toggle("hidden", !text);
    if (text) banner.replaceChildren(icon("history", "sm"), h("b", null, text));
  }

  /** Scroll to and flash the given rectangles (PDF points, top-left origin) on a 1-based page. */
  function highlight({ page, rects }) {
    const p = pages[page - 1];
    if (!p || !rects || !rects.length) return;
    p.el.querySelectorAll(".pdf-hl").forEach((n) => n.remove());
    const top = Math.min(...rects.map((r) => r.y));
    scroll.scrollTo({ top: Math.max(0, p.el.offsetTop + top * scale - scroll.clientHeight / 3), behavior: "smooth" });
    for (const r of rects) {
      const box = h("div", { class: "pdf-hl", style: {
        left: `${r.x * scale - 3}px`, top: `${r.y * scale - 2}px`, width: `${r.w * scale + 6}px`, height: `${r.h * scale + 4}px`,
      } });
      p.el.append(box);
      setTimeout(() => box.remove(), 2600);
    }
  }

  const pageCount = () => pages.length;

  return { load, showEmpty, setBanner, highlight, pageCount, refresh: () => { layout(); renderVisible(); } };
}
