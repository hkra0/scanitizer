# 🔪 scanitizer

A scanned PDF cleanup tool, which removes metadata, watermarks and so on. (๑- . -๑)

Everything runs in the browser — no build step, no bundler, no upload.

Notes:

- For scanned PDF with OCR text, the text is dropped by default; `keep original
  text layer` under `[s]` puts it back. See
  [Keeping the text layer](#keeping-the-text-layer).
- For non-scanned PDF, only metadata is removed.
- A file is processed one page first, not all of it: the sample screen shows
  page 1 on the sheet it will land on, with the settings under it and an
  estimate of what the whole file will weigh. `[enter]` runs the rest. See
  [The sample screen](#the-sample-screen).
- The output screen shows the first page and an account of the run — size
  before and after, and which metadata fields the source was carrying. See
  [The output screen](#the-output-screen).
- Paper size, orientation, page margin and image compression are adjustable on
  the sample screen, and under `[s]` on the start screen. See
  [Settings](#settings).
- A file can be dropped anywhere on the page instead of picked.
- An encrypted PDF asks for its password on a screen of its own, in the
  terminal, with the answer maskable and revealable. The password is handed
  straight to pdf.js and kept nowhere else.
- A run past its first couple of pages prints a time estimate beside the
  percentage. A page count says how far along a run is; how long is left is what
  "should I cancel this" actually turns on.
- `[esc]` abandons a run in progress. A run that ends badly — or is abandoned —
  goes back to the start screen with the reason printed on it and the file still
  open, so `[enter]` returns to the sample screen without re-reading the file or
  asking for its password again.
  Nothing on screen expires on a timer: if the app has something to say about a
  run, it says it on a screen and leaves it there.
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
  dragdrop.js       dropping a file anywhere on the window
  sampleScheduler.js  one sample pass in flight, one queued, the rest discarded
  images.js         image files -> page images
  download.js       saving PDFs, loose images and zips
  pdf/
    matrix.js       2D affine matrix helpers shared by extract and textlayer
    extract.js      pull the page-sized scan image out of each PDF page
    textlayer.js    re-draw the source text, invisibly, over the page images
    build.js        assemble page images into a clean PDF
test/
  matrix.test.mjs      the affine helpers, as the properties their callers rely on
  geometry.test.mjs    page geometry: what the sample screen and the builder share
  page-image.test.mjs  which image on a page is the scan of it
  browser-globals.mjs  the few globals the pure modules touch on the way in
```

The layering is one-way: `app.js` orchestrates, `screens.js` describes screens,
`terminal.js` owns the DOM, and the `pdf/`, `images` and `download` modules are
pure processing that report progress through callbacks — they never touch the
UI directly.

## Settings

`[s]` on the start screen folds open a panel of page and compression options.
Every row is a list of values stepped with `←`/`→`, so a plain on/off option is
just a two-value list and works exactly like the rest — including the text-layer
option, which is why it lives here rather than being a switch of its own.

The `‹` and `›` around a value are targets, not decoration: clicking or tapping
one steps that way, and clicking the row steps forward. That last one used to be
the only pointer gesture there was, which meant a value could only ever be
cycled all the way round — on a touch screen, with no arrow keys to fall back
on, there was no way back at all.

| setting | values | default |
| --- | --- | --- |
| keep original text layer | off, on | off |
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
on the output screen does: it discards the result and goes back to the sample
screen, where the change can be seen before it is paid for.

## The sample screen

Picking a file does not start the run. It processes page 1 and stops:

```
> scan.pdf

  ┌────────┐ ┌─────────────────────┐
  │        │ │                     │   left:  the page on its sheet
  │      ▭ │ │   the page at 100%  │   right: the middle of it, at 100%
  │        │ │                     │
  └────────┘ └─────────────────────┘
  page 1 as the settings below make it · right, the page at 100%
  estimated  ≈ 12.4 MB  (30 × 424 KB)

settings:
    ...

> [enter] process all 30 pages
```

The settings decide something lossy, and until they have been applied to an
actual page there is nothing to decide it on. Answering that after the run is
answering it too late: a `70%` that turned out too harsh costs a whole re-run to
correct, and the re-run costs another one to check. Here it costs a page.

Four things make it worth the extra keypress rather than merely honest:

- **the estimate.** Page 1's encoded size times the page count. It is the number
  the compression settings are actually chosen on — and it is the one the output
  screen puts first for the same reason. The multiplication is printed because it
  is the whole basis: one page has been encoded, and a reader who knows that
  knows how far to trust the total.
- **the sheet, not just the picture.** `paper size`, `orientation` and
  `page margin` decide how much of the page the scan takes up, which no bare
  picture shows. The frame's proportions and padding come from `sheetFor` in
  `pdf/build.js` — the function that lays the real page out — rather than from a
  copy of its rules, because a preview of the geometry that disagrees with the
  geometry is worse than no preview.
- **the page at 100%.** The sheet shows it at about a twelfth of its size, and at
  a twelfth of its size a JPEG block is two thirds of one screen pixel: shrinking
  a page is itself the strongest denoiser there is, so a thumbnail cannot show
  compression damage however carefully it is looked at. Measured on a 2600 px
  text scan, stepping `jpeg quality` from 50% to 95% changes **0%** of the
  thumbnail's pixels visibly and **10%** of the 100% window's.

  100% means 100% of the **page**, not of the image — one point to 4/3 CSS
  pixels, what a viewer shows with nothing zoomed, however many image pixels went
  into it. The distinction is the whole difference between a useful window and a
  misleading one: cut to the image instead, `max page pixels` changed how much of
  the page fitted beside it, so the one setting whose entire effect is resolution
  was the one setting the window could not be used to compare — it moved the
  frame every time it moved the pixels. Cut to the page, the frame holds still
  (45% of the page width at every budget) and the budget does what it actually
  does: the same piece of page, more or less finely resolved. `zoom` comes from
  `pointsPerPixel` in `pdf/build.js`, the function that places the image on the
  real page, for the same reason the sheet's proportions do.

  The window is as wide as the row leaves it, so a wider terminal is more of the
  page rather than a bigger picture of the same amount; the outline on the sheet
  says where it was cut from. It sits beside the sheet rather than behind a click
  because the space there is empty anyway, and a judgement that needs two views
  should not need an interaction to reach the second one.
- **the cost of changing one's mind.** `paper size`, `orientation` and
  `page margin` never touch the pixels, so stepping them only moves the frame
  and repaints. `jpeg quality` and `max page pixels` do, so they re-encode —
  from the bitmap decoded the first time round, not by opening the page again.
  Which setting reaches which half of the pipeline is recorded as `affects` on
  the setting itself in `settings.js`, where the answer is a fact about the
  setting rather than a guess that goes stale.

If page 1 has no page-sized image the screen says so, and says what that means:
the document is probably not a scan and only its metadata will be removed. That
verdict properly needs a third of the document, so the sample hedges rather than
concludes — a cover page is exactly the page that would mislead it.

`[enter]` passes straight through, so a run that needed no decision pays one
page and one keypress for the one that did.

## The output screen

The cleanup is lossy on purpose — pages come out as re-encoded JPEGs — so the
screen that reports it shows the result rather than asserting it:

- the first page, in the same figure the sample screen uses — the page on its
  sheet, and the middle of it beside that at 100%. The same page the sample
  proposed, but
  a different claim: that one was a proposal and this is the delivery. The tool's
  whole assertion is that it changed the file, and a screen that only says "done"
  asks to be taken on trust — so the result is shown even to someone who has just
  seen the sample it was promised from.
- `size  2.4 MB → 480 KB  -80%`. The percentage is the part worth reading. It
  is quite often positive: a scan whose source images were already compressed
  harder than the current settings comes out *bigger*, and that is exactly the
  case a "done ✓" alone would hide.
- that the file was not a scan and its pages were left alone, on the
  metadata-only path only. That they were *rebuilt* goes unsaid: the figure above
  is the rebuilt page and the summary already counted them, so the line would
  have been reporting what the screen was showing.
- what went wrong with a download, when one does. It stays on the screen: the
  result is still on offer in the other two formats, so a failed save is
  something to act on rather than something to be told once.
- which metadata fields the **source** was carrying, by name. Read from the
  file's own info dictionary rather than from the list the app strips: on the
  rebuild path the output is a fresh document that never had them, so reporting
  what was deleted from *it* would report nothing at all. A file with a clean
  info dictionary says so instead.
- whether the text layer was kept. Kept is printed in the warning colour,
  because that text is the one part of the output that has not been cleaned.

Picked images take a shorter version of the same account: they have no info
dictionary, but they may carry exif and GPS, and the canvas round-trip is what
drops those.

## Keeping the text layer

Rebuilding a scan as fresh page images is what drops watermarks — and it drops
the OCR text along with them. Turning `keep original text layer` on under `[s]`
puts that text back, so the result stays selectable and searchable.

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

### Tests

```bash
node --test "test/*.test.mjs"
```

Node's own runner, no dependencies and no build — the same bargain the rest of
the project makes. Needs Node 22.7 or newer, which is where `.js` files are
detected as ES modules without a `package.json` to declare it.

There are three of them, and the choice of what to cover is the point. These are
the places where being wrong produces a **plausible file rather than an error**:
a text layer that lands off the page, a preview that disagrees with the PDF it
promised, a scan mistaken for a watermark. Everything else in the app announces
its own failures — a screen that renders wrongly is visible, a library that
fails to load says so in the boot log — and is left to the eye, which is faster
at it than a test would be.

- **`matrix.test.mjs`** — the affine helpers, written as the properties the
  callers depend on rather than as expected numbers. Composing two matrices and
  mapping a point through the result has to equal mapping it through the two in
  turn; inverting a placement has to undo it, rotations and flips included. A
  table of expected values would pass just as happily if the convention
  underneath it changed.
- **`geometry.test.mjs`** — `sheetFor` and `pointsPerPixel`, the two functions
  the sample screen and `createNewPdf` share. It re-derives the builder's own
  placement from them and asserts the image lands inside the margins, keeps its
  proportions, is centred, and is as large as the margins allow — across every
  paper size, orientation and margin, and for portrait, landscape, square and
  panoramic input.
- **`page-image.test.mjs`** — `pickPageImage`, at the measured figures from a
  real CamScanner page (scan at 0.87 of the page, watermark at 0.006). It tests
  the ranking the doc comment promises rather than the constants, so the
  thresholds can be tuned without breaking it — including the asymmetry that
  matters most: coverage is the only veto, so a page with any candidate at all
  keeps one.

The suite is checked against deliberate regressions rather than trusted because
it is green: swapping the arguments to `multiplyMatrices`, reading `paintedSize`
off `a`/`d` instead of the column norms, turning the stretched-image demotion
into a veto, and stopping `auto` from turning the sheet each make it fail.
