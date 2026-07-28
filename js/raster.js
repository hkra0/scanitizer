// Downscale a bitmap to the page-sized pixel budget and re-encode it as JPEG.
// Both inputs — PDF page images and user-picked image files — land here, so
// they produce the identical page-image shape for the PDF builder.

import { MAX_PIXEL_WIDTH, MAX_PIXEL_HEIGHT, JPEG_QUALITY } from './config.js';

/**
 * @param bitmap  an ImageBitmap; closed by the caller
 * @param orient  when true, the pixel budget follows the bitmap's own
 *                orientation instead of assuming portrait
 * @returns  { blob, width, height }
 */
export async function rasterize(bitmap, { orient = false } = {}) {
    const landscape = orient && bitmap.width > bitmap.height;
    const budgetWidth = landscape ? MAX_PIXEL_HEIGHT : MAX_PIXEL_WIDTH;
    const budgetHeight = landscape ? MAX_PIXEL_WIDTH : MAX_PIXEL_HEIGHT;

    const scale = Math.min(1, budgetWidth / bitmap.width, budgetHeight / bitmap.height);
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);

    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
    return { blob, width, height };
}

// ImageBitmaps hold their pixels outside the JS heap; release them eagerly
export function closeBitmap(bitmap) {
    if (typeof bitmap?.close === 'function') bitmap.close();
}
