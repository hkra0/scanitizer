// Tunables shared across modules. Nothing here touches the DOM.

export const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// === Terminal ===
// ms between lines for the TUI refresh effect. About one line per repaint,
// which is as fast as this can go and still be a line-by-line effect at all:
// below a frame the lines land in the same paint and simply appear together.
// So the sweep stays visible while the individual lines barely resolve.
export const TERM_DELAY = reduceMotion ? 0 : 16;
export const BAR_WIDTH = 18;                      // cells in the progress bar
export const SPINNER_FRAMES = ['|', '/', '-', '\\'];
export const SPINNER_INTERVAL = 200;              // ms per spinner frame
// Below this, an estimate is noise: it would appear for a moment on a stage
// that was about to end anyway. Stages too quick to be worth waiting on
// therefore never show one at all, which is the intended answer.
export const ETA_MIN_MS = 1000;
// How far from the last line still counts as "at the bottom". A couple of grid
// pixels of slack, so sub-pixel layout and browser zoom can't strand the view
// one fraction of a row short of the end and read as the user having scrolled up.
export const SCROLL_SLACK = 8;                    // px
// Breathing room left above or below a row the option cursor has just stepped
// onto. Four grid pixels — the same height as the gap between blocks — so a row
// brought into view doesn't end up flush against the edge of the window.
export const SCROLL_REVEAL_MARGIN = 12;           // px

// === Raster output ===
// Default page-sized JPEG budget, portrait orientation; swapped for landscape
// input. js/settings.js offers this alongside coarser and finer choices.
export const MAX_PIXEL_WIDTH = 1931;
export const MAX_PIXEL_HEIGHT = 2732;
export const JPEG_QUALITY = 0.7;

// === PDF page geometry (points) ===
// What one point is worth on screen at 100%. A point is 1/72 inch and CSS calls
// an inch 96 pixels, which is the ratio every viewer's "100%" is built on — so
// this is the factor that turns a page size in points into the size the page is
// shown at when nothing is zoomed.
export const CSS_PX_PER_PT = 96 / 72;
// The default sheet, and the long edge every `fit` page is scaled to
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
