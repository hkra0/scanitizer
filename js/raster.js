// Downscale a bitmap to the page-sized pixel budget and re-encode it as JPEG.
// Both inputs — PDF page images and user-picked image files — land here, so
// they produce the identical page-image shape for the PDF builder.

import { rasterLimits } from './settings.js';

/**
 * How big the thing we are about to draw is.
 *
 * Not every source is an ImageBitmap. pdf.js decodes a page's images through
 * WebCodecs where the browser has an `ImageDecoder` — Firefox 130+ does — and
 * what it then hands back in `image.bitmap` is a **VideoFrame**, which carries
 * `codedWidth`/`displayWidth` and no `width` at all. Reading `.width` off one
 * gives `undefined`, which turns the scale below into NaN and the canvas
 * constructor into a thrown TypeError, so every scanned page failed to render
 * on Firefox and came out as "page N holds a scan that could not be read".
 *
 * Both shapes draw fine — a VideoFrame is a CanvasImageSource like any other —
 * so only the measurement had to learn the second spelling. `displayWidth` is
 * the one to prefer of the two: it is the frame after its aspect ratio has been
 * applied, which is what `drawImage` paints.
 */
function sizeOf(source) {
    const width = source.width ?? source.displayWidth ?? source.codedWidth;
    const height = source.height ?? source.displayHeight ?? source.codedHeight;
    if (!(width > 0) || !(height > 0)) {
        throw new Error('image source has no usable dimensions');
    }
    return { width, height };
}

/**
 * @param bitmap  an ImageBitmap or VideoFrame; closed by the caller
 * @param orient  when true, the pixel budget follows the bitmap's own
 *                orientation instead of assuming portrait
 * @returns  { blob, width, height }
 */
export async function rasterize(bitmap, { orient = false } = {}) {
    // Read per call, so a settings change takes effect on the next file
    // without anything having to be re-imported or re-wired
    const { maxWidth, maxHeight, quality } = rasterLimits();
    const source = sizeOf(bitmap);
    const landscape = orient && source.width > source.height;
    const budgetWidth = landscape ? maxHeight : maxWidth;
    const budgetHeight = landscape ? maxWidth : maxHeight;

    const scale = Math.min(1, budgetWidth / source.width, budgetHeight / source.height);
    const width = Math.round(source.width * scale);
    const height = Math.round(source.height * scale);

    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    return { blob, width, height };
}

// ImageBitmaps hold their pixels outside the JS heap; release them eagerly
export function closeBitmap(bitmap) {
    if (typeof bitmap?.close === 'function') bitmap.close();
}
