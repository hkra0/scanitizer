# 🔪 scanitizer

A scanned PDF cleanup tool, which removes metadata, watermarks and so on. (๑- . -๑)

Everything runs in the browser — no build step, no bundler, no upload.

Notes:

- For scanned PDF with OCR text, the text is dropped by default; the output
  screen offers `[t]` to keep it. See [Keeping the text layer](#keeping-the-text-layer).
- For non-scanned PDF, only metadata is removed.
- Paper size, orientation, page margin and image compression are adjustable
  under `[s]` on the start screen. See [Settings](#settings).
- A file can be dropped anywhere on the page instead of picked.
- An encrypted PDF asks for its password on a screen of its own, in the
  terminal, with the answer maskable and revealable. The password is handed
  straight to pdf.js and kept nowhere else.
- `[esc]` abandons a run in progress. A run that ends badly — or is abandoned —
  goes back to the start screen with the reason printed on it and the file still
  selected, so `[s]` is a retry under different settings rather than a re-pick.
- Every option is a real focus stop: `Tab` reaches them, `Enter`/`Space`
  activate them, and the arrow-key cursor moves the same focus a screen reader
  follows.

## Project structure

```
index.html          markup + CDN <script> tags, nothing else
css/
  base.css          design tokens, reset, page layout
  terminal.css      the faux-terminal window and its line styles
js/
  app.js            entry point: app state, flow, wiring
  config.js         tunables (timings, and the defaults settings.js starts on)
  settings.js       the user-adjustable options, persisted in localStorage
  vendor.js         the CDN globals (pdf.js, pdf-lib, JSZip) in one place
  i18n.js           UI strings + language detection
  theme.js          colour-scheme-dependent tinyko tool
  logo.js           half-block bitmap wordmark
  tinyko.js         tinyko, the mascot, drawn through a pixel filter
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

## Settings

`[s]` on the start screen folds open a panel of page and compression options.
Every row is a list of values stepped with `←`/`→`, so a plain on/off option is
just a two-value list and works exactly like the rest — including the text-layer
option on the output screen.

| setting | values | default |
| --- | --- | --- |
| paper size | a4, letter, legal, a3, a5, fit image | a4 |
| orientation | auto, portrait, landscape | auto |
| page margin | 0–40 pt | 20 pt |
| jpeg quality | 50–95% | 70% |
| max page pixels | 1754–3508 px on the long edge | 2732 px |

Each default is what the app did before there were settings, so an untouched
install is unchanged. `auto` turns the sheet to match the image, which is what
keeps a portrait scan on a portrait page; `fit image` drops the fixed sheet
entirely and cuts the page to the image's own proportions, so nothing is padded
out with white.

Choices are stored in `localStorage` and read while a file is being processed,
so they can't be acted on retroactively — by the time the output screen is up,
the page images have already been encoded at the quality and size that were set.
Acting on a change therefore means running the file again, which is what `[s]`
on the output screen does: it discards the result and returns to the start
screen with the panel already open.

## Keeping the text layer

Rebuilding a scan as fresh page images is what drops watermarks — and it drops
the OCR text along with them. Turning `[t]` on at the output screen puts that
text back, so the result stays selectable and searchable. Unlike the settings
above it takes effect immediately: the page images are already encoded, so the
PDF is simply rebuilt around them.

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

Nothing about this is language-conditional: no font is fetched for any
document, so an all-English scan and a Chinese one make exactly the same
network requests — the three CDN libraries and the pdf.js worker, and that is
all. There is no script that can be "missing a font", because no glyph is ever
drawn. A document can use at most 65534 distinct characters, which no real page
of text approaches.

Right-to-left text needs one extra step. pdf.js resolves bidi before handing
text back, so Arabic or Hebrew arrives in *visual* order; storing that verbatim
would reverse it, since whatever reads the output applies bidi a second time.
`extract.js` undoes the reversal so exactly one pass happens overall. The
inverse is matched to how pdf.js orders text rather than derived from the bidi
algorithm — pdf.js splits runs by glyph spacing, so a mixed-script run, or an
unusual layout that makes it segment differently, can still come out with words
in the wrong order.

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
