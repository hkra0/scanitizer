// Turn user-picked image files into the same page-image shape that
// `extractImages` produces, so both inputs feed the identical PDF builder.

import { rasterize, closeBitmap } from './raster.js';

/**
 * @param files       a File list of images
 * @param onProgress  (current, total) => void
 * @param keepSource  hand the decoded bitmap back as `source` instead of
 *                    closing it, for a caller that is going to encode this
 *                    image again under different settings — the same bargain
 *                    `extractImages` offers, and the caller owns the result
 * @returns  [{ page, blob, width, height, texts }] — files that fail to decode
 *           are skipped. `texts` is always empty: a picked image file has no
 *           text layer to carry over, but the key is present so consumers can
 *           treat both sources alike.
 */
export async function processImageFiles(files, onProgress, { keepSource } = {}) {
    const extractedImages = [];
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        onProgress?.(i + 1, files.length);
        let bmp = null;
        let handedOver = false;
        try {
            bmp = await createImageBitmap(file);
            const { blob, width, height } = await rasterize(bmp, { orient: true });
            handedOver = Boolean(keepSource);
            extractedImages.push({
                page: i + 1, blob, width, height, texts: [],
                ...(handedOver ? { source: bmp } : {}),
            });
        } catch (err) {
            console.warn(`Image processing failed for ${file.name}:`, err);
        } finally {
            // An image that failed on the way out was never handed to anyone,
            // whatever was asked for, so it is still this loop's to release
            if (!handedOver) closeBitmap(bmp);
        }
    }
    return extractedImages;
}
