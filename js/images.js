// Turn user-picked image files into the same page-image shape that
// `extractImages` produces, so both inputs feed the identical PDF builder.

import { rasterize, closeBitmap } from './raster.js';

/**
 * @param files       a File list of images
 * @param onProgress  (current, total) => void
 * @returns  [{ page, blob, width, height }] — files that fail to decode are skipped
 */
export async function processImageFiles(files, onProgress) {
    const extractedImages = [];
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        onProgress?.(i + 1, files.length);
        let bmp = null;
        try {
            bmp = await createImageBitmap(file);
            const { blob, width, height } = await rasterize(bmp, { orient: true });
            extractedImages.push({ page: i + 1, blob, width, height });
        } catch (err) {
            console.warn(`Image processing failed for ${file.name}:`, err);
        } finally {
            closeBitmap(bmp);
        }
    }
    return extractedImages;
}
