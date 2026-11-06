/* TexKit Studio documentation site: shared behaviour. Plain JavaScript, no build step.
   - theme (light / dark, remembered), header and footer, copy buttons, install tabs
   - docs page: scroll-spy and search in the sidebar
   - releases page and "latest updates": rendered from assets/js/releases.js and release-files.js */
(() => {
  "use strict";
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const page = document.body.dataset.page || "";
  const RELEASES = window.TEXKIT_RELEASES || [];
  const FILES = window.TEXKIT_FILES || {};
  const latest = RELEASES.find((r) => r.latest) || RELEASES[0];
  const REPO = "https://github.com/AbidHasanRafi/texkit-studio";
  const PYPI = "https://pypi.org/project/texkit-studio/";

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // ── Icons (Lucide, ISC licence) ───────────────────────────────────────
  const ICONS = {
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
    moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    "chevron-right": '<path d="m9 18 6-6-6-6"/>',
    "arrow-right": '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
    "circle-check": '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
    type: '<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>',
    star: '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>',
    package: '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
    lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    infinity: '<path d="M12 12c-2-2.67-4-4-6-4a4 4 0 1 0 0 8c2 0 4-1.33 6-4Zm0 0c2 2.67 4 4 6 4a4 4 0 0 0 0-8c-2 0-4 1.33-6 4Z"/>',
    "clipboard-check": '<rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="m9 14 2 2 4-4"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    download: '<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
    alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4M12 17h.01"/>',
    folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  };
  const icon = (name, cls = "h-5 w-5") =>
    `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;
  const GITHUB = '<svg class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2.17c-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z"/></svg>';
  const LOGO = `<span class="appmark block" aria-hidden="true"><svg viewBox="0 0 32 32">
<path class="lg-doc" d="M9.5 3.5H17l6 6V23a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 7 23V6a2.5 2.5 0 0 1 2.5-2.5Z"/>
<path class="lg-fold" d="M17 3.5v4a2 2 0 0 0 2 2h4Z"/>
<path class="lg-ink" d="M10.5 12h6M13.5 12v5M10.5 20.5h5M10.5 23h3"/>
<path class="lg-orbit" d="M5.5 5.5C-.5 11 0 22 9 27.5c3 1.8 6 2.3 9 1.8"/>
<path class="lg-orbit lg-back" d="M26 4.5c2.6 1.6 3.6 4.4 3.2 7.5"/>
<g transform="translate(19.5 25) rotate(-45)"><rect class="lg-pen" x="0" y="-1.6" width="10.5" height="3.2" rx="1"/><path class="lg-nib" d="M0 -1.6L-3.8 0L0 1.6Z"/></g>
</svg></span>`;
  window.TexKitSite = { icon, LOGO };

  // Static icons written in the HTML as <i data-icon="name" class="…"></i>.
  const paintIcons = (root = document) => $$("[data-icon]", root).forEach((el) => {
    el.outerHTML = icon(el.dataset.icon, el.className || "h-5 w-5");
  });

  // ── Theme ─────────────────────────────────────────────────────────────
  const KEY = "texkit-site-theme";
  const systemDark = matchMedia("(prefers-color-scheme: dark)");
  const stored = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const applyTheme = (t) => { document.documentElement.dataset.theme = t; };
  applyTheme(stored() || (systemDark.matches ? "dark" : "light"));
  systemDark.addEventListener("change", (e) => { if (!stored()) applyTheme(e.matches ? "dark" : "light"); });
  const toggleTheme = () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(next);
    try { localStorage.setItem(KEY, next); } catch { /* storage unavailable */ }
    syncThemeButton();
  };
  const syncThemeButton = () => {
    const dark = document.documentElement.dataset.theme === "dark";
    $$("[data-theme-toggle]").forEach((b) => {
      b.innerHTML = icon(dark ? "sun" : "moon", "h-[18px] w-[18px]");
      b.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
      b.title = b.getAttribute("aria-label");
    });
  };

  // ── Header and footer ─────────────────────────────────────────────────
  const navLink = (href, label, key) =>
    `<a href="${href}" ${page === key ? 'aria-current="page"' : ""} class="rounded-full px-3 py-1 text-[.88rem] font-medium text-muted transition hover:text-ink aria-[current=page]:text-ink">${label}</a>`;

  const header = $("#site-header");
  if (header) {
    header.outerHTML = `
<header class="sticky top-0 z-40 border-b-[.5px] border-line bg-(--material-chrome) backdrop-blur-2xl backdrop-saturate-150">
  <div class="mx-auto flex h-12 max-w-6xl items-center gap-2 px-5">
    <a href="index.html" class="mr-3 flex items-center gap-2.5 font-semibold tracking-tight text-ink" aria-label="TexKit Studio home">
      <span class="h-7 w-7">${LOGO}</span><span class="text-[1.02rem]">TexKit Studio</span>
    </a>
    <nav class="hidden items-center gap-1 sm:flex" aria-label="Main">
      ${navLink("docs.html", "Docs", "docs")}
      ${navLink("releases.html", "Releases", "releases")}
    </nav>
    <div class="ml-auto flex items-center gap-1.5">
      ${latest ? `<a href="releases.html#${latest.version}" class="hidden items-center gap-1.5 rounded-full bg-accent-soft px-3 py-1 text-[.8rem] font-semibold text-accent transition hover:opacity-80 sm:inline-flex" title="Latest release">v${latest.version}<span class="rounded-full bg-accent px-1.5 text-[.65rem] font-bold uppercase tracking-wide text-surface">Latest</span></a>` : ""}
      <a href="${REPO}" class="grid h-9 w-9 place-items-center rounded-lg text-muted transition hover:bg-hover hover:text-ink" aria-label="TexKit Studio on GitHub" title="GitHub">${GITHUB}</a>
      <button type="button" data-theme-toggle class="grid h-9 w-9 place-items-center rounded-lg text-muted transition hover:bg-hover hover:text-ink"></button>
      <a href="docs.html#install" class="ml-1 hidden rounded-full bg-btn px-4 py-1 text-[.85rem] font-medium text-white transition hover:bg-btn-hover sm:inline-block">Install</a>
      <button type="button" id="nav-menu" class="grid h-9 w-9 place-items-center rounded-lg text-muted transition hover:bg-hover hover:text-ink sm:hidden" aria-label="Menu" aria-expanded="false">${icon("menu")}</button>
    </div>
  </div>
  <nav id="nav-mobile" class="hidden border-t-[.5px] border-line px-5 py-2 sm:hidden" aria-label="Main (mobile)">
    <a href="docs.html" class="block rounded-lg px-3 py-2 font-medium">Docs</a>
    <a href="releases.html" class="block rounded-lg px-3 py-2 font-medium">Releases</a>
    <a href="docs.html#install" class="block rounded-lg px-3 py-2 font-medium">Install</a>
  </nav>
</header>`;
    $("#nav-menu").addEventListener("click", (e) => {
      const open = $("#nav-mobile").classList.toggle("hidden") === false;
      e.currentTarget.setAttribute("aria-expanded", String(open));
    });
  }

  const footer = $("#site-footer");
  if (footer) {
    const col = (title, links) => `<div><h4 class="mb-3 text-[.72rem] font-semibold uppercase tracking-[.08em] text-faint">${title}</h4><ul class="space-y-2 text-[.93rem]">${links
      .map(([h, l]) => `<li><a class="text-muted transition hover:text-ink" href="${h}">${l}</a></li>`).join("")}</ul></div>`;
    footer.outerHTML = `
<footer class="${page === "home" ? "" : "mt-24 "}border-t-[.5px] border-line bg-surface">
  <div class="mx-auto grid max-w-6xl gap-10 px-5 py-14 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
    <div>
      <a href="index.html" class="flex items-center gap-2.5 font-semibold tracking-tight"><span class="h-7 w-7">${LOGO}</span>TexKit Studio</a>
      <p class="mt-4 max-w-xs text-[.93rem] leading-relaxed text-muted">Write papers freely. Compile without limits. An open-source LaTeX studio that runs on your own computer.</p>
    </div>
    ${col("Learn", [["docs.html#install", "Install"], ["docs.html#quick-start", "Quick start"], ["docs.html#reference-check", "Reference check"], ["docs.html#spelling", "Spelling"]])}
    ${col("Project", [["releases.html", "Releases"], [REPO, "GitHub"], [PYPI, "PyPI"], [REPO + "/issues", "Report an issue"]])}
    ${col("More", [["docs.html#commands", "Commands"], ["docs.html#privacy", "Privacy and safety"], ["docs.html#troubleshooting", "Troubleshooting"], [REPO + "/blob/main/LICENSE", "MIT licence"]])}
  </div>
  <div class="border-t-[.5px] border-line">
    <div class="mx-auto flex max-w-6xl flex-col gap-2 px-5 py-5 text-[.85rem] text-faint sm:flex-row sm:items-center sm:justify-between">
      <span>© 2026 Md. Abid Hasan Rafi. Released under the MIT licence.</span>
      <span>Your files stay on your computer.</span>
    </div>
  </div>
</footer>`;
  }
  paintIcons();
  syncThemeButton();
  document.addEventListener("click", (e) => { if (e.target.closest("[data-theme-toggle]")) toggleTheme(); });

  // Reveal the page once Tailwind has drawn it (it generates its CSS just after load).
  const reveal = () => requestAnimationFrame(() => requestAnimationFrame(() => document.documentElement.classList.add("tw-ready")));
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", reveal); else reveal();
  setTimeout(() => document.documentElement.classList.add("tw-ready"), 1500);

  // ── Reveal on scroll ─────────────────────────────────────────────────
  // Elements marked .reveal fade up as they enter the screen. The class that hides them is added here, so without
  // JavaScript (or with reduced motion, see motion.css) everything is simply visible.
  const revealOnScroll = () => {
    const items = $$(".reveal:not(.is-in)");
    if (!items.length) return;
    if (!("IntersectionObserver" in window)) { items.forEach((el) => el.classList.add("is-in")); return; }
    const io = new IntersectionObserver((entries) => entries.forEach((e) => {
      if (e.isIntersecting) { e.target.classList.add("is-in"); io.unobserve(e.target); }
    }), { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
    items.forEach((el) => io.observe(el));
  };
  document.documentElement.classList.add("js-reveal");
  window.addEventListener("load", () => setTimeout(revealOnScroll, 50));
  setTimeout(revealOnScroll, 900);

  // ── Copy buttons and install tabs ─────────────────────────────────────
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-copy]");
    if (btn) {
      const text = btn.dataset.copy || $(btn.dataset.copyTarget)?.textContent || "";
      try { await navigator.clipboard.writeText(text.trim()); } catch {
        const ta = Object.assign(document.createElement("textarea"), { value: text.trim() });
        document.body.append(ta); ta.select(); document.execCommand("copy"); ta.remove();
      }
      const was = btn.innerHTML;
      btn.dataset.done = "true"; btn.innerHTML = icon("check", "h-4 w-4") + (btn.dataset.label ? `<span>Copied</span>` : "");
      setTimeout(() => { btn.dataset.done = "false"; btn.innerHTML = was; }, 1400);
    }
    const tab = e.target.closest("[data-install-tab]");
    if (tab) {
      const group = tab.closest("[data-install]");
      $$("[data-install-tab]", group).forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
      $("[data-install-cmd]", group).textContent = tab.dataset.installTab;
      $("[data-install-copy]", group).dataset.copy = tab.dataset.installTab;
    }
  });
  $$("[data-install]").forEach((g) => $("[data-install-tab]", g)?.click());

  // ── Lightbox: click a screenshot to see it full size ──────────────────
  document.addEventListener("click", (e) => {
    const img = e.target.closest(".frame img");
    if (!img || e.target.closest("#lightbox")) return;
    const lb = document.createElement("div");
    lb.id = "lightbox";
    lb.setAttribute("role", "dialog"); lb.setAttribute("aria-modal", "true"); lb.setAttribute("aria-label", img.alt || "Screenshot");
    lb.innerHTML = `<img src="${img.currentSrc || img.src}" alt="${esc(img.alt)}"><button type="button" aria-label="Close">&times;</button>`;
    const close = () => { lb.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (ev) => { if (ev.key === "Escape") close(); };
    lb.addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    document.body.append(lb);
  });

  // ── Release helpers ───────────────────────────────────────────────────
  const fmtDate = (iso) => new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const fmtSize = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + " MB" : Math.round(n / 1e3) + " KB");
  const platform = (name) => {
    if (name.endsWith(".tar.gz")) return ["Source", "Build it yourself"];
    if (name.includes("win_amd64")) return ["Windows", "x86-64"];
    if (name.includes("macosx_11_0_arm64")) return ["macOS", "Apple silicon"];
    if (name.includes("macosx_10_15_x86_64")) return ["macOS", "Intel"];
    if (name.includes("x86_64")) return ["Linux", "x86-64"];
    if (name.includes("aarch64")) return ["Linux", "ARM64"];
    if (name.endsWith("-any.whl")) return ["Any platform", "Downloads the engine on first compile"];
    return ["Other", ""];
  };
  const headings = (r) => r.feed || r.added.map((h) => (h.match(/<b>(.*?)<\/b>/) || [, h])[1].replace(/[.:]$/, ""));

  // ── Landing page: latest updates ──────────────────────────────────────
  const feed = $("#updates-feed");
  if (feed) {
    feed.innerHTML = RELEASES.map((r, i) => `
<article class="relative grid gap-4 sm:grid-cols-[9rem_1fr] sm:gap-8">
  <div class="sm:pt-1">
    <div class="flex items-center gap-2"><span class="text-lg font-bold tracking-tight">v${r.version}</span>${r.latest ? '<span class="badge info">Latest</span>' : ""}</div>
    <div class="mt-0.5 text-[.85rem] text-faint">${fmtDate(r.date)}</div>
  </div>
  <div class="reveal rounded-3xl bg-window p-7" style="--d:${i * 0.08}s">
    <h3 class="text-xl font-semibold tracking-tight">${esc(r.title)}</h3>
    <ul class="mt-4 grid gap-x-8 gap-y-2.5 text-[.95rem] sm:grid-cols-2">
      ${headings(r).slice(0, 4).map((h) => `<li class="flex gap-2.5"><span class="mt-[.55rem] h-1.5 w-1.5 flex-none rounded-full bg-accent"></span><span>${h}</span></li>`).join("")}
    </ul>
    <a href="releases.html#${r.version}" class="mt-6 inline-flex items-center gap-1 text-[.95rem] font-medium text-accent hover:underline">Read the ${r.version} release notes ${icon("chevron-right", "h-4 w-4")}</a>
  </div>
</article>`).join("");
  }
  $$("[data-latest-version]").forEach((el) => { el.textContent = latest.version; });
  $$("[data-latest-link]").forEach((el) => { el.href = `releases.html#${latest.version}`; });

  // ── Releases page ─────────────────────────────────────────────────────
  const detail = $("#release-detail");
  if (detail) {
    const rail = $("#release-rail");
    const list = (items, cls) => `<ul class="notes ${cls}">${items.map((t) => `<li>${t}</li>`).join("")}</ul>`;
    const section = (id, title, body, badge) => `
<section id="${id}" class="mt-12">
  <h2 class="mb-4 flex items-center gap-2.5 text-xl font-bold tracking-tight">${title}${badge ? `<span class="badge ${badge[0]}">${badge[1]}</span>` : ""}</h2>
  <div class="rounded-2xl border-[.5px] border-line bg-surface px-6 py-3 shadow-card notes-box">${body}</div>
</section>`;

    const render = () => {
      const want = decodeURIComponent(location.hash.slice(1));
      const r = RELEASES.find((x) => x.version === want) || (want === "latest" ? latest : null) || latest;
      document.title = `${r.version}${r.latest ? " (latest)" : ""} · Releases · TexKit Studio`;
      rail.innerHTML = RELEASES.map((x) => `
<a href="#${x.version}" ${x.version === r.version ? 'aria-current="true"' : ""} class="group block min-w-44 rounded-xl border-[.5px] border-transparent px-4 py-3 transition hover:bg-hover aria-[current=true]:border-line aria-[current=true]:bg-surface aria-[current=true]:shadow-card">
  <div class="flex items-center gap-2"><span class="font-semibold">v${x.version}</span>${x.latest ? '<span class="badge info">Latest</span>' : ""}</div>
  <div class="mt-0.5 text-[.82rem] text-faint">${fmtDate(x.date)}</div>
  <div class="mt-1 hidden text-[.85rem] leading-snug text-muted lg:block">${esc(x.title)}</div>
</a>`).join("");

      const files = FILES[r.version] || [];
      const cmd = r.latest ? "pipx upgrade texkit-studio" : `pip install texkit-studio==${r.version}`;
      detail.innerHTML = `
<header>
  <div class="flex flex-wrap items-center gap-3">
    ${r.latest ? '<span class="badge info">Latest release</span>' : '<span class="badge plain">Earlier release</span>'}
    <span class="text-[.9rem] text-faint">${fmtDate(r.date)}</span>
  </div>
  <h1 class="mt-3 text-4xl font-bold tracking-tight sm:text-5xl">TexKit Studio ${r.version}</h1>
  <p class="mt-2 text-xl font-medium tracking-tight">${esc(r.title)}</p>
  <p class="mt-3 max-w-2xl text-[1.05rem] leading-relaxed text-muted">${esc(r.summary)}</p>
  <div class="mt-6 flex flex-wrap items-center gap-3">
    <div class="flex items-center gap-2 rounded-xl border-[.5px] border-line bg-surface py-1.5 pl-4 pr-1.5 shadow-card">
      <code class="font-mono text-[.9rem]" id="rel-cmd">${r.latest ? "pip install -U texkit-studio" : cmd}</code>
      <button type="button" class="copy-btn grid h-8 w-8 place-items-center rounded-lg text-muted transition hover:bg-hover hover:text-ink" data-copy="${r.latest ? "pip install -U texkit-studio" : cmd}" aria-label="Copy the command">${icon("copy", "h-4 w-4")}</button>
    </div>
    <a href="${PYPI}" class="inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-[.93rem] font-semibold text-accent hover:bg-hover">PyPI ${icon("external", "h-4 w-4")}</a>
  </div>
</header>

<div class="mt-10 grid gap-4 sm:grid-cols-2">
  ${r.highlights.map((h) => `
  <article class="flex flex-col overflow-hidden rounded-2xl border-[.5px] border-line bg-surface shadow-card">
    ${h.image ? `<div class="border-b-[.5px] border-line bg-window"><div class="h-44 overflow-hidden">
      <img class="only-light w-full object-cover object-top" src="assets/img/${h.image}.webp" alt="" loading="lazy">
      <img class="only-dark w-full object-cover object-top" src="assets/img/${h.image}-dark.webp" alt="" loading="lazy"></div></div>` : ""}
    <div class="flex flex-1 flex-col p-5">
      <div class="mb-3 grid h-9 w-9 place-items-center rounded-lg bg-accent-soft text-accent">${icon(h.icon, "h-5 w-5")}</div>
      <h3 class="font-semibold tracking-tight">${esc(h.title)}</h3>
      <p class="mt-1.5 flex-1 text-[.93rem] leading-relaxed text-muted">${esc(h.text)}</p>
      ${h.doc ? `<a href="${h.doc}" class="mt-3 inline-flex items-center gap-1 text-[.9rem] font-medium text-accent hover:underline">Read the docs ${icon("chevron-right", "h-4 w-4")}</a>` : ""}
    </div>
  </article>`).join("")}
</div>

${section("added", "What's new", list(r.added, "added"), ["info", r.added.length + " changes"])}
${r.improved.length ? section("improved", "Improved", list(r.improved, "changed")) : ""}
${r.fixed.length ? section("fixed", "Fixed", list(r.fixed, "is-fixed")) : ""}
${section("upgrade", r.latest ? "Upgrading" : "Installing", list(r.upgrade, "added"))}

<section id="downloads" class="mt-12">
  <h2 class="mb-1 text-xl font-bold tracking-tight">Files</h2>
  <p class="mb-4 text-[.93rem] text-muted">pip picks the right file for your computer automatically. The checksums are for checking a download by hand.</p>
  <div class="overflow-x-auto rounded-2xl border-[.5px] border-line bg-surface shadow-card">
    <table class="w-full text-left text-[.9rem]">
      <thead><tr class="border-b-[.5px] border-line text-[.74rem] uppercase tracking-wide text-faint">
        <th class="px-5 py-3 font-semibold">Platform</th><th class="px-5 py-3 font-semibold">File</th><th class="px-5 py-3 font-semibold">Size</th><th class="px-5 py-3 font-semibold">SHA-256</th></tr></thead>
      <tbody>
      ${files.length ? files.map((f) => { const [p, sub] = platform(f.name); return `
        <tr class="border-b-[.5px] border-line last:border-0 align-top">
          <td class="px-5 py-3.5"><div class="font-semibold">${p}</div><div class="text-[.8rem] text-faint">${sub}</div></td>
          <td class="px-5 py-3.5"><code class="break-all font-mono text-[.78rem] text-muted">${esc(f.name)}</code></td>
          <td class="whitespace-nowrap px-5 py-3.5 text-muted">${fmtSize(f.size)}</td>
          <td class="px-5 py-3.5"><div class="flex items-center gap-1.5"><code class="font-mono text-[.78rem] text-muted" title="${f.sha256}">${f.sha256.slice(0, 16)}…</code>
            <button type="button" class="copy-btn grid h-7 w-7 place-items-center rounded-md text-faint transition hover:bg-hover hover:text-ink" data-copy="${f.sha256}" aria-label="Copy the SHA-256 of ${esc(f.name)}">${icon("copy", "h-3.5 w-3.5")}</button></div></td>
        </tr>`; }).join("") : '<tr><td class="px-5 py-6 text-muted" colspan="4">No file list for this release.</td></tr>'}
      </tbody>
    </table>
  </div>
</section>`;
      // Jump to a section inside the release when the link asks for one (releases.html#0.1.2/fixed).
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", render);
    render();
  }

  // ── Docs page: scroll-spy, mobile menu, search ────────────────────────
  const nav = $("#docs-nav");
  if (nav) {
    const links = $$("a.side-link", nav);
    const sections = links.map((a) => document.getElementById(a.getAttribute("href").slice(1))).filter(Boolean);
    const setCurrent = (id) => links.forEach((a) => a.setAttribute("aria-current", String(a.getAttribute("href") === "#" + id)));
    const spy = new IntersectionObserver((entries) => {
      const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (visible) setCurrent(visible.target.id);
    }, { rootMargin: "-90px 0px -65% 0px" });
    sections.forEach((s) => spy.observe(s));
    if (location.hash) setCurrent(location.hash.slice(1));
    links.forEach((a) => a.addEventListener("click", () => { if (innerWidth < 1024) $("#docs-nav-panel").classList.add("hidden"); }));
    $("#docs-menu")?.addEventListener("click", () => $("#docs-nav-panel").classList.toggle("hidden"));

    const text = new Map(sections.map((s) => [s.id, s.textContent.toLowerCase()]));
    const input = $("#docs-search");
    const none = $("#docs-search-none");
    input?.addEventListener("input", () => {
      const q = input.value.trim().toLowerCase();
      let any = false;
      links.forEach((a) => {
        const id = a.getAttribute("href").slice(1);
        const hit = !q || a.textContent.toLowerCase().includes(q) || (text.get(id) || "").includes(q);
        a.classList.toggle("hidden", !hit);
        any ||= hit;
      });
      $$(".side-group", nav).forEach((g) => {
        let el = g.nextElementSibling, shown = false;
        while (el && !el.classList.contains("side-group")) { if (el.matches("a.side-link") && !el.classList.contains("hidden")) shown = true; el = el.nextElementSibling; }
        g.classList.toggle("hidden", !shown);
      });
      none.classList.toggle("hidden", any);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "/" && !/input|textarea/i.test(document.activeElement.tagName)) { e.preventDefault(); input?.focus(); }
    });
  }
})();
