// tinyko stays the text it always was — '✂️(๑- . -๑)' — and gets a pixel
// filter on top: the line is drawn small on a canvas and blown up with
// nearest-neighbour scaling, so every glyph lands on visible square pixels
// instead of being smoothed into shape. Nothing is redrawn by hand; the
// browser's own rendering of the characters is what gets coarsened.

// Cell size of the low-resolution buffer, in CSS pixels of the final image.
// 3 keeps the kaomoji readable while the blocks are unmistakable.
const PIXEL = 3;

// Font size the text is rasterised at, before the blow-up
const BASE = 11;

const PAD = 1; // buffer pixels around the text, so nothing clips

// Coverage a pixel needs before it counts as ink
const ALPHA = 110;

// The browser antialiases text with gamma correction, so light ink on nothing
// covers more than dark ink does — the same glyphs came out visibly fatter in
// dark mode. The stencil is therefore always rasterised in this one colour and
// the real ink is painted through it, which makes the pixels identical in both
// schemes.
const STENCIL = '#000';

// getComputedStyle hands colours back as rgb()/rgba(), so the channels are
// there to be read off
function inkRGB(color) {
    const parts = color.match(/\d+(\.\d+)?/g);
    return parts ? parts.slice(0, 3).map(Number) : [0, 0, 0];
}

/**
 * Draw tinyko's line into `canvas` through the pixel filter. `font` is a CSS font
 * shorthand family, `color` the ink for the text glyphs (the emoji brings its
 * own colours). Returns nothing; the canvas is resized to fit.
 */
export function renderTinyko(canvas, text, font, color) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Rasterise small, on an offscreen buffer
    const buf = document.createElement('canvas');
    const bctx = buf.getContext('2d');
    if (!bctx) return;
    const fontSpec = `${BASE}px ${font}`;
    bctx.font = fontSpec;
    const m = bctx.measureText(text);
    const ascent = Math.ceil(m.actualBoundingBoxAscent || BASE);
    const descent = Math.ceil(m.actualBoundingBoxDescent || BASE / 4);
    const w = Math.ceil(m.width) + PAD * 2;
    const h = ascent + descent + PAD * 2;
    buf.width = w;
    buf.height = h;

    // Resizing clears the context, so the font has to be set again
    bctx.font = fontSpec;
    bctx.textBaseline = 'alphabetic';

    // Pass one: the colours, as the browser draws them — the ink for the text,
    // the emoji's own palette for the tool
    bctx.fillStyle = color;
    bctx.fillText(text, PAD, PAD + ascent);
    const paint = bctx.getImageData(0, 0, w, h).data;

    // Pass two: the stencil, in a fixed colour, so which pixels survive does
    // not depend on the scheme
    bctx.clearRect(0, 0, w, h);
    bctx.fillStyle = STENCIL;
    bctx.fillText(text, PAD, PAD + ascent);
    const img = bctx.getImageData(0, 0, w, h);
    const data = img.data;

    // Snap the antialiasing to on/off, so the blow-up comes out as hard-edged
    // pixels rather than a blur of half-lit ones, and take the colour of every
    // surviving pixel from the first pass
    const ink = inkRGB(color);
    for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < ALPHA) {
            data[i + 3] = 0;
            continue;
        }
        data[i + 3] = 255;
        // Pixels the colour pass barely touched carry no usable colour of
        // their own, so they take the ink
        const lit = paint[i + 3] > 0;
        data[i] = lit ? paint[i] : ink[0];
        data[i + 1] = lit ? paint[i + 1] : ink[1];
        data[i + 2] = lit ? paint[i + 2] : ink[2];
    }
    bctx.putImageData(img, 0, 0);

    // Blow it up with smoothing off — this is the whole filter
    canvas.width = w * PIXEL;
    canvas.height = h * PIXEL;
    canvas.style.width = `${w * PIXEL}px`;
    canvas.style.height = `${h * PIXEL}px`;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(buf, 0, 0, canvas.width, canvas.height);
}
