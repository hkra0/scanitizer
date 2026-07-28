// Pull the page-sized scan image out of each PDF page.
//
// A scanned page is essentially one big image XObject; we walk the operator
// list, track the CTM so we know how large each image is painted, and keep the
// biggest one. Pages with no such image are counted as non-scanned, and once
// enough of them pile up we give up and report the document as not a scan.

import { pdfjsLib } from '../vendor.js';
import { rasterize } from '../raster.js';

const RENDER_SCALE = 1.5;
const MIN_PAINTED_SIZE = 500;   // ignore decorations, logos and stamps
const TEXT_ITEM_THRESHOLD = 20; // items on a page before it counts as "texted"

function multiplyMatrices(m1, m2) {
    return [
        m1[0] * m2[0] + m1[2] * m2[1],
        m1[1] * m2[0] + m1[3] * m2[1],
        m1[0] * m2[2] + m1[2] * m2[3],
        m1[1] * m2[2] + m1[3] * m2[3],
        m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
        m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
    ];
}

// matrix: [a, b, c, d, e, f] — a,d: scaleX, scaleY; e,f: x,y
// only the main diagonal is used, skew is ignored
function extractPositionAndSize(matrix) {
    return {
        x: matrix[4],
        y: matrix[5],
        scaleX: matrix[0],
        scaleY: matrix[3],
    };
}

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

            case pdfjsLib.OPS.restore:
                return {
                    ...state,
                    matrixStack: matrixStack.slice(0, -1), // remove last matrix
                    currentMatrix: matrixStack[matrixStack.length - 2] || [1, 0, 0, 1, 0, 0]
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
                    images: [...images, { imageName: args[0], pos: extractPositionAndSize(currentMatrix) }]
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
    for (const { imageName, pos } of rawImages) {
        if (imageName.startsWith('g_')) continue;
        if (pos.scaleX < MIN_PAINTED_SIZE && pos.scaleY < MIN_PAINTED_SIZE) continue;
        const area = pos.scaleX * pos.scaleY;
        if (!best || area > best.area) best = { imageName, area };
    }
    return best;
}

/**
 * @param pdf              a pdf.js document proxy
 * @param onProgress       (current, total) => void
 * @param onTextDetected   called once when the document turns out to carry text
 * @returns  an array of page images, or `false` if this is not a scanned PDF
 */
export async function extractImages(pdf, { onProgress, onTextDetected } = {}) {
    const numPages = pdf.numPages;
    const extractedImages = [];
    let textedCount = 0;      // pages that look like they carry real text
    let textWarned = false;   // the text warning is only worth showing once
    let nonScannedCount = 0;  // pages with no page-sized image

    // Image-less pages tolerated before we call the whole document non-scanned:
    // a third of it, but never fewer than 3 pages and never more than it has
    const giveUpAfter = Math.min(Math.max(3, Math.round(numPages / 3)), numPages);
    // Text-carrying pages seen before the "text will be dropped" warning fires
    const warnAfterTexted = Math.min(3, numPages);

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

        // Only the winner is decoded and re-encoded — one rasterize per page
        let pageImage = null;
        if (candidate) {
            try {
                const image = await page.objs.get(candidate.imageName);
                const { blob, width, height } = await rasterize(image.bitmap);
                pageImage = { page: curPage, blob, width, height, viewport };
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

        // check if texted
        if (!textWarned && textedCount < warnAfterTexted) {
            const textContent = await page.getTextContent();
            if (textContent.items.length > TEXT_ITEM_THRESHOLD) {
                textedCount++;
            }
        }

        // Release the page's decoded bitmaps before moving on; without this a
        // long scan keeps every page's pixels alive until the document closes
        page.cleanup();

        if (nonScannedCount >= giveUpAfter) {
            // non-scanned PDF
            return false;
        } else if (!textWarned && textedCount >= warnAfterTexted && nonScannedCount < 3) {
            // PDF has text that the image-only output will drop; warn once
            onTextDetected?.();
            textWarned = true;
        }
    }
    return extractedImages;
}
