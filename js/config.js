// Tunables shared across modules. Nothing here touches the DOM.

export const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// === Terminal ===
export const TERM_DELAY = reduceMotion ? 0 : 55;  // ms between lines for TUI refresh effect
export const BAR_WIDTH = 18;                      // cells in the progress bar
export const SPINNER_FRAMES = ['|', '/', '-', '\\'];
export const SPINNER_INTERVAL = 200;              // ms per spinner frame
export const WARN_DURATION = 2000;                // ms a warning line stays up

// === Raster output ===
// Page-sized JPEG budget, portrait orientation; swapped for landscape input
export const MAX_PIXEL_WIDTH = 1931;
export const MAX_PIXEL_HEIGHT = 2732;
export const JPEG_QUALITY = 0.7;

// === PDF page geometry (points) ===
export const PORTRAIT_WIDTH = 595;   // A4
export const PORTRAIT_HEIGHT = 842;
export const PAGE_MARGIN = 20;

// Metadata stripped from every PDF we emit
export const METADATA_FIELDS = [
    'Producer',
    'Creator',
    'CreationDate',
    'ModDate',
    'Author',
    'Title',
    'Subject',
    'Keywords',
];

// Browsers throttle rapid programmatic downloads; space them out
export const DOWNLOAD_INTERVAL = 200;

// How long a download's object URL is kept alive after the anchor click
export const URL_LIFETIME = 60000;

export const REPO_URL = 'https://github.com/AFXR17light/scanitizer';
