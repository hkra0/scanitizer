// Saving to disk. Everything is produced in-page as a Blob and handed to an
// anchor click — no server, no upload.

import { JSZip, jszipReady } from './vendor.js';
import { DOWNLOAD_INTERVAL, URL_LIFETIME } from './config.js';

export function saveUrl(url, name) {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
}

function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    saveUrl(url, name);
    // Revoking synchronously kills the download before it starts in Firefox
    // and some WebKit builds, so let the click settle first
    setTimeout(() => URL.revokeObjectURL(url), URL_LIFETIME);
}

export function pageFileName(baseName, index) {
    return `${baseName}_${String(index + 1).padStart(3, '0')}.jpg`;
}

// Strip the extension so outputs are named after the input
export function baseNameOf(fileName) {
    return fileName.replace(/\.[^/.]+$/, '');
}

/**
 * One file per page. Browsers throttle bursts of downloads, so they are spaced
 * out and reported through `onProgress`.
 */
export async function downloadImages(images, baseName, onProgress) {
    for (let i = 0; i < images.length; i++) {
        onProgress?.(i + 1, images.length);
        saveBlob(images[i].blob, pageFileName(baseName, i));
        await new Promise((r) => setTimeout(r, DOWNLOAD_INTERVAL));
    }
}

export async function downloadZip(images, baseName) {
    // jszip is loaded in the background, and this is the only thing that needs
    // it — by the time a file has been processed it has long since arrived
    if (!(await jszipReady)) throw new Error('jszip unavailable');
    const zip = new JSZip();
    images.forEach((img, i) => {
        zip.file(pageFileName(baseName, i), img.blob);
    });
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    saveBlob(zipBlob, `${baseName}_images.zip`);
}
