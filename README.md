# 🔪 scanitizer

A scanned PDF cleanup tool, which removes metadata, watermarks and so on. (๑- . -๑)

Everything runs in the browser — no build step, no bundler, no upload.

Notes:

- For scanned PDF with OCR text, the text is not reserved.
- For non-scanned PDF, only metadata is removed.

## Project structure

```
index.html          markup + CDN <script> tags, nothing else
css/
  base.css          design tokens, reset, page layout
  terminal.css      the faux-terminal window and its line styles
js/
  app.js            entry point: app state, flow, wiring
  config.js         tunables (timings, pixel budgets, page geometry)
  vendor.js         the CDN globals (pdf.js, pdf-lib, JSZip) in one place
  i18n.js           UI strings + language detection
  theme.js          colour-scheme-dependent mascot tool
  logo.js           half-block bitmap wordmark
  terminal.js       all DOM writes: lines, spinner, progress, warnings, menu
  screens.js        what the terminal shows at each stage
  keyboard.js       keyboard shortcuts and option navigation
  images.js         image files -> page images
  download.js       saving PDFs, loose images and zips
  pdf/
    extract.js      pull the page-sized scan image out of each PDF page
    build.js        assemble page images into a clean PDF
```

The layering is one-way: `app.js` orchestrates, `screens.js` describes screens,
`terminal.js` owns the DOM, and the `pdf/`, `images` and `download` modules are
pure processing that report progress through callbacks — they never touch the
UI directly.

## Local development

`js/` uses native ES modules, so the page must be served over HTTP — opening
`index.html` straight from the filesystem will not work. Any static server does:

```bash
python3 -m http.server 4173
```
