// A scanner for PDF content streams.
//
// It exists so that content can be *cut out* of a page without the page being
// rebuilt. Everything else in this project that touches a page throws its
// structure away and re-lays the pixels out; that is the right answer for a
// scan and no answer at all for a typeset document, where the text, the fonts
// and the vectors are the thing worth keeping. Removing a watermark from such a
// page means deleting the operators that draw it and leaving every other byte
// exactly where it was.
//
// So this does not parse into a tree and it does not re-serialise. It reports
// where each token *starts and ends in the original bytes*, and the caller
// splices ranges out of those same bytes. A round trip through a parser would
// have to reproduce every number's precision, every string's escaping and every
// name's `#` encoding to come back byte-identical, and anywhere it failed to
// would be a page that is subtly wrong for a reason unrelated to watermarks.
// Cutting byte ranges cannot go subtly wrong: the parts that are not cut are
// untouched.

// The six bytes PDF counts as white space, null included.
const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);

// ( ) < > [ ] { } / % — the bytes that end a token without being part of it.
const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

const NEWLINE = new Uint8Array([0x0a]);

const isWhitespace = (b) => WHITESPACE.has(b);
const isRegular = (b) => b !== undefined && !WHITESPACE.has(b) && !DELIMITERS.has(b);

function latin1(bytes, start, end) {
    let out = '';
    for (let i = start; i < end; i++) out += String.fromCharCode(bytes[i]);
    return out;
}

// `/A#20B` is the name `A B`. Undoing it matters because the caller compares
// names against fixed strings — a producer that writes `/Artif#61ct` would
// otherwise walk straight past the watermark test.
function decodeName(raw) {
    return raw.replace(/#([0-9A-Fa-f]{2})/g, (match, hex) =>
        String.fromCharCode(parseInt(hex, 16)));
}

// PDF numbers have no exponent and no leading `+`-only form: `1`, `-.002`, `4.`
// are all numbers, `abc` and `Q` are not.
function isNumber(text) {
    return /[0-9]/.test(text) && /^[+-]?[0-9]*\.?[0-9]*$/.test(text);
}

/**
 * Where a literal string ends, given the offset of its opening `(`.
 *
 * Parentheses nest, and a backslash escapes the byte after it — including a
 * parenthesis, which is the whole reason this cannot be a search for `)`. A
 * string that never closes runs to the end of the stream, which is what an
 * unbalanced one does to a real reader too.
 */
function endOfLiteralString(bytes, start) {
    let depth = 0;
    for (let i = start; i < bytes.length; i++) {
        const b = bytes[i];
        if (b === 0x5c) { i++; continue; }        // backslash: skip what it escapes
        if (b === 0x28) depth++;                  // (
        else if (b === 0x29 && --depth === 0) return i + 1;  // )
    }
    return bytes.length;
}

// Where a hex string ends, given the offset of its opening `<`. No escapes to
// worry about; the first `>` closes it.
function endOfHexString(bytes, start) {
    for (let i = start + 1; i < bytes.length; i++) {
        if (bytes[i] === 0x3e) return i + 1;
    }
    return bytes.length;
}

/**
 * Where an inline image ends, given the offset just past its `BI`.
 *
 * This is the one construct in a content stream that is not tokens: after `ID`
 * comes raw image data, which may hold any byte sequence at all — including
 * things that look like operators. Scanned past naively it would be read as
 * hundreds of spurious `q`s and `Q`s and would wreck the nesting the caller
 * depends on, so the whole `BI … EI` span is claimed as a single token.
 *
 * `EI` is found the way every reader has to find it: as a keyword standing on
 * its own, preceded by white space and followed by white space or the end of
 * the stream. That can in principle occur inside the data; nothing in the file
 * says how long the data is, so no reader can do better, and being wrong here
 * costs a mis-scanned page rather than a corrupted one — the caller's own guard
 * on how much it is willing to cut is what keeps that from reaching the file.
 */
function endOfInlineImage(bytes, start) {
    let dataStart = -1;
    for (let i = start; i < bytes.length - 1; i++) {
        if (bytes[i] === 0x49 && bytes[i + 1] === 0x44 &&        // I D
            isWhitespace(bytes[i - 1]) && !isRegular(bytes[i + 2])) {
            dataStart = i + 3;   // `ID` plus the single white-space byte after it
            break;
        }
    }
    if (dataStart < 0) return bytes.length;
    for (let i = dataStart; i < bytes.length - 1; i++) {
        if (bytes[i] === 0x45 && bytes[i + 1] === 0x49 &&        // E I
            isWhitespace(bytes[i - 1]) && !isRegular(bytes[i + 2])) {
            return i + 2;
        }
    }
    return bytes.length;
}

/**
 * The stream as a flat list of tokens, each carrying its byte range.
 *
 * @param bytes  the decoded content stream
 * @returns [{ kind, start, end, value }] where `kind` is one of
 *          'op' | 'number' | 'name' | 'string' | 'inlineImage' |
 *          'arrayOpen' | 'arrayClose' | 'dictOpen' | 'dictClose' | 'brace'
 *
 *          `value` is the operator for 'op', the decoded name for 'name', the
 *          number for 'number', and absent otherwise: the caller reads
 *          operators, names and the occasional number, and needs nothing from a
 *          string but the fact that it was one and where it stopped.
 *
 * Comments are dropped rather than reported. Nothing downstream can act on one,
 * and leaving them in the list would mean every operand scan had to skip them.
 * They stay in the file — this reports on the bytes, it does not rewrite them.
 */
export function tokenize(bytes) {
    const tokens = [];
    let i = 0;

    while (i < bytes.length) {
        const b = bytes[i];

        if (isWhitespace(b)) { i++; continue; }
        if (b === 0x25) {   // % — comment, to the end of the line
            while (i < bytes.length && bytes[i] !== 0x0a && bytes[i] !== 0x0d) i++;
            continue;
        }

        const start = i;

        if (b === 0x2f) {   // /Name
            i++;
            while (isRegular(bytes[i])) i++;
            tokens.push({
                kind: 'name', start, end: i,
                value: decodeName(latin1(bytes, start + 1, i)),
            });
            continue;
        }

        if (b === 0x28) {   // (literal string)
            i = endOfLiteralString(bytes, i);
            tokens.push({ kind: 'string', start, end: i });
            continue;
        }

        if (b === 0x3c) {   // << dictionary, or <hex string>
            if (bytes[i + 1] === 0x3c) {
                i += 2;
                tokens.push({ kind: 'dictOpen', start, end: i });
            } else {
                i = endOfHexString(bytes, i);
                tokens.push({ kind: 'string', start, end: i });
            }
            continue;
        }

        if (b === 0x3e) {   // >> — a lone `>` is malformed and is stepped over
            i += bytes[i + 1] === 0x3e ? 2 : 1;
            if (i - start === 2) tokens.push({ kind: 'dictClose', start, end: i });
            continue;
        }

        if (b === 0x5b || b === 0x5d) {   // [ ]
            i++;
            tokens.push({ kind: b === 0x5b ? 'arrayOpen' : 'arrayClose', start, end: i });
            continue;
        }

        if (b === 0x7b || b === 0x7d) {   // { } — type 4 functions only, never operators
            i++;
            tokens.push({ kind: 'brace', start, end: i });
            continue;
        }

        // A run of regular bytes: a number, or an operator
        i++;
        while (isRegular(bytes[i])) i++;
        const text = latin1(bytes, start, i);

        if (isNumber(text)) {
            tokens.push({ kind: 'number', start, end: i, value: parseFloat(text) });
        } else if (text === 'BI') {
            i = endOfInlineImage(bytes, i);
            tokens.push({ kind: 'inlineImage', start, end: i, value: 'BI' });
        } else {
            tokens.push({ kind: 'op', start, end: i, value: text });
        }
    }

    return tokens;
}

/**
 * Overlapping and touching ranges folded into as few as cover the same bytes.
 *
 * Cuts arrive overlapping as a matter of course: a watermark inside a `q … Q`
 * block that is itself inside a marked-content span is found twice, once by
 * each rule. Splicing both would delete the outer range and then delete bytes
 * that are no longer where the inner range says they are.
 */
export function mergeRanges(ranges) {
    const sorted = [...ranges].sort((a, b) => a.start - b.start);
    return sorted.reduce((merged, range) => {
        const last = merged[merged.length - 1];
        if (last && range.start <= last.end) {
            last.end = Math.max(last.end, range.end);
            return merged;
        }
        return [...merged, { ...range }];
    }, []);
}

/**
 * The bytes with the given ranges removed. Ranges must be merged first.
 *
 * A newline goes in where each cut was. The bytes on either side were separated
 * by the removed span and may not be separated by anything else — `…Q` against
 * `1 0 0 1 0 0 cm` would run together into one nonsense token otherwise.
 */
export function applyCuts(bytes, cuts) {
    if (!cuts.length) return bytes;
    const kept = [];
    let at = 0;
    for (const cut of cuts) {
        kept.push(bytes.subarray(at, cut.start));
        kept.push(NEWLINE);
        at = cut.end;
    }
    kept.push(bytes.subarray(at));

    const total = kept.reduce((n, part) => n + part.length, 0);
    const out = new Uint8Array(total);
    kept.reduce((offset, part) => {
        out.set(part, offset);
        return offset + part.length;
    }, 0);
    return out;
}
