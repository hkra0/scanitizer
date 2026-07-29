// Pull the page-sized scan image out of each PDF page.
//
// A scanned page is essentially one big image XObject; we walk the operator
// list, track the CTM so we know how large each image is painted, and keep the
// biggest one. Pages with no such image are counted as non-scanned, and once
// enough of them pile up we give up and report the document as not a scan.
//
// The winning image's full CTM is kept, not just its size: the page's text
// items are re-expressed relative to that image's unit square, so whoever
// re-lays the image out later can place the text on top of it without knowing
// anything about the original page geometry.

import { pdfjsLib } from '../vendor.js';
import { rasterize } from '../raster.js';
import { multiplyMatrices, invertMatrix, paintedSize } from './matrix.js';

const RENDER_SCALE = 1.5;

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

// Replay the operator list, resolving each painted image against the CTM
function collectPaintedImages(ops) {
    const initialState = {
        matrixStack: [[1, 0, 0, 1, 0, 0]],
        currentMatrix: [1, 0, 0, 1, 0, 0],
        images: [],
    };
    return ops.fnArray.reduce((state, fn, index) => {
        const args = ops.argsArray[index];
        const { matrixStack, currentMatrix, images } = state;

        switch (fn) {
            case pdfjsLib.OPS.save:
                return {
                    ...state,
                    matrixStack: [...matrixStack, [...currentMatrix]] // copy current matrix
                };

            // Pop the matrix `save` pushed. Reading one slot deeper, as this
            // used to, restores the *enclosing* save's matrix and silently
            // mislocates every image inside a nested q/Q pair.
            case pdfjsLib.OPS.restore:
                return {
                    ...state,
                    matrixStack: matrixStack.slice(0, -1), // remove last matrix
                    currentMatrix: matrixStack[matrixStack.length - 1] || [1, 0, 0, 1, 0, 0]
                };

            case pdfjsLib.OPS.transform:
                return {
                    ...state,
                    currentMatrix: multiplyMatrices(currentMatrix, args)
                };

            // args are [objId, width, height], where the size is the image's
            // own pixel dimensions — the CTM says how large it is painted, and
            // the two together are its effective resolution
            case pdfjsLib.OPS.paintImageXObject:
            case pdfjsLib.OPS.paintJpegXObject:
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
    }, initialState).images;
}

/**
 * Whether pdf.js has promoted an image to the document-wide store.
 *
 * The prefix is pdf.js's own, and it means one specific thing: the same image
 * object has now been painted by at least two different pages
 * (`GlobalImageCache.NUM_PAGES_THRESHOLD`). That is what a watermark, a
 * letterhead or a stamp does, and what the scan of a page does not.
 *
 * It also says which store the pixels are in — pdf.js dispatches on the same
 * test — so nothing may look at the name without honouring both meanings.
 */
function isShared(imageName) {
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
 *   1. not shared with other pages, over shared. pdf.js promotes an image to
 *      the document-wide store once a second page paints it, which is what a
 *      watermark, a letterhead or a stamp does and a page's own scan does not.
 *      A page carrying its own scan therefore always has a page-scoped
 *      candidate, and no watermark can outrank it however large it is painted.
 *   2. plausible resolution, over stretched. A graphic blown up far past its
 *      own pixel count is a background, not a scan.
 *   3. larger coverage.
 *
 * Two leaks are left, both narrow and both preferred to the alternative:
 *
 *   - an image looks page-scoped on the first page that paints it, since
 *     pdf.js promotes it only on the second, so rule 1 does not see a
 *     watermark there. Rules 2 and 3 still apply, and closing it properly
 *     needs identity across pages that the per-page object ids cannot give.
 *   - a watermark that is small, sharp and page-scoped passes every rule; it
 *     is stopped by coverage instead, which is what the measured CamScanner
 *     stamp (0.006 of the page) runs into.
 */
function pickPageImage(rawImages, pageArea) {
    let best = null;
    for (const { imageName, sourceWidth, matrix } of rawImages) {
        const { width, height } = paintedSize(matrix);
        const coverage = pageArea > 0 ? (width * height) / pageArea : 0;
        if (coverage < MIN_PAGE_COVERAGE) continue;

        const shared = isShared(imageName);
        // Pixels across, over inches across. Absent dimensions leave it
        // unjudged rather than guessed at.
        const dpi = width > 0 && sourceWidth > 0 ? sourceWidth / (width / 72) : 0;
        const stretched = dpi > 0 && dpi < MIN_PLAUSIBLE_DPI;

        const better = !best ||
            (best.shared !== shared ? best.shared :
                best.stretched !== stretched ? best.stretched :
                    coverage > best.coverage);
        if (better) best = { imageName, matrix, shared, stretched, coverage };
    }
    return best;
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

/**
 * @param pdf         a pdf.js document proxy
 * @param onProgress  (current, total) => void
 * @returns  an array of page images — each with a `texts` array holding the
 *           page's text items in image-normalized coordinates — or `false` if
 *           this is not a scanned PDF
 */
export async function extractImages(pdf, { onProgress } = {}) {
    const numPages = pdf.numPages;
    const extractedImages = [];
    let nonScannedCount = 0;  // pages with no page-sized image

    // Image-less pages tolerated before we call the whole document non-scanned:
    // a third of it, but never fewer than 3 pages and never more than it has
    const giveUpAfter = Math.min(Math.max(3, Math.round(numPages / 3)), numPages);

    for (let curPage = 1; curPage <= numPages; curPage++) {
        onProgress?.(curPage, numPages);
        const page = await pdf.getPage(curPage);
        const viewport = page.getViewport({ scale: RENDER_SCALE });
        const outputScale = window.devicePixelRatio || 1;
        const canvas = new OffscreenCanvas(200, 200);
        const context = canvas.getContext('2d');
        const transform = outputScale !== 1
            ? [outputScale, 0, 0, outputScale, 0, 0]
            : null;

        // Rendering populates page.objs, which is where the bitmaps come from.
        //
        // `intent: 'print'` is not about printing — it is what keeps this off
        // requestAnimationFrame. pdf.js drives a display render one chunk per
        // animation frame, and a browser stops delivering those to a tab that
        // isn't visible, so a run left in a background tab stops here and never
        // resumes: no error, no progress, just the spinner. Print intent
        // schedules the same work on microtasks instead and finishes wherever
        // the tab is. Nothing is being painted for a viewer anyway — the canvas
        // is a scratch surface and the pixels are read out of the object stores
        // afterwards — so this is also the intent that describes what the
        // render is for.
        // Annotations are dropped rather than drawn. A large share of stamped
        // watermarks are Watermark or Stamp *annotations* sitting on top of the
        // page rather than content inside it, and turning them off removes that
        // whole class outright instead of ranking around it. A scanner does not
        // put the scan in an annotation, so there is nothing here to lose.
        //
        // Both calls have to agree. `getOperatorList` enables annotations by
        // default, and a list that names images the render never decoded would
        // send the lookup below after pixels that do not exist — costing the
        // page, since a failed fetch counts it as non-scanned.
        const annotationMode = pdfjsLib.AnnotationMode.DISABLE;

        // Rendering populates page.objs, which is where the bitmaps come from.
        //
        // `intent: 'print'` is not about printing — it is what keeps this off
        // requestAnimationFrame. pdf.js drives a display render one chunk per
        // animation frame, and a browser stops delivering those to a tab that
        // isn't visible, so a run left in a background tab stops here and never
        // resumes: no error, no progress, just the spinner. Print intent
        // schedules the same work on microtasks instead and finishes wherever
        // the tab is. Nothing is being painted for a viewer anyway — the canvas
        // is a scratch surface and the pixels are read out of the object stores
        // afterwards — so this is also the intent that describes what the
        // render is for.
        await page.render({
            canvasContext: context, transform, viewport,
            intent: 'print', annotationMode,
        }).promise;

        // The page box, as the area every candidate's coverage is measured
        // against — `view` is the box pdf.js lays the page out in
        const [boxX0, boxY0, boxX1, boxY1] = page.view;
        const pageArea = Math.abs((boxX1 - boxX0) * (boxY1 - boxY0));

        const candidate = pickPageImage(
            collectPaintedImages(await page.getOperatorList({ annotationMode })),
            pageArea
        );

        const textContent = await page.getTextContent();

        // Only the winner is decoded and re-encoded — one rasterize per page
        let pageImage = null;
        if (candidate) {
            try {
                // A shared image's pixels live in the document-wide store, not
                // this page's — the same dispatch pdf.js makes on the prefix
                const store = candidate.shared ? page.commonObjs : page.objs;
                const image = await store.get(candidate.imageName);
                const { blob, width, height } = await rasterize(image.bitmap);
                pageImage = {
                    page: curPage,
                    blob,
                    width,
                    height,
                    viewport,
                    texts: collectTextItems(textContent, candidate.matrix),
                };
            } catch (err) {
                console.warn(`Image extraction failed for ${candidate.imageName}:`, err);
            }
        }

        // check if scanned
        if (!pageImage) {
            nonScannedCount++;
        } else {
            extractedImages.push(pageImage);
        }

        // Release the page's decoded bitmaps before moving on; without this a
        // long scan keeps every page's pixels alive until the document closes
        page.cleanup();

        // non-scanned PDF
        if (nonScannedCount >= giveUpAfter) return false;
    }
    return extractedImages;
}
