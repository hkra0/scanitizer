# 🔪 scanitizer

A scanned PDF cleanup tool, which removes metadata, watermarks and so on. (๑- . -๑)

Everything runs in the browser — no build step, no bundler, no upload.

Notes:

- For scanned PDF with OCR text, the text is dropped by default; the output
  screen offers `[t]` to keep it. See [Keeping the text layer](#keeping-the-text-layer).
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
    matrix.js       2D affine matrix helpers shared by extract and textlayer
    extract.js      pull the page-sized scan image out of each PDF page
    textlayer.js    re-draw the source text, invisibly, over the page images
    build.js        assemble page images into a clean PDF
```

The layering is one-way: `app.js` orchestrates, `screens.js` describes screens,
`terminal.js` owns the DOM, and the `pdf/`, `images` and `download` modules are
pure processing that report progress through callbacks — they never touch the
UI directly.

## Keeping the text layer

Rebuilding a scan as fresh page images is what drops watermarks — and it drops
the OCR text along with them. Turning `[t]` on at the output screen puts that
text back, so the result stays selectable and searchable.

How it survives the re-layout: the extractor records each text item in the
coordinate space of the page image's *unit square* rather than in page
coordinates, so a run sitting halfway across the scan is remembered as being
halfway across it. Composing that with the matrix the image ends up being drawn
at reproduces the original placement at whatever size, rotation or flip the new
layout gave the image.

Every run is drawn in text rendering mode 3 — invisible. No glyph is ever
rasterized, so the PDF needs a font *object* but not a font *program*: what
makes text extractable is the ToUnicode CMap, not the outlines. So the text
layer synthesizes a non-embedded Identity-H composite font and builds the CMap
as it goes. CJK and every other script cost a few hundred bytes, instead of the
multi-megabyte font an embedded approach would need. A typical page's text
layer, font and CMap included, adds well under 1 KB.

**The recovered text is not sanitized.** It is copied verbatim from the source,
so a text watermark comes along with it — invisible in the output, but still
extractable. Telling an OCR layer apart from page furniture needs the text
rendering mode of the source runs, which pdf.js's text API doesn't expose. That
is why the option is off by default and labelled in the UI. If what you need is
a guarantee that nothing hidden survives, leave it off.

## Local development

`js/` uses native ES modules, so the page must be served over HTTP — opening
`index.html` straight from the filesystem will not work. Any static server does:

```bash
python3 -m http.server 4173
```
