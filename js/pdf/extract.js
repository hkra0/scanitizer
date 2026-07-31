// Pull the page-sized scan image out of each PDF page.
//
// A scanned page is essentially one big image XObject; we walk the operator
// list, track the CTM so we know how large each image is painted, and keep the
// biggest one. Pages that carry substantive content of their own — visible text,
// a drawing — are not scans of anything whatever images they hold, and are
// rejected before the images are ranked. Pages with no page-sized image are
// counted as non-scanned, and once enough of them pile up we give up and report
// the document as not a scan.
//
// The winning image's full CTM is kept, not just its size: the page's text
// items are re-expressed relative to that image's unit square, so whoever
// re-lays the image out later can place the text on top of it without knowing
// anything about the original page geometry.

import { pdfjsLib } from '../vendor.js';
import { rasterize, closeBitmap } from '../raster.js';
import { rasterLimits } from '../settings.js';
import { multiplyMatrices, invertMatrix, paintedSize } from './matrix.js';
import { surveyDocument, noScanPossible, repeatedImageSizes } from './preflight.js';

/**
 * How much of the page an image must cover to be a candidate for being the
 * scan of it. Measured against the page box rather than in absolute units, so
 * the same rule holds for A6 and for A0 — an absolute threshold silently means
 * something different on every paper size.
 *
 * Calibrated against a real scan: a CamScanner page paints its scan across
 * 0.87 of the page and its watermark across 0.006 — two orders of magnitude
 * apart, so the exact figure between them matters little. It is set low rather
 * than close to the measured 0.87 because the risk is asymmetric: too high
 * drops a page with generous margins entirely, too low only lets a large
 * decoration compete, where the rules below then rank it.
 */
const MIN_PAGE_COVERAGE = 0.5;

/**
 * Below this, an image is being stretched far past its own resolution — a
 * small graphic blown up to page size, which is a background or a watermark
 * and not a scan. Even a poor fax is above it, so it demotes rather than
 * disqualifies (see pickPageImage).
 */
const MIN_PLAUSIBLE_DPI = 50;
// How far outside the image a text item's origin may sit and still count as
// belonging to it — glyphs on the very edge of a scan routinely land a hair
// outside the painted box.
const HIT_TOLERANCE = 0.02;

/**
 * Text rendering modes that put no ink on the page: 3 is invisible, 7 adds the
 * glyphs to the clipping path and paints nothing.
 *
 * This is the distinction the whole born-digital test rests on. An OCR layer —
 * ours included, see textlayer.js — is written in mode 3 precisely so it can sit
 * over a scan without being seen, so a scan that has been through OCR can carry
 * a page of text and still be a scan. Text that is actually *drawn* is the
 * page's own content.
 */
const INVISIBLE_TEXT_MODES = new Set([3, 7]);

/**
 * Visible glyphs a page may draw and still be taken for a scan.
 *
 * What a producer stamps onto a scan is short: a page number, a Bates number, a
 * date, a footer, `Scanned by CamScanner` (21 glyphs). What a laid-out page
 * carries is a page of prose — the 3-page brochure this threshold was tested
 * against draws 1250. Two orders of magnitude again, so the figure between them
 * is not delicate.
 *
 * The gap it leaves is a sparsely worded designed page: a title slide over a
 * full-bleed photograph draws a dozen glyphs and reads as a scan. Closing it
 * would mean vetoing pages over a stamped footer, which costs a real scan, so
 * the line sits where the counts are unambiguous and `PATH_MARKS_ALLOWED`
 * covers the part of the gap it can.
 */
const VISIBLE_GLYPHS_ALLOWED = 200;

/**
 * Path-painting operators a page may use and still be taken for a scan.
 *
 * A scan is ink in a bitmap, so the vector marks around it are page furniture: a
 * white background box, a border, a rule under a header. A drawing — a chart, a
 * table's rules, a logo, a diagram — runs to dozens of fills and strokes.
 *
 * Unlike the glyph figure this one is reasoned from what the two kinds of page
 * are made of rather than measured, so it is set well clear of the furniture it
 * has to tolerate rather than close to the drawings it is meant to catch. It
 * exists to cover the wordless designed page that the glyph count misses.
 */
const PATH_MARKS_ALLOWED = 8;

/**
 * The operators that commit a constructed path to the page.
 *
 * Construction (moveTo, rectangle, …) is not a mark — pdf.js folds it into
 * `constructPath` anyway — and neither is `clip` or `endPath`, which paint
 * nothing. `shadingFill` puts down a gradient, which no scanner does.
 */
function pathMarkOps(OPS) {
    return new Set([
        OPS.stroke, OPS.closeStroke,
        OPS.fill, OPS.eoFill,
        OPS.fillStroke, OPS.eoFillStroke,
        OPS.closeFillStroke, OPS.closeEOFillStroke,
        OPS.shadingFill,
        OPS.rawFillPath,
    ].filter((op) => op !== undefined));
}

/**
 * The paint operator a `constructPath` carries, when it carries one.
 *
 * pdf.js changed shape here between 4.x and 5.7: it used to emit the path and
 * then the operator that paints it, as two entries, and now it folds the paint
 * operator into `constructPath`'s first argument and emits nothing after it.
 * Under the newer shape a set of paint operators matched against `fnArray`
 * finds none of them, and `pathMarks` comes out zero on every page — which does
 * not fail, it just quietly retires half of `isBornDigital`. A wordless designed
 * page would then read as a scan and be rasterised down to its largest image,
 * reported as a success.
 *
 * So both shapes are read. On the old one the first argument is the array of
 * path-construction steps, which is not a number and matches no operator; on the
 * new one it is the operator's own code. `endPath` appears there for a path that
 * is only clipped, and paints nothing, so the same set decides both.
 */
function paintOpOf(args) {
    return typeof args?.[0] === 'number' ? args[0] : undefined;
}

// Glyphs in a show-text operator's argument. pdf.js hands both `showText` and
// `showSpacedText` a single flat array of glyphs with the spacing adjustments
// left in it as bare numbers, so the numbers are what has to be skipped.
function countGlyphs(glyphs) {
    if (!Array.isArray(glyphs)) return 0;
    return glyphs.reduce((n, glyph) => (typeof glyph === 'number' ? n : n + 1), 0);
}

/**
 * Replay the operator list, resolving each painted image against the CTM and
 * tallying the marks the page makes on its own account.
 *
 * The two are read in one pass because they are read from the same list and the
 * text tally needs the same graphics-state stack the images need: the text
 * rendering mode is graphics state, so `q`/`Q` restores it, and a tally that
 * ignored that would read the mode from the wrong frame and count invisible
 * glyphs as drawn.
 *
 * @param ops  the result of page.getOperatorList()
 * @param OPS  the operator-code table, defaulting to the live pdf.js one. A
 *             parameter because it is the only thing in here that comes from
 *             outside: a test can walk a list it wrote itself under codes it
 *             chose, and never has to stand up pdf.js to do it. Which codes mean
 *             what is pdf.js's business and stays in the default — nothing below
 *             cares what the numbers are, only that they are told apart. Note
 *             that this also means a test cannot notice pdf.js renumbering them;
 *             a real document going through `extractImages` is what does that.
 * @returns { images, visibleGlyphs, pathMarks }
 */
export function readPageMarks(ops, OPS = pdfjsLib.OPS) {
    const markOps = pathMarkOps(OPS);
    const initialState = {
        // One frame per `save`, holding everything `restore` has to put back
        stack: [{ matrix: [1, 0, 0, 1, 0, 0], textMode: 0 }],
        currentMatrix: [1, 0, 0, 1, 0, 0],
        textMode: 0,   // 0 is `fill`, the PDF default
        images: [],
        visibleGlyphs: 0,
        pathMarks: 0,
    };
    const state = ops.fnArray.reduce((state, fn, index) => {
        const args = ops.argsArray[index];
        const { stack, currentMatrix, textMode, images } = state;

        if (markOps.has(fn)) {
            return { ...state, pathMarks: state.pathMarks + 1 };
        }
        // The same question again, for the pdf.js versions that fold the answer
        // into the path instead of emitting it separately
        if (fn === OPS.constructPath && markOps.has(paintOpOf(args))) {
            return { ...state, pathMarks: state.pathMarks + 1 };
        }

        switch (fn) {
            case OPS.save:
                return {
                    ...state,
                    // copy the current matrix
                    stack: [...stack, { matrix: [...currentMatrix], textMode }]
                };

            // Restore the frame `save` pushed, which is the last slot — the
            // stack is read before the pop, so the index is the top of it.
            // Reading one slot deeper takes the *enclosing* save's frame
            // instead, and silently mislocates every image inside a nested q/Q.
            case OPS.restore: {
                const frame = stack[stack.length - 1] ||
                    { matrix: [1, 0, 0, 1, 0, 0], textMode: 0 };
                return {
                    ...state,
                    stack: stack.slice(0, -1), // remove last frame
                    currentMatrix: frame.matrix,
                    textMode: frame.textMode,
                };
            }

            case OPS.transform:
                return {
                    ...state,
                    currentMatrix: multiplyMatrices(currentMatrix, args)
                };

            case OPS.setTextRenderingMode:
                return { ...state, textMode: args[0] };

            case OPS.showText:
            case OPS.showSpacedText:
                if (INVISIBLE_TEXT_MODES.has(textMode)) return state;
                return {
                    ...state,
                    visibleGlyphs: state.visibleGlyphs + countGlyphs(args[0]),
                };

            // args are [objId, width, height], where the size is the image's
            // own pixel dimensions — the CTM says how large it is painted, and
            // the two together are its effective resolution
            case OPS.paintImageXObject:
                return {
                    ...state,
                    images: [...images, {
                        imageName: args[0],
                        sourceWidth: args[1],
                        sourceHeight: args[2],
                        matrix: [...currentMatrix],
                    }]
                };

            default:
                return state;
        }
    }, initialState);
    const { images, visibleGlyphs, pathMarks } = state;
    return { images, visibleGlyphs, pathMarks };
}

/**
 * Whether this page was laid out rather than scanned.
 *
 * The image rules below only ever ask which image on a page is most likely to be
 * the scan of it. They never ask whether the page is a scan at all, and a page
 * that was typeset around a full-bleed photograph answers every one of them the
 * way a scan does: the photograph covers the page, is sharp, and belongs to that
 * page alone. Such a page used to come out as the photograph and nothing else,
 * its text redrawn invisibly by the text layer and its drawings gone — a result
 * that is reported as a success and looks like a blank picture.
 *
 * That is why this is a veto and not another ranking rule: no image on the page
 * can be the right answer, so there is nothing to rank. The page then counts as
 * non-scanned, and a document made of such pages tips onto the metadata-only
 * path, which hands back the pages untouched. Being wrong here therefore costs a
 * document its images-rebuilt pass; being wrong the other way costs it its
 * content.
 *
 * Exported for `test/page-image.test.mjs`, for the same reason `pickPageImage`
 * is: its failure is silent either way.
 */
export function isBornDigital({ visibleGlyphs, pathMarks }) {
    return visibleGlyphs > VISIBLE_GLYPHS_ALLOWED || pathMarks > PATH_MARKS_ALLOWED;
}

/**
 * Whether the pixels for this image are in the document-wide store rather than
 * the page's own.
 *
 * The prefix is pdf.js's own and this is the dispatch pdf.js itself makes on it,
 * so it is read here for that one purpose: knowing which store to ask. It used
 * to answer the ranking's question about repetition as well — the promotion
 * happens because a second page painted the same object — but two meanings on
 * one test meant neither could be improved without disturbing the other, and the
 * repetition question is now answered by the preflight, which can see the whole
 * document's objects instead of one cache's state.
 */
function isGlobalStore(imageName) {
    return imageName.startsWith('g_');
}

/**
 * The page-sized image, if this page has one.
 *
 * Only one thing disqualifies a candidate outright: not covering enough of the
 * page to be a scan of it. Everything else ranks, and ranking never empties the
 * list — a page that has any candidate at all keeps one. That asymmetry is
 * deliberate. Picking the wrong image on a page yields a wrong page; picking
 * none drops the page, and enough dropped pages make the whole document read
 * as non-scanned and go through with only its metadata touched. The second
 * failure is far worse and much quieter, so nothing but coverage gets a veto.
 *
 * The order, strongest first:
 *
 *   1. painted on this page alone, over painted on several. One object on many
 *      pages is what a watermark, a letterhead or a stamp is, and what a page's
 *      own scan is not. A page carrying its own scan therefore always has a
 *      page-scoped candidate, and no watermark can outrank it however large it
 *      is painted.
 *   2. plausible resolution, over stretched. A graphic blown up far past its
 *      own pixel count is a background, not a scan.
 *   3. larger coverage.
 *
 * @param repeatedSizes  `WIDTHxHEIGHT` keys for the images this document paints
 *                       on more than one page, from `preflight.repeatedImageSizes`.
 *                       Rule 1 reads it. Given nothing it falls back on pdf.js's
 *                       cache prefix, which answers the same question for a
 *                       document whose structure could not be surveyed — later,
 *                       and only up to the cache's byte budget, but it is what
 *                       there is then.
 *
 * The leak that is left, and is preferred to the alternative: a watermark that
 * is small, sharp and painted on one page only passes every rule. Coverage stops
 * it instead, which is what the measured CamScanner stamp (0.006 of the page)
 * runs into.
 *
 * Exported for `test/page-image.test.mjs` rather than because anything else
 * calls it. The ranking above is the one piece of judgement in the app whose
 * failure is silent: picking wrong costs a page, and enough lost pages flip the
 * whole document to the metadata-only path — an unchanged file, reported as a
 * success. Reaching it through `extractImages` would mean mocking pdf.js, so it
 * is reachable directly instead.
 */
export function pickPageImage(rawImages, pageArea, repeatedSizes = null) {
    let best = null;
    for (const { imageName, sourceWidth, sourceHeight, matrix } of rawImages) {
        const { width, height } = paintedSize(matrix);
        const coverage = pageArea > 0 ? (width * height) / pageArea : 0;
        if (coverage < MIN_PAGE_COVERAGE) continue;

        const global = isGlobalStore(imageName);
        const repeated = repeatedSizes
            ? repeatedSizes.has(`${sourceWidth}x${sourceHeight}`)
            : global;
        // Pixels across, over inches across. Absent dimensions leave it
        // unjudged rather than guessed at.
        const dpi = width > 0 && sourceWidth > 0 ? sourceWidth / (width / 72) : 0;
        const stretched = dpi > 0 && dpi < MIN_PLAUSIBLE_DPI;

        const better = !best ||
            (best.repeated !== repeated ? best.repeated :
                best.stretched !== stretched ? best.stretched :
                    coverage > best.coverage);
        if (better) best = { imageName, matrix, global, repeated, stretched, coverage };
    }
    return best;
}

/**
 * How much of the page all its images cover between them.
 *
 * A scanner does not always paint a page as one image. Some devices, and some
 * producers handed an image too tall to store in one object, cut the scan into
 * horizontal strips and paint them one under another; each strip is then a small
 * fraction of the page and no single one of them is a candidate for being the
 * scan of it. Such a page has always been read here as having no scan on it at
 * all, and a document of them as not being a scan — the quietest failure this
 * code has, since the file comes back with only its metadata touched and nothing
 * says why.
 *
 * The total is what says the difference: strips of a scan add up to a page, and
 * a page of small decorations does not. It is a sum and not a union, so images
 * painted over one another are counted twice and can reach the floor between them
 * without covering it. That direction is the safe one — it puts the page through
 * the composite below, which paints whatever is actually there.
 */
export function totalCoverage(rawImages, pageArea) {
    if (!(pageArea > 0)) return 0;
    return rawImages.reduce((total, { matrix }) => {
        const { width, height } = paintedSize(matrix);
        return total + (width * height) / pageArea;
    }, 0);
}

/**
 * The scale to render a page at when its scan has to be composited out of
 * several images, as a factor on the page's own points.
 *
 * Two figures bound it. The finest of the images' own resolutions is what the
 * page is worth: rendering below it throws away detail that is in the file, and
 * above it invents pixels. The pixel budget in the settings is what the page will
 * be shipped at, so rendering beyond that is work whose product is thrown away by
 * the downscale a moment later. The budget wins where they disagree.
 *
 * @param budget  the long edge, in pixels, the output is allowed
 */
export function renderScale(rawImages, pageWidth, pageHeight, budget) {
    // Pixels per point is what a viewport scale already is, so the image's own
    // resolution needs no conversion to become one
    const native = rawImages.reduce((finest, { sourceWidth, sourceHeight, matrix }) => {
        const { width, height } = paintedSize(matrix);
        const across = width > 0 && sourceWidth > 0 ? sourceWidth / width : 0;
        const up = height > 0 && sourceHeight > 0 ? sourceHeight / height : 0;
        return Math.max(finest, across, up);
    }, 0);

    // A page whose images state no size of their own still renders, at its own
    // points. Small, but it is a page rather than a dropped one.
    const wanted = Math.max(1, native);
    const longEdge = Math.max(pageWidth, pageHeight);
    const cap = longEdge > 0 && budget > 0 ? budget / longEdge : 0;
    return cap > 0 ? Math.min(wanted, cap) : wanted;
}

/**
 * pdf.js resolves bidi before handing text back, so a right-to-left run
 * arrives in *visual* order with `dir` set to 'rtl'. Storing that verbatim
 * would reverse the text: whatever reads our output applies bidi again, on a
 * string that has already been through it once. Undoing it here means one bidi
 * pass total, and the output extracts the way the source did.
 *
 * What pdf.js does to an RTL run is reverse each whitespace-separated piece
 * while leaving the pieces where they are, so doing the same again inverts it.
 * Reversing the string as a whole does not: it would swap the word order too.
 * Iterating with the spread operator walks code points, so surrogate pairs
 * survive intact.
 *
 * This is matched to how pdf.js orders text, not derived from the bidi
 * algorithm, so a run that mixes scripts — Arabic with Latin or digits inside
 * it — can still come back out of order. A uniformly RTL run, which is what a
 * page of scanned text gives, round-trips exactly.
 */
function toLogicalOrder(item) {
    if (item.dir !== 'rtl') return item.str;
    return item.str
        .split(/(\s+)/)
        .map((piece) => (/^\s*$/.test(piece) ? piece : [...piece].reverse().join('')))
        .join('');
}

/**
 * Re-express the page's text items in the coordinate space of the picked
 * image's unit square: origin at the image's bottom-left corner, 1.0 across
 * and 1.0 up. Items whose origin falls outside that square belong to something
 * else on the page (a second image, page furniture, a margin stamp) and are
 * dropped, since nothing downstream knows where to put them.
 *
 * Each surviving item carries `matrix`, its own text matrix composed into that
 * normalized space. Placing the image at [w 0 0 h x y] later and composing
 * that on top puts the text back exactly where it sat on the original page,
 * rotation, flips and skew included.
 *
 * @param textContent  the result of page.getTextContent()
 * @param imageMatrix  the picked image's CTM
 */
function collectTextItems(textContent, imageMatrix) {
    const inverse = invertMatrix(imageMatrix);
    if (!inverse) return [];
    const { width, height } = paintedSize(imageMatrix);
    const min = -HIT_TOLERANCE;
    const max = 1 + HIT_TOLERANCE;

    const items = [];
    for (const item of textContent.items) {
        if (!item.str || !item.transform) continue;   // marked-content markers
        // apply the item's own transform, then map page space into image space
        const matrix = multiplyMatrices(inverse, item.transform);
        const [u, v] = [matrix[4], matrix[5]];
        if (u < min || u > max || v < min || v > max) continue;
        items.push({
            str: toLogicalOrder(item),
            matrix,
            width: width ? item.width / width : 0,
            height: height ? item.height / height : 0,
            dir: item.dir,
            hasEOL: item.hasEOL,
        });
    }
    return items;
}

// Image-less pages tolerated before the whole document is called non-scanned: a
// third of it, but never fewer than 3 pages and never more than it has. Shared
// with the preflight, which measures the same allowance against the document's
// structure — the two have to agree or the cheap verdict rejects documents the
// expensive one would have kept.
function giveUpThreshold(numPages) {
    return Math.min(Math.max(3, Math.round(numPages / 3)), numPages);
}

/**
 * The bitmap pdf.js decoded for one image, waited for.
 *
 * The callback form, because it waits: the bare `get` throws on anything not
 * already settled, and the decode that resolves these runs loose from the
 * operator list's own promise, so without the wait a big image is a thrown error
 * on every page.
 */
async function decodedImage(page, candidate) {
    // A globally cached image's pixels are in the document-wide store, not this
    // page's — the same dispatch pdf.js makes on the prefix
    const store = candidate.global ? page.commonObjs : page.objs;
    const image = await new Promise((resolve) => {
        store.get(candidate.imageName, resolve);
    });
    // pdf.js reports a failed decode by resolving with null
    if (!image?.bitmap) throw new Error('no decoded bitmap');
    return image.bitmap;
}

/**
 * A page painted whole, for a scan that arrives in pieces.
 *
 * Compositing the pieces by hand would mean reimplementing image placement —
 * every strip's transform, its clip, whatever is layered over it — so the page is
 * handed to pdf.js to paint instead, which is the one thing in this file that is
 * unambiguously pdf.js's own job. Text is not a concern: a page with substantive
 * text of its own has already been rejected as laid out, and what is left is a
 * scan's OCR layer, which is invisible and paints nothing.
 *
 * `rotation: 0` keeps the pixels in the same space as `page.view` and the text
 * transforms, so the text layer still lands on the image. A page's `/Rotate` is
 * ignored throughout this file — a single extracted image carries whatever
 * orientation it was stored in — and this stays consistent with that.
 *
 * `intent: 'print'` is not about printing: it is what keeps this off
 * requestAnimationFrame. pdf.js drives a display render one chunk per animation
 * frame, and a browser stops delivering those to a tab that isn't visible, so a
 * run left in a background tab would stop here and never resume — no error, no
 * progress, just the spinner. Print intent schedules the same work on microtasks
 * and finishes wherever the tab is.
 *
 * The caller owns the bitmap.
 */
async function compositePage(page, scale, annotationMode) {
    const viewport = page.getViewport({ scale, rotation: 0 });
    const canvas = new OffscreenCanvas(
        Math.max(1, Math.ceil(viewport.width)),
        Math.max(1, Math.ceil(viewport.height)),
    );
    const context = canvas.getContext('2d');
    // A PDF page is transparent where nothing is painted and the output is JPEG,
    // which has no transparency — left alone, the margins of a strip-painted
    // page come out black
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({
        canvasContext: context, viewport,
        intent: 'print', annotationMode,
    }).promise;
    return createImageBitmap(canvas);
}

/**
 * @param pdf         a pdf.js document proxy
 * @param pdfBytes    the file's bytes, for the structural preflight. Optional:
 *                    without it every page goes through pdf.js to be judged, and
 *                    the ranking falls back on pdf.js's cache prefix for
 *                    repetition. Given it, a document that cannot be a scan is
 *                    rejected in about the time pdf.js takes to open one page.
 * @param onProgress  (current, total) => void
 * @param limit       stop after this many pages. The sample screen extracts
 *                    one page to show what the settings do to it, and that is
 *                    the same walk this makes, cut short — there is no second
 *                    path for it to drift from. The non-scan verdict below is
 *                    still measured against the *whole* document, so a bounded
 *                    run reports what it found and never reaches a conclusion
 *                    it has not read enough pages to draw. (The preflight's
 *                    verdict is a whole-document one already, so it stands
 *                    whatever the limit is.)
 * @param keepSource  hand back the winning bitmap as `source`, for a caller that
 *                    is going to encode this page more than once. Everything
 *                    above the encoder — the operator list, the decode, the pick
 *                    — gives the same answer whatever the compression settings
 *                    say, and is the overwhelming majority of the cost; the
 *                    bitmap is the one part of it that cannot be kept any other
 *                    way, since pdf.js's own copy does not survive the
 *                    `page.cleanup()` below. The caller owns it and has to close
 *                    it.
 * @returns  an array of page images — each with a `texts` array holding the
 *           page's text items in image-normalized coordinates — or `false` if
 *           this is not a scanned PDF
 * @throws   if a page that holds a scan cannot be turned into one. A page that
 *           has no scan on it is evidence about the document and is counted; a
 *           page whose scan could not be decoded or encoded is a failure, and
 *           counting it as evidence let a document lose pages and still be
 *           delivered as a success. Both callers already report a thrown error.
 */
export async function extractImages(pdf, { pdfBytes, onProgress, limit, keepSource } = {}) {
    const numPages = pdf.numPages;
    const giveUpAfter = giveUpThreshold(numPages);
    const survey = await surveyDocument(pdfBytes);

    // The cheap verdict, before pdf.js is asked to decode anything
    if (survey && noScanPossible(survey, giveUpAfter)) return false;
    const repeatedSizes = survey ? repeatedImageSizes(survey) : null;

    const extractedImages = [];
    let nonScannedCount = 0;  // pages with no scan on them
    const lastPage = limit ? Math.min(limit, numPages) : numPages;

    for (let curPage = 1; curPage <= lastPage; curPage++) {
        onProgress?.(curPage, lastPage);
        const page = await pdf.getPage(curPage);

        // Annotations are dropped rather than read. A large share of stamped
        // watermarks are Watermark or Stamp *annotations* sitting on top of the
        // page rather than content inside it, and turning them off removes that
        // whole class outright instead of ranking around it. A scanner does not
        // put the scan in an annotation, so there is nothing here to lose — and
        // an annotation's own text and paths cannot make the page read as laid
        // out either. Every pdf.js call about this page passes it, the composite
        // included: a page painted under different rules from the ones it was
        // judged under is a different page.
        const annotationMode = pdfjsLib.AnnotationMode.DISABLE;

        // Building the operator list is also what puts the page's bitmaps in the
        // object stores: pdf.js decodes each image in the worker as it parses,
        // and posts it over (`_sendImgData`). Nothing has to be rendered to get
        // at them, and rendering to get at them cost about a third of the time
        // the whole extraction took.
        const marks = readPageMarks(await page.getOperatorList({ annotationMode }));

        // The page box, as the area every candidate's coverage is measured
        // against — `view` is the box pdf.js lays the page out in
        const [boxX0, boxY0, boxX1, boxY1] = page.view;
        const pageWidth = Math.abs(boxX1 - boxX0);
        const pageHeight = Math.abs(boxY1 - boxY0);
        const pageArea = pageWidth * pageHeight;

        // A page that drew its own content is not a scan of anything, whatever
        // images it holds, so there is nothing to pick and nothing to composite
        const laidOut = isBornDigital(marks);
        const candidate = laidOut
            ? null
            : pickPageImage(marks.images, pageArea, repeatedSizes);
        // No one image is the scan, but the images between them cover the page:
        // a scan that was cut into pieces
        const inPieces = !laidOut && !candidate &&
            totalCoverage(marks.images, pageArea) >= MIN_PAGE_COVERAGE;

        // Asked for only once there is something to place it against, since a
        // page with no scan on it is not going to use it — but outside the catch
        // below, which exists for a failed image and would turn a failure here
        // into a page quietly dropped instead of a run that stops and says so.
        const textContent = candidate || inPieces ? await page.getTextContent() : null;

        // Only what is going to be shipped is decoded and re-encoded — one
        // rasterize per page
        let pageImage = null;
        if (candidate || inPieces) {
            // What the text items are placed against: the image's own placement
            // where there is one image, and the page box itself where the page
            // was painted whole, since that is the box the composite covers
            const imageMatrix = candidate
                ? candidate.matrix
                : [pageWidth, 0, 0, pageHeight, Math.min(boxX0, boxX1), Math.min(boxY0, boxY1)];
            let bitmap = null;
            try {
                if (candidate) {
                    bitmap = await decodedImage(page, candidate);
                } else {
                    const { maxWidth, maxHeight } = rasterLimits();
                    const scale = renderScale(
                        marks.images, pageWidth, pageHeight, Math.max(maxWidth, maxHeight),
                    );
                    bitmap = await compositePage(page, scale, annotationMode);
                }
                const { blob, width, height } = await rasterize(bitmap);
                pageImage = {
                    page: curPage, blob, width, height,
                    texts: collectTextItems(textContent, imageMatrix),
                };
                if (keepSource) {
                    // pdf.js is about to be told it can let go of the page, and
                    // what it lets go of includes its own copy — so a decoded
                    // image is copied, while a composite is ours to hand over
                    pageImage.source = candidate
                        ? await createImageBitmap(bitmap)
                        : bitmap;
                    if (!candidate) bitmap = null;
                }
            } catch (err) {
                const what = candidate
                    ? `image ${candidate.imageName}`
                    : `composite of ${marks.images.length} images`;
                console.warn(`Page ${curPage}: ${what} failed:`, err);
                throw new Error(`page ${curPage} holds a scan that could not be read`,
                    { cause: err });
            } finally {
                // Ours to release: a composite we did not hand over. pdf.js's own
                // copy is released by `page.cleanup()` below.
                if (bitmap && !candidate) closeBitmap(bitmap);
            }
        }

        if (pageImage) {
            extractedImages.push(pageImage);
        } else {
            nonScannedCount++;
        }

        // Release the page's decoded bitmaps before moving on; without this a
        // long scan keeps every page's pixels alive until the document closes
        page.cleanup();

        // non-scanned PDF
        if (nonScannedCount >= giveUpAfter) return false;
    }
    return extractedImages;
}
