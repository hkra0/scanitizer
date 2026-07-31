// pdf/extract.js — `pickPageImage`, which decides what the scan of a page is.
//
// This is the app's one piece of judgement, and the only one whose failure is
// completely silent. Picking the wrong image yields a wrong page; picking none
// drops the page, and enough dropped pages tip the whole document onto the
// metadata-only path — where the user is handed back an unchanged file and told
// it worked. Nothing throws, nothing is logged, and the output is a plausible
// PDF either way.
//
// The tests are written against the *behaviour the doc comment promises* rather
// than against the constants, so tuning MIN_PAGE_COVERAGE or MIN_PLAUSIBLE_DPI
// does not break them — only changing what the ranking means does. The two
// measured figures from a real CamScanner page (a scan at 0.87 of the page, a
// watermark at 0.006) are used as the fixtures, since those are the numbers the
// thresholds were actually calibrated against.

import './browser-globals.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    pickPageImage, isBornDigital, readPageMarks, totalCoverage, renderScale,
} from '../js/pdf/extract.js';
import { PORTRAIT_WIDTH, PORTRAIT_HEIGHT } from '../js/config.js';

const PAGE_AREA = PORTRAIT_WIDTH * PORTRAIT_HEIGHT;

// A painted image, described the way the rules talk about it. `coverage` is the
// fraction of the page it is painted across and `dpi` its effective resolution
// once painted; the matrix and pixel count are worked back from those, so a test
// never has to state a matrix to say "a sharp image covering most of the page".
//
// The `g_` prefix is pdf.js's own marker for an image promoted to the
// document-wide store, which is what a watermark earns by being painted on a
// second page.
function painted({ name = 'img_1', coverage, dpi = 300 }) {
    const k = Math.sqrt(coverage);
    const width = PORTRAIT_WIDTH * k;
    const height = PORTRAIT_HEIGHT * k;
    return {
        imageName: name,
        sourceWidth: Math.round((dpi * width) / 72),
        sourceHeight: Math.round((dpi * height) / 72),
        matrix: [width, 0, 0, height, 0, 0],
    };
}

const SCAN = painted({ name: 'img_5', coverage: 0.87, dpi: 300 });
const WATERMARK = painted({ name: 'g_img_2', coverage: 0.006, dpi: 300 });

const pick = (images, area = PAGE_AREA, repeatedSizes = null) =>
    pickPageImage(images, area, repeatedSizes);

test('the scan is picked out from under a stamped watermark', () => {
    // The case the whole heuristic was built for, at the measured figures
    const best = pick([WATERMARK, SCAN]);
    assert.ok(best, 'a page with a scan on it must yield one');
    assert.equal(best.imageName, SCAN.imageName);
});

test('a page carrying only a watermark yields nothing', () => {
    assert.equal(pick([WATERMARK]), null);
});

test('an empty page yields nothing', () => {
    assert.equal(pick([]), null);
});

test('coverage is the only veto', () => {
    // The documented asymmetry, and the one worth a test of its own: every other
    // rule ranks, so a page with any candidate above the coverage floor must
    // keep one however badly it scores. Dropping it is the expensive failure.
    const worst = painted({ name: 'g_img_9', coverage: 0.8, dpi: 10 });
    const best = pick([worst]);
    assert.ok(best, 'a shared, stretched candidate above the floor is still kept');
    assert.equal(best.imageName, worst.imageName);
});

test('page-scoped beats shared, however much of the page the shared one covers', () => {
    // Rule 1, and the reason it is strongest: a page carrying its own scan
    // always has a page-scoped candidate, so no watermark can outrank it
    const stamp = painted({ name: 'g_img_1', coverage: 0.98, dpi: 300 });
    const scan = painted({ name: 'img_7', coverage: 0.55, dpi: 300 });
    assert.equal(pick([stamp, scan]).imageName, scan.imageName);
});

test('a plausible resolution beats a stretched one covering more', () => {
    // Rule 2: a small graphic blown up to page size is a background
    const background = painted({ name: 'img_1', coverage: 0.95, dpi: 15 });
    const scan = painted({ name: 'img_2', coverage: 0.6, dpi: 200 });
    assert.equal(pick([background, scan]).imageName, scan.imageName);
});

test('among equals, the larger coverage wins', () => {
    // Rule 3, the tie-break
    const smaller = painted({ name: 'img_1', coverage: 0.6, dpi: 300 });
    const larger = painted({ name: 'img_2', coverage: 0.9, dpi: 300 });
    assert.equal(pick([smaller, larger]).imageName, larger.imageName);
});

test('the rules are applied strongest-first', () => {
    // All three in tension at once: the shared one is sharper and covers more,
    // and still loses to rule 1; the stretched one covers more than the winner
    // and still loses to rule 2. A ranking that folded these into a single score
    // would pass the tests above and fail this one.
    const shared = painted({ name: 'g_img_1', coverage: 0.99, dpi: 600 });
    const stretched = painted({ name: 'img_2', coverage: 0.95, dpi: 12 });
    const scan = painted({ name: 'img_3', coverage: 0.52, dpi: 150 });
    assert.equal(pick([shared, stretched, scan]).imageName, scan.imageName);
});

test('the answer does not depend on the order the page painted them', () => {
    // The operator list's order is the document's business, not a ranking input.
    // Order sensitivity is the usual shape of a comparison bug here, and it would
    // show up as a handful of pages in a long scan coming out wrong.
    const images = [
        painted({ name: 'g_img_1', coverage: 0.99, dpi: 600 }),
        painted({ name: 'img_2', coverage: 0.95, dpi: 12 }),
        painted({ name: 'img_3', coverage: 0.52, dpi: 150 }),
        painted({ name: 'img_4', coverage: 0.7, dpi: 200 }),
        WATERMARK,
    ];
    const expected = pick(images).imageName;
    assert.equal(pick([...images].reverse()).imageName, expected, 'reversed');
    // every rotation of the list, so no single ordering is being relied on
    for (let i = 1; i < images.length; i++) {
        const rotated = [...images.slice(i), ...images.slice(0, i)];
        assert.equal(pick(rotated).imageName, expected, `rotated by ${i}`);
    }
});

test('the winner reports which store its pixels are in', () => {
    // `global` is not a ranking input: the caller dispatches on it to choose
    // between page.objs and page.commonObjs. Reporting it wrongly throws in the
    // lookup, and a page that holds a scan we cannot read stops the run — so a
    // bug here is a failed document rather than a wrong one.
    assert.equal(pick([SCAN]).global, false, 'in the page store');
    const stamp = painted({ name: 'g_img_1', coverage: 0.9 });
    assert.equal(pick([stamp]).global, true, 'promoted to the document-wide store');
});

test('the store an image is in does not decide whether it is repeated', () => {
    // The two used to be the same test on the same prefix, which meant the
    // ranking could only ever know what pdf.js's cache had noticed so far. With a
    // survey of the document in hand they are separate questions, and a
    // page-scoped store says nothing about repetition either way.
    const sizes = new Set([`${SCAN.sourceWidth}x${SCAN.sourceHeight}`]);
    const best = pick([SCAN], PAGE_AREA, sizes);
    assert.equal(best.global, false, 'still the page store');
    assert.equal(best.repeated, true, 'and still recognised as repeated');
});

test('a watermark is outranked on the first page it appears on', () => {
    // The leak the survey closes. pdf.js promotes an image to its global cache
    // only once a *second* page has painted it, so on page 1 a full-page
    // watermark looks exactly like a scan — and being sharp and large, it wins.
    // The survey counts the pages that reference the object, so page 1 knows.
    const stamp = painted({ name: 'img_1', coverage: 0.99, dpi: 600 });
    const scan = painted({ name: 'img_2', coverage: 0.55, dpi: 300 });
    const repeated = new Set([`${stamp.sourceWidth}x${stamp.sourceHeight}`]);

    assert.equal(pick([stamp, scan]).imageName, stamp.imageName, 'without the survey');
    assert.equal(pick([stamp, scan], PAGE_AREA, repeated).imageName, scan.imageName,
        'with it');
});

test('every page of a scan being the same size does not make them repeated', () => {
    // The trap in keying on pixel size: one scanner produces one size, so every
    // page of a scan has an image of identical dimensions. What the survey counts
    // is pages per *object*, and each page's scan is its own object — so a set
    // built from a real scan does not contain those dimensions at all, and the
    // scan is not demoted.
    const scan = painted({ name: 'img_1', coverage: 0.87 });
    const stampSize = '80x40';
    assert.equal(pick([scan], PAGE_AREA, new Set([stampSize])).repeated, false);
});

test('the winner carries the matrix it was painted with', () => {
    // The text layer is re-expressed relative to this, so the wrong matrix
    // silently misplaces every glyph on the page
    assert.deepEqual(pick([WATERMARK, SCAN]).matrix, SCAN.matrix);
});

test('an unmeasurable page is not guessed at', () => {
    // pageArea comes from page.view. A degenerate box makes every coverage zero,
    // and zero must fail the floor rather than divide by it.
    assert.equal(pick([SCAN], 0), null, 'zero page area');
    const best = pick([SCAN]);
    assert.ok(best, 'and a real page still works');
});

test('an image with no stated pixel size is left unjudged, not demoted', () => {
    // The doc comment is explicit that absent dimensions are not guessed at.
    // Treating them as 0 dpi would mark them stretched and rank them below any
    // watermark that happens to state its size.
    const unstated = { ...painted({ name: 'img_1', coverage: 0.9 }), sourceWidth: 0 };
    const stretched = painted({ name: 'img_2', coverage: 0.95, dpi: 10 });
    assert.equal(pick([unstated, stretched]).imageName, unstated.imageName);
});

// `isBornDigital`, the veto that runs before any of the above.
//
// The ranking rules only ever answer "which image on this page is the scan of
// it", never "is this page a scan at all", and a page typeset around a
// full-bleed photograph answers all of them exactly as a scan does. Without the
// veto such a page comes out as the photograph alone — its text redrawn
// invisibly by the text layer, its drawings gone — and is reported as a success.
// So this is the one judgement in the app that can destroy content rather than
// merely fail to clean it, and the tests are the two kinds of page it has to
// keep apart.
//
// Like the tests above they are written against the promised behaviour rather
// than the constants: the figures used are far enough either side of the
// thresholds that retuning them does not break a test, only redefining what the
// veto means does.

// The furniture a producer stamps onto a scan, at its most generous: a header, a
// footer with a date and a URL, a page number, a `Scanned by CamScanner` line,
// and the box and rules drawn around them.
const STAMPED_SCAN = { visibleGlyphs: 100, pathMarks: 4 };

test('a scan under stamped furniture is not taken for a laid-out page', () => {
    // The expensive direction. A vetoed page counts as non-scanned, and enough
    // of them tip the document onto the metadata-only path — where a real scan
    // is handed back unchanged and called a success.
    assert.equal(isBornDigital(STAMPED_SCAN), false);
});

test('a plain scan carries no marks at all', () => {
    assert.equal(isBornDigital({ visibleGlyphs: 0, pathMarks: 0 }), false);
});

test('a page of prose over a full-bleed image is vetoed', () => {
    // The measured brochure: 3 pages, a background photograph covering the page,
    // 25 lines of real text drawing 1250 glyphs. Before the veto this came out
    // as the photograph and nothing else.
    assert.equal(isBornDigital({ visibleGlyphs: 1250, pathMarks: 0 }), true);
});

test('a wordless drawing over a full-bleed image is vetoed too', () => {
    // What the glyph count alone misses: a page whose own content is vector, not
    // text — a chart, a diagram, a table's rules. The photograph behind it wins
    // every ranking rule, so without a second signal the drawing is dropped.
    assert.equal(isBornDigital({ visibleGlyphs: 0, pathMarks: 60 }), true);
});

test('either kind of mark is enough on its own', () => {
    // The two signals cover different pages, so they must not be required
    // together — an `&&` here would pass both tests above and veto neither of
    // the pages they describe.
    assert.equal(isBornDigital({ visibleGlyphs: 1250, pathMarks: 4 }), true, 'text');
    assert.equal(isBornDigital({ visibleGlyphs: 100, pathMarks: 60 }), true, 'vector');
});

// `readPageMarks`, the walk that produces those counts and the images alongside
// them.
//
// It takes its operator codes as an argument, so these tests write operator
// lists under codes of their own and never stand up pdf.js. What the real codes
// are is pdf.js's business and lives in the function's default; what the walk
// does with them is here.
//
// The tally and the CTM share one graphics-state stack, which is the thing worth
// testing: the text rendering mode is graphics state, so `q`/`Q` puts it back,
// and getting that wrong counts an OCR layer as drawn text and vetoes every
// OCR'd scan in existence — the whole class of document this app is for.

const OPS = {
    save: 1, restore: 2, transform: 3,
    setTextRenderingMode: 4, showText: 5, showSpacedText: 6,
    paintImageXObject: 7, fill: 8, stroke: 9,
    // in the table, so the set is built, but never used by a test below
    closeStroke: 10, eoFill: 11, fillStroke: 12, eoFillStroke: 13,
    closeFillStroke: 14, closeEOFillStroke: 15, shadingFill: 16,
    // an operator the walk has no interest in
    setFont: 17,
    // The path itself. Which of the two shapes below it takes is the pdf.js
    // version's business; the walk has to read both.
    constructPath: 18,
    endPath: 19,
};

// An operator list, written as [op, args] pairs
function opList(pairs) {
    return {
        fnArray: pairs.map(([fn]) => fn),
        argsArray: pairs.map(([, args]) => args ?? null),
    };
}

// A show-text argument: `count` glyphs, with a spacing adjustment left among
// them the way pdf.js leaves them in
const glyphs = (count) => [...Array(count).fill({ unicode: 'x' }), -250];

const marks = (pairs) => readPageMarks(opList(pairs), OPS);

test('visible text is counted and invisible text is not', () => {
    const drawn = marks([[OPS.showText, [glyphs(10)]]]);
    assert.equal(drawn.visibleGlyphs, 10, 'mode defaults to fill, which is visible');

    for (const mode of [3, 7]) {
        const hidden = marks([
            [OPS.setTextRenderingMode, [mode]],
            [OPS.showText, [glyphs(10)]],
        ]);
        assert.equal(hidden.visibleGlyphs, 0, `mode ${mode} puts down no ink`);
    }
});

test('the spacing adjustments in a show-text argument are not glyphs', () => {
    // `showSpacedText` arrives as one flat array with the TJ numbers still in it.
    // Counting the array's length instead would inflate every page — and a page
    // of tightly kerned text most of all.
    const { visibleGlyphs } = marks([[OPS.showSpacedText, [glyphs(30)]]]);
    assert.equal(visibleGlyphs, 30);
});

test('an invisible text layer stays invisible after the mode is restored', () => {
    // The bug this exists for: `Q` restores the text rendering mode, so a scan
    // whose OCR layer sits inside a q/Q — which is how a producer keeps it from
    // leaking into the rest of the page — has visible text before and after it
    // and invisible text within. A walk that let the mode leak out of the frame
    // would count the OCR layer, veto the page, and quietly stop cleaning the
    // one kind of document this app exists for.
    const { visibleGlyphs } = marks([
        [OPS.showText, [glyphs(5)]],          // a stamped page number
        [OPS.save],
        [OPS.setTextRenderingMode, [3]],
        [OPS.showText, [glyphs(2000)]],       // the OCR layer
        [OPS.restore],
        [OPS.showText, [glyphs(5)]],          // still visible, mode restored
    ]);
    assert.equal(visibleGlyphs, 10);
});

test('path-painting operators are counted and path construction is not', () => {
    const { pathMarks } = marks([
        [OPS.fill], [OPS.stroke], [OPS.fill],
        [OPS.setFont, [['g_d0', 12]]],   // not a mark
    ]);
    assert.equal(pathMarks, 3);
});

// pdf.js up to 4.x emits the path and then the operator that paints it; from
// 5.7 it folds that operator into the path's own first argument and emits
// nothing after it. Both have to count, and the reason is the asymmetry: reading
// only the old shape on a newer pdf.js finds no path marks anywhere, which does
// not fail — it silently retires half of `isBornDigital` and lets a wordless
// designed page be rasterised down to its largest image and called a success.
test('a path that carries its own paint operator is counted', () => {
    const { pathMarks } = marks([
        [OPS.constructPath, [OPS.fill, [], {}]],
        [OPS.constructPath, [OPS.stroke, [], {}]],
        [OPS.constructPath, [OPS.eoFill, [], {}]],
    ]);
    assert.equal(pathMarks, 3);
});

test('a path that paints nothing is not a mark, in either shape', () => {
    // `endPath` is what a path that is only clipped carries
    assert.equal(marks([[OPS.constructPath, [OPS.endPath, [], {}]]]).pathMarks, 0,
        'folded shape');
    // The old shape puts the construction steps in that argument instead. They
    // are an array, not an operator, and must not be mistaken for one.
    assert.equal(marks([[OPS.constructPath, [[13, 14, 14, 18], []]]]).pathMarks, 0,
        'old shape constructs without painting');
});

test('the old shape still counts the operator that follows the path', () => {
    const { pathMarks } = marks([
        [OPS.constructPath, [[19], []]],
        [OPS.fill],
        [OPS.constructPath, [[19], []]],
        [OPS.stroke],
    ]);
    assert.equal(pathMarks, 2, 'counted once each, not twice');
});

test('an image is reported with the matrix in force where it was painted', () => {
    // The images and the counts come off one walk over one list, so the stack
    // that serves the text tally is the same one that places the images. This is
    // the pairing that keeps them honest about each other.
    const { images, visibleGlyphs } = marks([
        [OPS.save],
        [OPS.transform, [200, 0, 0, 300, 10, 20]],
        [OPS.paintImageXObject, ['img_1', 1000, 1500]],
        [OPS.restore],
        [OPS.paintImageXObject, ['img_2', 10, 10]],
        [OPS.showText, [glyphs(3)]],
    ]);
    assert.equal(images.length, 2);
    assert.deepEqual(images[0], {
        imageName: 'img_1', sourceWidth: 1000, sourceHeight: 1500,
        matrix: [200, 0, 0, 300, 10, 20],
    });
    assert.deepEqual(images[1].matrix, [1, 0, 0, 1, 0, 0], 'restored to the identity');
    assert.equal(visibleGlyphs, 3);
});

test('a page that paints nothing reports nothing', () => {
    assert.deepEqual(marks([]), { images: [], visibleGlyphs: 0, pathMarks: 0 });
});

// `totalCoverage` and `renderScale`, the two figures behind the composite path.
//
// A scanner that cuts a page into strips used to defeat this file completely: no
// strip covers enough of the page to be a candidate, so the page read as having
// no scan on it, and a document of such pages read as not being a scan — handed
// back with only its metadata touched, and nothing said about why. These are the
// arithmetic that says otherwise.

// A page's scan cut into `count` strips stacked up the page, each at `dpi`
function strips(count, dpi = 300) {
    const height = PORTRAIT_HEIGHT / count;
    return Array.from({ length: count }, (unused, i) => ({
        imageName: `img_${i}`,
        sourceWidth: Math.round((dpi * PORTRAIT_WIDTH) / 72),
        sourceHeight: Math.round((dpi * height) / 72),
        matrix: [PORTRAIT_WIDTH, 0, 0, height, 0, i * height],
    }));
}

test('strips of a scan add up to a page', () => {
    // Eight strips, none of which could be a candidate on its own
    const eight = strips(8);
    for (const strip of eight) {
        assert.equal(pick([strip]), null, 'no single strip is a candidate');
    }
    assert.ok(totalCoverage(eight, PAGE_AREA) > 0.99, 'and together they are a page');
});

test('a page of small decorations does not add up to one', () => {
    const decorations = Array.from({ length: 6 }, (unused, i) =>
        painted({ name: `img_${i}`, coverage: 0.006 }));
    assert.ok(totalCoverage(decorations, PAGE_AREA) < 0.05);
});

test('coverage is measured against the page, not in absolute units', () => {
    // The same reason `MIN_PAGE_COVERAGE` is a fraction: an A6 page and an A0 page
    // have to answer this the same way
    const eight = strips(8);
    assert.ok(Math.abs(totalCoverage(eight, PAGE_AREA) - 1) < 0.01, 'A4');
    const huge = eight.map((strip) => ({
        ...strip,
        matrix: strip.matrix.map((n) => n * 4),
    }));
    assert.ok(Math.abs(totalCoverage(huge, PAGE_AREA * 16) - 1) < 0.01, 'four times over');
});

test('an unmeasurable page covers nothing rather than dividing by zero', () => {
    assert.equal(totalCoverage(strips(8), 0), 0);
});

test('a composite is rendered at the resolution its pieces were stored at', () => {
    // Rendering below it throws away detail that is in the file; above it invents
    // pixels. 300dpi is a scale of 300/72 on the page's own points.
    const scale = renderScale(strips(8, 300), PORTRAIT_WIDTH, PORTRAIT_HEIGHT, 1e9);
    assert.ok(Math.abs(scale - 300 / 72) < 0.02, `got ${scale}`);
});

test('the pixel budget caps the render, since the downscale would undo it anyway', () => {
    const budget = 1000;
    const scale = renderScale(strips(8, 1200), PORTRAIT_WIDTH, PORTRAIT_HEIGHT, budget);
    assert.ok(Math.abs(scale * PORTRAIT_HEIGHT - budget) < 1,
        'the long edge lands on the budget');
});

test('the finest piece sets the resolution, not the last one seen', () => {
    const mixed = [...strips(4, 100), ...strips(4, 400)];
    const scale = renderScale(mixed, PORTRAIT_WIDTH, PORTRAIT_HEIGHT, 1e9);
    assert.ok(Math.abs(scale - 400 / 72) < 0.02, `got ${scale}`);
});

test('a page whose images state no size still renders, at its own points', () => {
    // Dropping to a scale of 0 would be an empty canvas — a page lost to a
    // missing number
    const sizeless = strips(4).map((strip) => ({ ...strip, sourceWidth: 0, sourceHeight: 0 }));
    assert.equal(renderScale(sizeless, PORTRAIT_WIDTH, PORTRAIT_HEIGHT, 1e9), 1);
});
