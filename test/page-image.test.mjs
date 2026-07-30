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

import { pickPageImage } from '../js/pdf/extract.js';
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

const pick = (images, area = PAGE_AREA) => pickPageImage(images, area);

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
    // `shared` is not just a ranking input: the caller dispatches on it to choose
    // between page.objs and page.commonObjs. Reporting it wrongly throws in the
    // lookup, which is caught and counted as a page with no image — so a bug
    // here is again a dropped page rather than an error.
    assert.equal(pick([SCAN]).shared, false, 'page-scoped');
    const stamp = painted({ name: 'g_img_1', coverage: 0.9 });
    assert.equal(pick([stamp]).shared, true, 'promoted to the document-wide store');
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
