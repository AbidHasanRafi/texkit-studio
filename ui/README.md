# TexKit Studio documentation site

A static site: plain HTML, one stylesheet, a little JavaScript, and Tailwind CSS. No Node.js, no `npm`, no build step.
It uses the same design tokens as the app (`src/texkit_studio/static/css/tokens.css`): the Inkwell teal, the same greys,
light and dark themes, solid colours only.

| File | What it is |
|---|---|
| `index.html` | Landing page: hero, features, latest updates, install steps |
| `docs.html` | The documentation: searchable sidebar, one section per topic |
| `releases.html` | Release notes. `releases.html#0.1.2` opens a version; no hash opens the latest |
| `assets/css/site.css` | Design tokens, the logo colours and the typography of the documentation text |
| `assets/js/site.js` | Theme, header and footer, copy buttons, docs search, and the releases view |
| `assets/js/releases.js` | **The release notes.** Edit this to add a release |
| `assets/js/release-files.js` | File names, sizes and SHA-256 checksums. Generated, do not edit |
| `assets/img/` | Real screenshots of the app, in light and dark (`*-dark.webp`) |
| `assets/fonts/` | Figtree (text), Source Serif 4 (headings) and JetBrains Mono (code), self-hosted variable fonts (SIL Open Font Licence, licences alongside). Nothing is loaded from a CDN |
| `assets/vendor/tailwind-browser.js` | Tailwind CSS 4's in-browser build (MIT, see `tailwind-LICENSE.txt`) |

## Preview

```bash
python -m http.server 8000 --directory ui
```

Then open <http://localhost:8000>. (Opening the files straight from disk also works.)

## Publish a new release

1. Build the release (`python scripts/build_wheels.py --seed dist-seed/tectonic-seed.zip`).
2. Add the version's notes to the **top** of the list in `assets/js/releases.js`, and set `latest: true` on it only.
   The landing page, the "Latest" badge in the header and `releases.html` all read from that file.
3. Record the checksums: `python scripts/site_release_files.py dist`.
4. Preview, then deploy the `ui/` folder to any static host (GitHub Pages, Netlify, an S3 bucket).

## Screenshots

The screenshots are taken from the real app on a demo project, so they stay honest. Light and dark pairs share a name:
`reference-check.webp` and `reference-check-dark.webp`. The `*-crop` files are tighter crops used on the landing page.

## Why Tailwind runs in the browser

Tailwind's browser build generates the CSS from the classes in the page when it loads, so the repository stays pure
Python with nothing to compile. For a very high-traffic site you could replace it with Tailwind's standalone CLI
(a single binary, still no Node.js) to produce a static stylesheet.
