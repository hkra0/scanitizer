// Put the source document's text back on top of the re-laid-out page images,
// invisibly, so the output stays selectable and searchable.
//
// The extractor hands us text items in the coordinate space of the image's
// unit square (see pdf/extract.js). Composing those with the matrix the image
// was actually drawn at puts every run back where it belongs, at whatever size
// and rotation the new layout gave the image.
//
// == Why there is no font file in here ==
//
// Every run is drawn in text rendering mode 3 — invisible. No glyph is ever
// rasterized, so the PDF needs a font *object* but not a font *program*: what
// makes the text extractable is the ToUnicode CMap, not the outlines. So we
// synthesize a non-embedded Identity-H composite font and give each distinct
// character its own two-byte code, mapped back to Unicode by a CMap we build
// as we go. That covers CJK and every other script for a few hundred bytes,
// instead of shipping a multi-megabyte font just to keep it hidden.
//
// == What this does NOT do ==
//
// The text is copied verbatim from the source. It is *not* sanitized: if the
// original carried a text watermark, that text comes along, invisible but
// still extractable. Telling an OCR layer apart from page furniture needs the
// text rendering mode of the source runs, which pdf.js's text API doesn't
// expose. Hence the feature being opt-in and labelled as such in the UI.

import {
    PDFName,
    PDFNumber,
    PDFString,
    PDFHexString,
    PDFOperator,
    PDFOperatorNames as Ops,
} from '../vendor.js';
import { multiplyMatrices, paintedSize } from './matrix.js';

// Resource name the text layer's font is bound to on each page. Pages we build
// are ours alone, so a fixed key can't collide with anything.
const FONT_KEY = 'ScTx';
const FONT_NAME = 'ScanitizerText';

// Horizontal scaling is derived from each run's measured width; nonsense input
// shouldn't be able to produce a nonsense Tz
const MIN_TZ = 1;
const MAX_TZ = 1000;

// One registry per document under construction: the reserved font ref plus the
// character -> code assignments made so far.
const registries = new WeakMap();

function getRegistry(pdfDoc) {
    let registry = registries.get(pdfDoc);
    if (!registry) {
        // The font is referenced by every page but can only be *written* once
        // the last page has contributed its characters, so reserve the ref now
        // and fill it in at finalize time.
        const ref = pdfDoc.context.register(pdfDoc.context.obj({}));
        registry = { ref, codes: new Map() };
        registries.set(pdfDoc, registry);
    }
    return registry;
}

// Codes are handed out in order of first appearance, starting at 1: the actual
// value is arbitrary since ToUnicode is what carries the meaning, and 0 is left
// alone as it reads as "notdef" to some tools.
function codeFor(registry, char) {
    let code = registry.codes.get(char);
    if (code === undefined) {
        if (registry.codes.size >= 0xfffe) return null;  // out of code space
        code = registry.codes.size + 1;
        registry.codes.set(char, code);
    }
    return code;
}

const hex4 = (n) => n.toString(16).padStart(4, '0').toUpperCase();

// A character as UTF-16BE, which is what a ToUnicode destination string is.
// Iteration is over code *units*, not code points: an astral character has to
// come out as both halves of its surrogate pair, and `Array.from` would hand
// back the whole character as one element and lose the low half.
function utf16be(char) {
    let hex = '';
    for (let i = 0; i < char.length; i++) hex += hex4(char.charCodeAt(i));
    return hex;
}

function num(n) {
    // Content streams can't carry NaN or Infinity, and pdf-lib won't catch it
    return PDFNumber.of(Number.isFinite(n) ? n : 0);
}

/**
 * Draw one page image's text, invisibly, over the rectangle the image was
 * placed at.
 *
 * @param pdfDoc  the document being built
 * @param page    the page the image was just drawn on
 * @param texts   items from extractImages, in image-normalized coordinates
 * @param dst     the image's placement as a matrix, [width 0 0 height x y]
 */
export function drawTextLayer(pdfDoc, page, texts, dst) {
    if (!texts || texts.length === 0) return;
    const registry = getRegistry(pdfDoc);
    const dstWidth = paintedSize(dst).width;

    page.node.setFontDictionary(PDFName.of(FONT_KEY), registry.ref);

    const operators = [];
    for (const item of texts) {
        const chars = Array.from(item.str);
        if (chars.length === 0) continue;

        // Text space -> unit square -> the image's place on the new page
        const m = multiplyMatrices(dst, item.matrix);
        if (!m.every(Number.isFinite)) continue;

        let hex = '';
        for (const char of chars) {
            const code = codeFor(registry, char);
            if (code === null) break;
            hex += hex4(code);
        }
        if (!hex) continue;

        // The font is used at size 1 with the run's own matrix carrying the
        // scale, which is exactly how pdf.js reports text transforms. Each
        // glyph then advances 1 unit (DW 1000), so a run of n characters is
        // n * emSize wide before Tz, and Tz stretches it onto the width the
        // run actually occupied in the source.
        const emSize = paintedSize(m).width;
        const targetWidth = item.width * dstWidth;
        const naturalWidth = emSize * chars.length;
        const tz = naturalWidth > 0 && targetWidth > 0
            ? Math.min(MAX_TZ, Math.max(MIN_TZ, (targetWidth / naturalWidth) * 100))
            : 100;

        operators.push(
            PDFOperator.of(Ops.BeginText),
            PDFOperator.of(Ops.SetFontAndSize, [PDFName.of(FONT_KEY), num(1)]),
            PDFOperator.of(Ops.SetTextRenderingMode, [num(3)]),   // invisible
            PDFOperator.of(Ops.SetTextHorizontalScaling, [num(tz)]),
            PDFOperator.of(Ops.SetTextMatrix, m.map(num)),
            PDFOperator.of(Ops.ShowText, [PDFHexString.of(hex)]),
            PDFOperator.of(Ops.EndText),
        );
    }

    if (operators.length > 0) page.pushOperators(...operators);
}

// The CMap that makes the whole thing readable: our arbitrary codes back to
// the real characters. `bfchar` blocks are capped at 100 entries by the spec.
function buildToUnicodeCMap(codes) {
    const entries = [...codes.entries()];
    const blocks = [];
    for (let i = 0; i < entries.length; i += 100) {
        const chunk = entries.slice(i, i + 100);
        blocks.push(
            `${chunk.length} beginbfchar`,
            ...chunk.map(([char, code]) => `<${hex4(code)}> <${utf16be(char)}>`),
            'endbfchar',
        );
    }
    return [
        '/CIDInit /ProcSet findresource begin',
        '12 dict begin',
        'begincmap',
        '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
        '/CMapName /Adobe-Identity-UCS def',
        '/CMapType 2 def',
        '1 begincodespacerange',
        '<0000> <FFFF>',
        'endcodespacerange',
        ...blocks,
        'endcmap',
        'CMapName currentdict /CMap defineresource pop',
        'end',
        'end',
    ].join('\n');
}

/**
 * Write out the font every page has been referencing. Call once, after the
 * last page is drawn and before saving; a no-op when no text was drawn.
 */
export function finalizeTextLayer(pdfDoc) {
    const registry = registries.get(pdfDoc);
    if (!registry || registry.codes.size === 0) return;
    const { context } = pdfDoc;

    // No FontFile: the glyphs are never painted, so there is nothing to embed.
    // The descriptor still has to be present and plausible for the font to be
    // considered well-formed.
    const descriptor = context.register(context.obj({
        Type: 'FontDescriptor',
        FontName: FONT_NAME,
        Flags: 4,                     // symbolic
        FontBBox: [0, -200, 1000, 900],
        ItalicAngle: 0,
        Ascent: 900,
        Descent: -200,
        CapHeight: 700,
        StemV: 80,
    }));

    const descendant = context.register(context.obj({
        Type: 'Font',
        Subtype: 'CIDFontType2',
        BaseFont: FONT_NAME,
        CIDSystemInfo: {
            Registry: PDFString.of('Adobe'),
            Ordering: PDFString.of('Identity'),
            Supplement: 0,
        },
        FontDescriptor: descriptor,
        DW: 1000,                     // every code one em wide; Tz does the rest
        CIDToGIDMap: 'Identity',
    }));

    const toUnicode = context.register(
        context.flateStream(buildToUnicodeCMap(registry.codes))
    );

    context.assign(registry.ref, context.obj({
        Type: 'Font',
        Subtype: 'Type0',
        BaseFont: FONT_NAME,
        Encoding: 'Identity-H',
        DescendantFonts: [descendant],
        ToUnicode: toUnicode,
    }));

    registries.delete(pdfDoc);
}

// Whether a set of page images carries anything worth offering the option for
export function hasTextLayer(images) {
    return Array.isArray(images) && images.some((img) => img.texts?.length > 0);
}
