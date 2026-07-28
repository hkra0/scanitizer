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
const MIN_PAINTED_SIZE = 500;   // ignore decorations, logos and stamps
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

            case pdfjsLib.OPS.paintImageXObject:
            case pdfjsLib.OPS.paintJpegXObject:
                return {
                    ...state,
                    images: [...images, { imageName: args[0], matrix: [...currentMatrix] }]
                };

            default:
                return state;
        }
    }, initialState).images;
}

// The page-sized image, if this page has one: biggest painted area wins.
// Decorations, logos and stamps are filtered out by size, pdf.js-generated
// masks by their 'g_' name prefix.
function pickPageImage(rawImages) {
    let best = null;
    for (const { imageName, matrix } of rawImages) {
        if (imageName.startsWith('g_')) continue;
        const { width, height } = paintedSize(matrix);
        if (width < MIN_PAINTED_SIZE && height < MIN_PAINTED_SIZE) continue;
        const area = width * height;
        if (!best || area > best.area) best = { imageName, area, matrix };
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

        // Rendering populates page.objs, which is where the bitmaps come from
        await page.render({ canvasContext: context, transform, viewport }).promise;

        const candidate = pickPageImage(collectPaintedImages(await page.getOperatorList()));

        const textContent = await page.getTextContent();

        // Only the winner is decoded and re-encoded — one rasterize per page
        let pageImage = null;
        if (candidate) {
            try {
                const image = await page.objs.get(candidate.imageName);
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
