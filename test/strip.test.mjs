// pdf/strip.js — the rules that decide which parts of a page are a watermark.
//
// These are the most dangerous lines in the project. Everywhere else, a mistake
// costs a page that looks worse than it should; here it costs content the user
// wanted and cannot get back, in a file they will not think to check because the
// tool told them it only removed watermarks. So the tests below are weighted
// towards what must *survive*: ordinary page content, content the rules half
// match, and pages the scanner cannot make sense of.
//
// Only the pure half is here. `stripMarks`, `stripAnnotations` and `stripContent`
// are pdf-lib walking a real document, and what they hand these rules is the
// stream and the two lookups below.

import './browser-globals.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tokenize } from '../js/pdf/tokens.js';
import { contentCuts, rewriteContent } from '../js/pdf/strip.js';

const bytes = (text) => new TextEncoder().encode(text);
const cuts = (source, lookups) => contentCuts(tokenize(bytes(source)), lookups);

// What the cuts actually take out, so a test can read as the removal it is
// rather than as a pair of offsets
const removed = (source, lookups) =>
    cuts(source, lookups).map(({ start, end }) => source.slice(start, end));

const rewritten = (source, lookups) => {
    const result = rewriteContent(bytes(source), lookups);
    return {
        text: new TextDecoder().decode(result.bytes),
        blocks: result.blocks,
    };
};

// A page whose /ExtGState has one faint state and one solid one
const alphas = { alphaOf: (name) => ({ Faint: 0.25, Solid: 1 }[name] ?? null) };

// === The transparency rule ===

test('a faint block goes, and takes only itself', () => {
    const source = 'BT (real content) Tj ET\n' +
        'q /Faint gs 1 0 0 1 100 400 cm (WATERMARK) Tj Q\n' +
        'BT (more content) Tj ET';
    assert.deepEqual(
        removed(source, alphas),
        ['q /Faint gs 1 0 0 1 100 400 cm (WATERMARK) Tj Q'],
    );
});

test('an opaque block stays', () => {
    assert.deepEqual(removed('q /Solid gs (content) Tj Q', alphas), []);
});

test('a graphics state the page does not define stays', () => {
    // `alphaOf` answers null for a state it cannot read, and null is not faint
    assert.deepEqual(removed('q /Unknown gs (content) Tj Q', alphas), []);
});

test('a faint state outside any block cuts nothing', () => {
    // There is no boundary here that restores what the cut would change: taking
    // the `gs` out on its own leaves the rest of the page drawn under whatever
    // state preceded it. Nothing is cut rather than something being guessed at.
    assert.deepEqual(removed('/Faint gs (content) Tj', alphas), []);
});

test('the faint block is cut, not the one enclosing it', () => {
    const source = 'q 1 0 0 1 0 0 cm q /Faint gs (mark) Tj Q (content) Tj Q';
    assert.deepEqual(removed(source, alphas), ['q /Faint gs (mark) Tj Q']);
});

test('a faint state reaches the block it was set in, not the one inside it', () => {
    // Set in the outer block, so the outer block is what has to go — everything
    // in it, nested blocks included, is drawn faint
    const source = 'q /Faint gs q (mark) Tj Q (also mark) Tj Q';
    assert.deepEqual(removed(source, alphas), [source]);
});

// === The artifact rule ===

test('content marked as a watermark artifact goes, tag and all', () => {
    const source = 'BT (content) Tj ET\n' +
        '/Artifact <</Subtype /Watermark>> BDC BT (DRAFT) Tj ET EMC';
    assert.deepEqual(
        removed(source, {}),
        ['/Artifact <</Subtype /Watermark>> BDC BT (DRAFT) Tj ET EMC'],
    );
});

test('a watermark artifact named in the page resources goes too', () => {
    const source = '/Artifact /P0 BDC (DRAFT) Tj EMC';
    const lookups = { propertySubtype: (name) => (name === 'P0' ? 'Watermark' : null) };
    assert.deepEqual(removed(source, lookups), [source]);
    // The same span with a property list that says something else stays
    assert.deepEqual(removed(source, { propertySubtype: () => 'Pagination' }), []);
});

test('an artifact that is not a watermark stays', () => {
    // Running headers, footers and page numbers are artifacts as well, and they
    // are part of the document
    assert.deepEqual(
        removed('/Artifact <</Subtype /Pagination>> BDC (12) Tj EMC', {}),
        [],
    );
    assert.deepEqual(removed('/Artifact BMC (12) Tj EMC', {}), []);
});

test('ordinary marked content stays', () => {
    assert.deepEqual(removed('/P <</MCID 0>> BDC BT (a paragraph) Tj ET EMC', {}), []);
});

test('a watermark span nested in ordinary marked content takes only itself', () => {
    const source = '/P <</MCID 0>> BDC (text) Tj ' +
        '/Artifact <</Subtype /Watermark>> BDC (DRAFT) Tj EMC EMC';
    assert.deepEqual(
        removed(source, {}),
        ['/Artifact <</Subtype /Watermark>> BDC (DRAFT) Tj EMC'],
    );
});

// === Streams the scanner cannot trust ===

test('an unbalanced Q is stepped over rather than throwing', () => {
    assert.deepEqual(removed('Q q /Faint gs (mark) Tj Q', alphas), ['q /Faint gs (mark) Tj Q']);
    assert.deepEqual(removed('EMC (content) Tj', {}), []);
});

test('a faint block whose Q never arrives cuts nothing', () => {
    // Its end is unknown, so its range is unknown. The block is recorded and
    // never closed, and an unclosed block is never a cut.
    assert.deepEqual(removed('q /Faint gs (mark) Tj', alphas), []);
});

test('operators inside an inline image do not open or close a block', () => {
    const source = 'q /Faint gs BI /W 1 /H 1 ID Qq EI Q (content) Tj';
    assert.deepEqual(removed(source, alphas), ['q /Faint gs BI /W 1 /H 1 ID Qq EI Q']);
});

// === The rewrite, and the guard on it ===

test('a rewrite removes the block and leaves the rest byte for byte', () => {
    const source = 'BT (content) Tj ET\nq /Faint gs (mark) Tj Q\nBT (more) Tj ET';
    const { text, blocks } = rewritten(source, alphas);
    assert.equal(blocks, 1);
    assert.equal(text, 'BT (content) Tj ET\n\n\nBT (more) Tj ET');
});

test('a page with nothing to remove comes back as the same bytes', () => {
    const input = bytes('BT (content) Tj ET');
    const result = rewriteContent(input, alphas);
    assert.equal(result.blocks, 0);
    // Identity, not equality: the caller skips writing the page back on it
    assert.equal(result.bytes, input);
});

test('a result that would take nearly the whole page is refused', () => {
    // A stream that is one faint block from end to end. Read literally the rules
    // say the entire page is a watermark, which is far likelier to mean they
    // misread it — so the page is handed back untouched.
    const source = 'q /Faint gs BT (everything on this page) Tj ET Q';
    assert.deepEqual(removed(source, alphas), [source]);   // the rule does match
    assert.equal(rewritten(source, alphas).blocks, 0);     // and is then declined
    assert.equal(rewritten(source, alphas).text, source);
});

// === The guard, lifted for a form XObject ===
//
// A watermark stamp is stored as a form and is *entirely* watermark, so the
// page's "nearly all of it cannot be right" guard would find the mark, be
// certain about it, and then decline to remove it. Lifting the guard is what
// makes the form case work at all — and it is lifted only for cuts the file
// labelled itself, because a heuristic that has concluded "all of it" is
// precisely what the guard was written for.

const asForm = (source, lookups) => {
    const result = rewriteContent(bytes(source), lookups, { allowFullCut: true });
    return { text: new TextDecoder().decode(result.bytes), blocks: result.blocks };
};

test('a form that is entirely a labelled watermark is removed whole', () => {
    const source = '/Artifact <</Subtype /Watermark>> BDC q 1 0 0 1 0 0 cm (DRAFT) Tj Q EMC';
    // As a page it is refused, exactly as before
    assert.equal(rewritten(source, alphas).blocks, 0, 'page');
    // As a form it goes, because the file said what it was
    const form = asForm(source, alphas);
    assert.equal(form.blocks, 1, 'form');
    assert.equal(form.text.trim(), '', 'nothing of it is left');
});

test('a form that is entirely faint is still refused', () => {
    // No label, only the transparency guess — the guard stands whatever the
    // caller is willing to allow
    const source = 'q /Faint gs BT (all of this form) Tj ET Q';
    assert.equal(asForm(source, alphas).blocks, 0);
    assert.equal(asForm(source, alphas).text, source);
});

test('a form is refused when a guess is mixed in with the label', () => {
    // One labelled span and one faint block, together covering the whole
    // stream. The label does not vouch for the guess.
    const source = '/Artifact <</Subtype /Watermark>> BDC (DRAFT) Tj EMC\n' +
        'q /Faint gs (something else) Tj Q';
    assert.equal(asForm(source, alphas).blocks, 0);
});

test('a form keeps its content when only part of it is a watermark', () => {
    const source = 'BT (the real fragment) Tj ET\n' +
        '/Artifact <</Subtype /Watermark>> BDC (DRAFT) Tj EMC';
    const form = asForm(source, alphas);
    assert.equal(form.blocks, 1);
    assert.match(form.text, /the real fragment/);
    assert.doesNotMatch(form.text, /DRAFT/);
});
