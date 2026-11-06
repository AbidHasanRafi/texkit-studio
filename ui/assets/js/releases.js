// Release notes: the one place the site reads them from (landing page, releases page).
// To add a release: put a new object FIRST in the list, set `latest: true` on it only, then run
//   python scripts/site_release_files.py dist
// to add its files and checksums. Text values may contain HTML (<b>, <code>).
window.TEXKIT_RELEASES = [
  {
    version: "0.1.2",
    date: "2026-11-06",
    latest: true,
    title: "Reference verification and US/UK spelling",
    feed: [
      "Reference verification with Crossref, DataCite, OpenAlex and arXiv",
      "A References button and a badge on every reference",
      "Suggested DOIs, added with one click",
      "US / UK spelling consistency, with a setting",
      "Set as main file, in any sub-folder",
      "A package cache in the platform wheels, for offline compiles",
      "A full TeX installation is used when a document needs one",
      "Fixes: false “not saved” notice, Windows save error",
    ],
    summary:
      "Check that every reference is real, catch mixed American and British spelling, choose which file is the main one, " +
      "and compile common documents with no internet at all.",
    highlights: [
      {
        icon: "circle-check",
        title: "Reference verification",
        text: "Every entry is looked up in Crossref, DataCite, OpenAlex and arXiv. Invented DOIs, DOIs that belong to another paper, retractions and missing DOIs are flagged, with a badge on each reference.",
        image: "reference-check",
        doc: "docs.html#reference-check",
      },
      {
        icon: "type",
        title: "US / UK spelling consistency",
        text: "Mixed spellings are underlined and fixed in one click. Choose Auto, US, UK or Off under Settings → Spelling.",
        image: "spelling",
        doc: "docs.html#spelling",
      },
      {
        icon: "star",
        title: "Set as main file",
        text: "In a folder with several .tex files, pick the one to compile from the ⋯ menu, including files in sub-folders. The main badge now says how it was chosen.",
        image: "main-file",
        doc: "docs.html#main-file",
      },
      {
        icon: "package",
        title: "Offline out of the box",
        text: "The platform wheels now carry the engine and a package cache, so ordinary documents compile with no internet on the first run.",
        doc: "docs.html#offline",
      },
    ],
    added: [
      "<b>Check references online.</b> Flags a DOI that doesn't exist or belongs to a different paper, a title found nowhere (a possibly invented reference), wrong authors or year, retractions, expressions of concern and corrections. It runs only when you press the button.",
      "<b>A References button in the header</b> shows a red count for problems, or a green tick when everything is verified, and each entry in the References panel gets a badge: Verified, Retracted, Wrong DOI, DOI not found, No DOI, Not found.",
      "<b>Suggested DOIs.</b> For an entry with no DOI, the check finds one and adds it to the entry with one click.",
      "<b>Check references automatically</b> (in the dialog or Settings) looks up new and edited entries as you write, and nothing else.",
      "<b>Spelling consistency.</b> Mixing American and British spelling (“color” with “behaviour”, “analyse” in an American text) is underlined, fixed in one click, shown under a Language filter in the issues panel and summarised in the Submission check.",
      "<b>Settings → Spelling:</b> Auto, US, UK or Off. Auto follows <code>\\usepackage[british]{babel}</code> (or <code>american</code>), or whichever variant you use most. Add <code>% nospell</code> to a line to skip it, or <code>% texkit-spelling: british</code> anywhere to set the language.",
      "<b>Set as main file</b> from the ⋯ menu (or a right-click) on any .tex file, in any sub-folder. It recompiles at once, and warns if the file is a chapter rather than a complete document.",
      "<b>A package cache in the platform wheels</b> (about 32 MB zipped, 89 MB unpacked): the common classes at 10, 11 and 12pt, about 190 popular packages, the standard fonts, BibTeX styles and the main babel languages. <code>texkit doctor</code> has a new Packages row.",
      "<b>A full TeX installation is used when a document needs one.</b> If TeX Live, MiKTeX, MacTeX or TinyTeX is installed, documents with an index or glossary, biblatex with Biber, <code>minted</code>, packages newer than the built-in LaTeX or fonts by name are built with it automatically.",
      "<b>Journal templates compile as they do on Overleaf.</b> pdfTeX-only commands are accepted, <code>[pdftex]</code> and <code>[dvips]</code> driver options become <code>[xetex]</code>, biblatex switches from Biber to BibTeX, and Unicode text prints correctly with the usual 8-bit fonts.",
      "<b>EPS images.</b> TexKit Studio uses <code>name-eps-converted-to.pdf</code> when it sits next to the image, or converts the image with Ghostscript if that is installed. With neither, the compile still succeeds and the issues panel says which one is missing.",
      "<b>The issues panel names what a document needs</b> and what is missing, when the built-in engine can't build it.",
    ],
    improved: [
      "<b>Compile feedback.</b> The preview panel shows a spinner and a progress bar while a compile runs, and the Compile button ignores repeat clicks until it finishes.",
      "<b>The window title</b> now reads <code>folder | TexKit Studio</code>, and the browser tab icon is the same logo as the header.",
      "<b>The toolbar</b> no longer lets the status pill run into the view switcher on mid-width windows: only References keeps its label there.",
      "<b>Platform wheels are larger</b> (43 to 55 MB, up from 11 to 23 MB) because they now carry the package cache.",
    ],
    fixed: [
      "A false “not saved” notice while typing: the editor treated its own save as a change made by someone else.",
      "On Windows, saving could fail with “Access is denied” while the engine had the file open during an auto-compile. Saves now wait briefly and retry, then write in place, instead of losing what you typed.",
    ],
    upgrade: [
      "Upgrade with <code>pipx upgrade texkit-studio</code> or <code>pip install -U texkit-studio</code>.",
      "The first compile after upgrading unpacks the bundled package cache, which takes a few seconds, once. It is a separate cache from the one a plain Tectonic uses, so anything you had downloaded outside the bundle is fetched again the first time a document needs it.",
      "Tested on Windows and Linux. The macOS wheels are built the same way but haven't been tried yet.",
      "The reference check sends each entry's title, first author and DOI to Crossref, DataCite, OpenAlex and arXiv, and only when you ask it to.",
    ],
  },
  {
    version: "0.1.1",
    date: "2026-11-01",
    latest: false,
    title: "The writing studio",
    feed: [
      "The studio in your browser: files, editor and live PDF",
      "The Tectonic engine is included in the platform wheels",
      "Compile on demand or as you type, with no limits",
      "Problems explained in plain English, with one-click fixes",
      "A References panel for figures, tables and sources",
      "Submission check and PDF, Word, ZIP and submission-package downloads",
    ],
    summary:
      "An editor, a live PDF preview, problems explained in plain English and a submission check, all running on your own computer.",
    highlights: [
      {
        icon: "infinity",
        title: "Unlimited compiles",
        text: "No time limit, no page limit, no queue. Auto-compile follows your typing, and the engine ships inside the platform wheels.",
        doc: "docs.html#compile",
      },
      {
        icon: "circle-check",
        title: "Every figure, table and source connected",
        text: "A References panel tracks every figure, table, equation and bibliography entry, and flags the ones you never mention or cite.",
        doc: "docs.html#figures-tables-citations",
      },
      {
        icon: "clipboard-check",
        title: "Submission check",
        text: "One list of what is left before you send it: errors, margins, unreferenced figures, uncited sources, and the page, word and abstract counts.",
        doc: "docs.html#submission-check",
      },
      {
        icon: "lock",
        title: "Private by design",
        text: "Your files stay ordinary files in your own folder. The server listens on 127.0.0.1 only and nothing is uploaded.",
        doc: "docs.html#privacy",
      },
    ],
    added: [
      "<b>A studio in your browser.</b> Run <code>texkit</code> in a folder: files on the left, the editor in the middle, the PDF on the right.",
      "<b>The Tectonic engine is included</b> in the platform wheels, so there is no TeX installation. LaTeX packages are fetched the first time a document uses them and cached; <code>texkit prepare-offline</code> downloads the ones the templates use ahead of time.",
      "<b>Compile</b> with the button or <code>Ctrl/⌘ + Enter</code>, or automatically a moment after you stop typing.",
      "<b>Problems in plain English.</b> Errors and warnings link to the exact line, and common mistakes get a one-click fix.",
      "<b>Jump between source and PDF</b> by double-clicking the PDF or pressing <code>Ctrl/⌘ + Shift + J</code>.",
      "<b>The References panel</b> lists every figure, table, equation and bibliography entry, flags a <code>\\ref</code> or <code>\\cite</code> that points nowhere, and inserts references and citations from pickers. Add a source by DOI or arXiv ID.",
      "<b>Writing tools:</b> drag in or paste images, build tables in a grid or paste them from Excel, symbols, a command palette, search across all files, an outline and focus mode.",
      "<b>Version history.</b> A snapshot of your text files after every successful compile; compare and restore.",
      "<b>Downloads:</b> PDF, Word (<code>.docx</code>), the whole project as a ZIP, or a submission package with one flattened <code>.tex</code>, its <code>.bbl</code> and only the images it uses.",
      "<b>Templates:</b> Starter tour, Blank article, IEEE conference, Elsevier and Thesis. Import a ZIP, for example an Overleaf download.",
      "<b>Format document,</b> like Prettier, in the editor and as <code>texkit format</code> (with <code>--check</code> for CI).",
    ],
    improved: [],
    fixed: [],
    upgrade: [
      "Install with <code>pipx install texkit-studio</code> or <code>pip install texkit-studio</code>.",
      "Documents can't run programs (shell-escape is off), and deleting a file moves it to the Recycle Bin or Trash.",
    ],
  },
];
