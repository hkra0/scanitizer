// pdf/tokens.js — the scanner the structural cleanup cuts with.
//
// Every test here is really the same test: does the scanner know where a token
// ends. It matters more than it sounds. The caller does not read these tokens so
// much as trust their byte offsets, and an offset that is wrong by any amount
// splices a page apart in the middle of something — a string, a number, an
// image. The constructs below are the ones where the end of a token is not
// where a naive scan would put it.

import './browser-globals.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tokenize, mergeRanges, applyCuts } from '../js/pdf/tokens.js';

const bytes = (text) => new TextEncoder().encode(text);
const scan = (text) => tokenize(bytes(text));
const ops = (text) => scan(text).filter((token) => token.kind === 'op')
    .map((token) => token.value);
const text = (source, token) => source.slice(token.start, token.end);

test('operators and operands are told apart', () => {
    const tokens = scan('1 0 0 1 72 720 cm /F1 12 Tf');
    assert.deepEqual(
        tokens.map((token) => token.kind),
        ['number', 'number', 'number', 'number', 'number', 'number', 'op',
            'name', 'number', 'op'],
    );
    assert.deepEqual(ops('1 0 0 1 72 720 cm /F1 12 Tf'), ['cm', 'Tf']);
});

test('numbers keep every form PDF writes them in', () => {
    const tokens = scan('4. -.002 +7 0.5');
    assert.deepEqual(tokens.map((t) => t.kind), ['number', 'number', 'number', 'number']);
    assert.deepEqual(tokens.map((t) => t.value), [4, -0.002, 7, 0.5]);
});

test('a name is decoded past its # escapes', () => {
    // `/Artif#61ct` is `/Artifact`. A producer is free to write it that way, and
    // the watermark rule compares names against fixed strings.
    assert.equal(scan('/Artif#61ct')[0].value, 'Artifact');
});

// A literal string is the classic way to walk off the end of a token: it may
// contain both kinds of parenthesis, escaped or balanced, and every byte of it
// has to stay inside the one token.
test('a literal string holds its escaped and nested parentheses', () => {
    const source = '(a \\) b) Tj';
    assert.deepEqual(scan(source).map((t) => t.kind), ['string', 'op']);
    assert.equal(text(source, scan(source)[0]), '(a \\) b)');

    const nested = '((inner)) Tj';
    assert.equal(text(nested, scan(nested)[0]), '((inner))');
});

test('an operator inside a string is not an operator', () => {
    // The string draws the letter Q; the stream has no `Q` in it
    assert.deepEqual(ops('q (Q) Tj Q'), ['q', 'Tj', 'Q']);
});

test('a hex string and a dictionary both start with < and are not confused', () => {
    const source = '<4E4F> Tj << /Subtype /Watermark >> BDC';
    assert.deepEqual(
        scan(source).map((t) => t.kind),
        ['string', 'op', 'dictOpen', 'name', 'name', 'dictClose', 'op'],
    );
});

test('a comment is dropped and does not end the stream', () => {
    assert.deepEqual(ops('q % Q hidden in a comment\nQ'), ['q', 'Q']);
});

// The one construct that is not tokens. Its data can hold any byte at all, and
// read as tokens it would contribute imaginary `q`s and `Q`s that wreck the
// nesting every cut boundary depends on.
test('inline image data is claimed whole, operators and all', () => {
    const source = 'q BI /W 2 /H 2 /BPC 8 /CS /G ID qQQq EI Q';
    assert.deepEqual(scan(source).map((t) => t.kind), ['op', 'inlineImage', 'op']);
    assert.deepEqual(ops(source), ['q', 'Q']);
    assert.equal(text(source, scan(source)[1]), 'BI /W 2 /H 2 /BPC 8 /CS /G ID qQQq EI');
});

test('`EI` inside the data does not end the image early', () => {
    // Only an `EI` standing on its own as a keyword ends it — `EIx` does not
    const source = 'BI /W 1 /H 1 ID xEIx EI Q';
    const tokens = scan(source);
    assert.equal(tokens[0].kind, 'inlineImage');
    assert.equal(text(source, tokens[0]), 'BI /W 1 /H 1 ID xEIx EI');
    assert.deepEqual(ops(source), ['Q']);
});

test('an unterminated string runs to the end rather than looping', () => {
    const tokens = scan('q (never closed');
    assert.deepEqual(tokens.map((t) => t.kind), ['op', 'string']);
    assert.equal(tokens[1].end, bytes('q (never closed').length);
});

test('merged ranges cover what the originals covered, once', () => {
    assert.deepEqual(
        mergeRanges([{ start: 10, end: 20 }, { start: 0, end: 5 }]),
        [{ start: 0, end: 5 }, { start: 10, end: 20 }],
    );
    // Overlapping, and nested — both happen when two rules find the same block
    assert.deepEqual(
        mergeRanges([{ start: 0, end: 10 }, { start: 5, end: 15 }]),
        [{ start: 0, end: 15 }],
    );
    assert.deepEqual(
        mergeRanges([{ start: 0, end: 30 }, { start: 5, end: 15 }]),
        [{ start: 0, end: 30 }],
    );
});

test('merging leaves the ranges it was given alone', () => {
    const ranges = [{ start: 0, end: 10 }, { start: 5, end: 15 }];
    mergeRanges(ranges);
    assert.deepEqual(ranges, [{ start: 0, end: 10 }, { start: 5, end: 15 }]);
});

test('a cut leaves a separator behind it', () => {
    const source = 'AA BB CC';
    const out = new TextDecoder().decode(applyCuts(bytes(source), [{ start: 3, end: 5 }]));
    // Without the newline the neighbours would fuse into one token
    assert.equal(out, 'AA \n CC');
});

test('cutting nothing returns the same bytes', () => {
    const input = bytes('q Q');
    assert.equal(applyCuts(input, []), input);
});
