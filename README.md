# 🔪 scanitizer

A scanned PDF cleanup tool, which removes metadata, watermarks and so on. (๑- . -๑)

Everything runs in the browser — no build step, no bundler, no upload.

Notes:

- For scanned PDF with OCR text, the text is dropped by default; `keep original
  text layer` under `[s]` puts it back. See
  [Keeping the text layer](#keeping-the-text-layer).
- For non-scanned PDF the pages are kept as they are, and the metadata, the
  annotations and the watermark-marked content come off them. `remove marks
  from non-scans` under `[s]` turns the second part off. See
  [Cleaning a page that is not a scan](#cleaning-a-page-that-is-not-a-scan).
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
    preflight.js    what each page holds, from the object dictionaries alone
    tokens.js       a scanner for content streams, reporting byte ranges
    strip.js        take the watermarks and markup off a page and its forms
    sweep.js        delete every object nothing points at any more
    extract.js      pull the page-sized scan image out of each PDF page
    textlayer.js    re-draw the source text, invisibly, over the page images
    build.js        assemble page images into a clean PDF, and clean what it saves
test/
  regression.html      run the real pipeline over real files and diff the result
  corpus/              the files it runs on — gitignored, see its README
  matrix.test.mjs      the affine helpers, as the properties their callers rely on
  geometry.test.mjs    page geometry: what the sample screen and the builder share
  page-image.test.mjs  which image on a page is the scan of it
  preflight.test.mjs   what the object dictionaries alone are allowed to decide
  tokens.test.mjs      where a content-stream token ends, in the awkward cases
  strip.test.mjs       which parts of a page count as a watermark
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
| remove marks from non-scans | on, off | on |
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

A page that drew its own content — visible text, a chart — is not a scan of
anything whatever images it holds, so it is rejected before its images are ranked
at all. A brochure typeset around a full-bleed photograph answers every one of
the ranking rules the way a scan does, and used to come out as the photograph
alone, its text redrawn invisibly and its drawings gone. An OCR layer is written
in an invisible text rendering mode and so does not count against a page, which
is what keeps an OCR'd scan a scan.

A scan does not always arrive as one image per page. Some devices, and some
producers handed an image too tall to store in one object, cut the page into
horizontal strips; no strip is large enough to be the scan of a page, so such a
document used to read as not being a scan at all and come back with only its
metadata touched. What says otherwise is the total: strips of a scan add up to a
page and a scattering of decorations does not. A page that reaches the floor
between them is painted whole by pdf.js instead — at the resolution its own pieces
were stored at, capped by the pixel budget in the settings — and goes on through
the pipeline as any other page image.

Which of these a page is turns on transforms in its content stream, so answering
it costs a pdf.js parse per page, and pdf.js decodes every image it parses on the
way. Most documents that are not scans need none of that: a PDF of typeset text
has no image on any page, and that is visible in the object dictionaries alone.
So `pdf/preflight.js` reads the structure first — about 20 ms for a 9 MB file —
and gets exactly one veto, that no page in the document could hold a scan. It
never decides which image is a scan, and whatever it cannot read it passes:
a page whose images sit inside a form XObject, or whose resources will not parse,
counts as "cannot say" rather than as evidence. The same survey answers the one
question pdf.js cannot: whether an image is painted on more than one page, which
is what a watermark or a letterhead is and a page's own scan is not. pdf.js only
notices that from the second page onwards and only until its image cache fills,
so a full-page watermark used to win page 1 outright.

A page that holds a scan which cannot be decoded or encoded stops the run and
says so. It used to be counted as a page with no scan on it, which meant a
document could lose pages to failed decodes, tip onto the metadata-only path on
the strength of them, and be reported as a success.

If page 1 has no page-sized image the screen says so, and says what that means:
the document is probably not a scan and only its metadata will be removed. That
verdict properly needs a third of the document, so the sample hedges rather than
concludes — a cover page is exactly the page that would mislead it.

`[enter]` passes straight through, so a run that needed no decision pays one
page and one keypress for the one that did.

## Cleaning a page that is not a scan

The extractor's answer to a watermark is to throw the page away and keep the
pixels. That works because on a scan the pixels *are* the page. On a typeset
document they are not — the text, the fonts and the vectors are the document,
and rasterising them to get rid of a stamp costs far more than the stamp did. So
a file that is not a scan used to leave with nothing removed but its metadata.

`pdf/strip.js` is the other answer: take the marks off the page and leave the
page. Nothing is re-encoded, nothing is resampled, and every byte that is not
part of a mark is the byte that was there before. It is deliberately narrow — it
only removes what it can name, and everything it cannot read it leaves alone.
Three rules, in order of how sure they are:

1. **Annotations that are markup.** A highlight, a sticky note, a freehand
   scribble and Acrobat's own watermark are all annotations: objects hanging off
   the page rather than part of it, which is why they come away without the page
   being touched at all. The rule is stated as what survives — `Link`, which is
   how the document navigates, and `Widget`, which is a form field and would
   take the field with it — because the list of markup subtypes is long and
   open-ended, and a subtype nobody enumerated is far likelier to be another
   kind of markup than another kind of link.
2. **Content marked as a watermark artifact.** The PDF spec has a way to say
   "this is a watermark and not the document" — `/Artifact <</Subtype
   /Watermark>> BDC … EMC` — and the tools that stamp files use it. An artifact
   that says anything else, `/Pagination` for a page number, stays.
3. **Semi-transparent blocks.** A document does not draw itself at 30% opacity;
   something stamped over it does. This is the rule that catches the watermarks
   nobody labelled, and it is the least certain of the three, so it is also the
   one the guard below is really for.

Every cut is made at a boundary that restores itself — a `q`/`Q` pair or a
`BDC`/`EMC` span — so removing one cannot change how anything after it is drawn.
A rule with no such boundary to cut at, a `gs` sitting at the top level of the
stream, declines to cut anything rather than guess: deleting it on its own would
leave the rest of the page drawn under whatever state preceded it.

Rules 2 and 3 also follow the page into its **form XObjects**, which is where a
watermark usually turns out to be. A stamping tool stores the mark once, as a
reusable fragment of content stream, and each page invokes it with a single `Do`
— so the page's own stream holds nothing the rules can see, and everything they
are looking for is inside the form. Forms are cleaned once per document rather
than once per page, because one watermark form is what all five hundred pages
share; rewriting it at its own reference is what cleans all of them at once.

That case needs one thing relaxed. A watermark stamp is a fragment that is
*entirely* watermark, and the guard below — which reads "all of this is a
watermark" as evidence the rules misread the stream — would find the mark, be
certain about it, and then decline to remove it. So inside a form the guard is
lifted, but only for rule 2: `/Artifact <</Subtype /Watermark>>` is the file
saying outright that this is not the document, and there is nothing left to
second-guess. Rule 3 is a heuristic, and a heuristic that has concluded "all of
it" is exactly what the guard was written for, form or not.

What this does **not** catch is worth saying plainly. An opaque, unlabelled
watermark drawn as ordinary page content is indistinguishable from the page's
own content by any of these rules and survives. So does an action hanging off a
`Link` annotation, since legitimate links are hung the same way. So does
anything already burnt into a bitmap — that is a pixel problem and this is
nowhere near it.

### Cutting bytes rather than rebuilding

`pdf/tokens.js` scans a content stream and reports where each token *starts and
ends in the original bytes*; the cuts are then spliced out of those same bytes.
It deliberately does not parse into a tree and re-serialise. A round trip
through a parser would have to reproduce every number's precision, every
string's escaping and every name's `#` encoding to come back byte-identical, and
anywhere it failed to would be a page subtly wrong for a reason unrelated to
watermarks. Splicing cannot go subtly wrong: the parts that are not cut are
untouched.

The awkward part of the scan is the inline image. `BI … ID … EI` is the one
construct in a content stream that is not tokens, and its data may hold any byte
sequence at all — including bytes that read as `q` and `Q`. Scanned past
naively it contributes imaginary blocks and wrecks the nesting every cut
boundary depends on, so the whole span is claimed as a single token.

Two things then keep a bad reading out of the file. A page whose content stream
will not decode is handed back untouched rather than rewritten shorter, and a
page whose rules match more than nine tenths of its own content stream is handed
back untouched as well: "I appear to have found that the entire page is a
watermark" is much more likely to be a misread stream than a true finding.

Removed objects are deleted, not merely unhooked. An annotation left in the file
but referenced by nothing is still in the file — the note's text, the scribble's
path and the watermark's appearance stream all still there, invisible to a
reader and perfectly visible to anyone who looks at the bytes. A tool whose
whole claim is that things were removed cannot leave them in.

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
- that the file was not a scan and its pages were kept, on the pages-kept path
  only, and under it how many annotations and watermark blocks came off them —
  a zero included, because "nothing was found" is a different answer from "this
  was not looked at", which is what silence would have meant. That they were *rebuilt* goes unsaid: the figure above
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

### Regression over real files

The tests above cover the pure functions, which is where the rules live. They
do not touch pdf-lib, and pdf-lib is where this app can damage a document:
`pdf/strip.js` rewrites content streams in place and `pdf/sweep.js` deletes
every object it judges unreachable. Both are correct against every file anyone
here has written by hand, and hand-written files are not the ones that matter.

`test/regression.html` runs the **real** pipeline — the same functions `app.js`
calls — over a folder of real PDFs and compares each output with its input:
page count, page geometry, ink per rendered page, text retention, and whether
outlines, named destinations, page labels, form fields and the structure tree
survived the sweep. Plus the other direction: that the metadata, the scripts and
the attachments actually went.

Put files in `test/corpus/`, list them, serve the repo, and open
`test/regression.html`. See `test/corpus/README.md`. Nothing in that directory
is committed — a regression corpus is documents.

It cannot say an output is *right*. It can say the output still opens, still has
its pages, still draws them, still carries its text and its navigation, and no
longer carries what it was meant to lose — which is the set of ways this code is
actually likely to be wrong.

There are six of them, and the choice of what to cover is the point. These are
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
- **`page-image.test.mjs`** — how a page's scan is identified, in three parts.
  `pickPageImage`, at the measured figures from a real CamScanner page (scan at
  0.87 of the page, watermark at 0.006): the ranking the doc comment promises
  rather than the constants, so the thresholds can be tuned without breaking it —
  including the asymmetry that matters most, that coverage is the only veto, so a
  page with any candidate at all keeps one. `isBornDigital`, the veto that runs
  before the ranking, on the two kinds of page it has to keep apart: a scan under
  a stamped footer, and a page of prose over a full-bleed photograph.
  `readPageMarks`, the walk that counts what each page drew — where the case
  worth the test is an OCR layer inside a `q`/`Q`, since counting it as visible
  text would quietly stop cleaning the one kind of document this app is for. And
  `totalCoverage` and `renderScale`, the arithmetic behind painting a page whole:
  that eight strips of a scan add up to a page while six small decorations do not,
  and that a composite is rendered at its pieces' own resolution but never past
  the pixel budget.
- **`preflight.test.mjs`** — the two judgements made from the object dictionaries
  alone, written mostly as what must *not* be ruled out: a scan with a typeset
  cover and a colophon among it, and a page whose contents could not be
  established. Plus the trap in the repetition test — one scanner makes one size,
  so every page of a scan holds an image of identical dimensions, and counting
  sizes rather than objects would demote every page's own scan at once.

- **`tokens.test.mjs`** — where a token ends, which sounds like nothing and is
  the whole of it: the caller does not read these tokens so much as trust their
  byte offsets, and an offset that is off by any amount splices the page apart
  in the middle of something. So the cases are the ones where the end of a token
  is not where a naive scan puts it — a string holding an escaped `)`, an
  operator inside a string, a `Q` inside a comment, and above all an inline
  image, whose binary data will sooner or later contain a byte that reads as
  `q`.
- **`strip.test.mjs`** — which parts of a page count as a watermark, weighted
  towards what must *survive*. These are the most dangerous lines in the
  project: everywhere else a mistake costs a page that looks worse than it
  should, and here it costs content the user wanted, in a file they will not
  think to check because the tool told them it only removed watermarks. So the
  tests are mostly near misses — an artifact that is a page number rather than a
  watermark, an opaque block, a graphics state the page never defined, a faint
  state with no enclosing `q` to cut at — plus the guard that refuses a result
  claiming the whole page was a watermark.

The suite is checked against deliberate regressions rather than trusted because
it is green: swapping the arguments to `multiplyMatrices`, reading `paintedSize`
off `a`/`d` instead of the column norms, turning the stretched-image demotion
into a veto, stopping `auto` from turning the sheet, letting the text rendering
mode leak out of a `q`/`Q`, keying repetition on image sizes instead of objects,
and counting a page the preflight could not read as evidence against it each make
it fail.
