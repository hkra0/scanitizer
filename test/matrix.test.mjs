// pdf/matrix.js — the affine helpers the text layer rides on.
//
// These are worth testing for one reason: nothing checks them at runtime and
// nothing looks wrong when they are wrong. A composition with its arguments the
// other way round still produces a matrix, still places text, and still saves a
// PDF — the glyphs just land somewhere else on the page, invisibly, in a text
// layer nobody looks at until they try to select a word.
//
// So the tests are written as the properties the callers actually rely on
// rather than as expected outputs: a fixed matrix of expected numbers would
// pass just as silently if the convention underneath it changed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { multiplyMatrices, invertMatrix, paintedSize } from '../js/pdf/matrix.js';

// PDF's own convention, spelled out at the top of matrix.js: row vectors,
// [x y 1] * [[a b 0] [c d 0] [e f 1]]. This is the reference the tests compare
// against, so it is written from the layout rather than from the code under test.
function apply([a, b, c, d, e, f], [x, y]) {
    return [a * x + c * y + e, b * x + d * y + f];
}

const IDENTITY = [1, 0, 0, 1, 0, 0];

// Relative rather than absolute: the same composition is exercised at unit-square
// coordinates and at page coordinates, and a fixed epsilon that is generous at
// 0.5 is tighter than a double can hold at 1e7
function close(actual, expected, what) {
    const tolerance = 1e-9 * Math.max(1, Math.abs(expected));
    assert.ok(
        Math.abs(actual - expected) <= tolerance,
        `${what}: expected ${expected}, got ${actual}`,
    );
}

function closePoint(actual, expected, what) {
    close(actual[0], expected[0], `${what} x`);
    close(actual[1], expected[1], `${what} y`);
}

// A spread of placements a scan actually produces: plain, rotated, flipped,
// skewed, translated. Deliberately not random — a property that only holds for
// the seeds a run happened to draw is a property that fails in the field.
const PLACEMENTS = [
    ['identity', IDENTITY],
    ['scale', [200, 0, 0, 300, 0, 0]],
    ['translate', [1, 0, 0, 1, 40, -15]],
    ['rotate 90°', [0, 1, -1, 0, 0, 0]],
    ['rotate 45°, scaled', [70.71, 70.71, -70.71, 70.71, 10, 20]],
    ['flipped vertically', [500, 0, 0, -700, 0, 700]],
    ['flipped horizontally', [-500, 0, 0, 700, 500, 0]],
    ['skewed', [300, 25, -40, 400, 12, 8]],
];

const POINTS = [[0, 0], [1, 1], [0.5, 0.25], [-0.3, 1.7], [1000, -250]];

test('multiplyMatrices composes outer∘inner, applying inner first', () => {
    // The property the extractor and the text layer are both built on: mapping
    // a point through the composition must equal mapping it through the two in
    // turn. If the argument order is ever "corrected", this is what catches it.
    for (const [outerName, outer] of PLACEMENTS) {
        for (const [innerName, inner] of PLACEMENTS) {
            const composed = multiplyMatrices(outer, inner);
            for (const point of POINTS) {
                closePoint(
                    apply(composed, point),
                    apply(outer, apply(inner, point)),
                    `${outerName} ∘ ${innerName} at [${point}]`,
                );
            }
        }
    }
});

test('multiplyMatrices leaves identity neutral on both sides', () => {
    for (const [name, m] of PLACEMENTS) {
        multiplyMatrices(IDENTITY, m).forEach((v, i) => close(v, m[i], `identity ∘ ${name}`));
        multiplyMatrices(m, IDENTITY).forEach((v, i) => close(v, m[i], `${name} ∘ identity`));
    }
});

test('multiplyMatrices does not commute', () => {
    // Guards the guard: if composition ever became commutative, the test above
    // would pass with the arguments swapped and stop meaning anything.
    const rotate = [0, 1, -1, 0, 0, 0];
    const translate = [1, 0, 0, 1, 100, 0];
    assert.notDeepEqual(
        multiplyMatrices(rotate, translate),
        multiplyMatrices(translate, rotate),
    );
});

test('invertMatrix undoes a placement, rotations and flips included', () => {
    for (const [name, m] of PLACEMENTS) {
        const inverse = invertMatrix(m);
        assert.ok(inverse, `${name} should be invertible`);
        for (const point of POINTS) {
            closePoint(apply(inverse, apply(m, point)), point, `${name} round trip at [${point}]`);
        }
    }
});

test('invertMatrix returns null rather than infinities for a degenerate placement', () => {
    // collectTextItems bails on null. Anything else — NaNs, Infinities — would
    // sail through the bounds check below it and drop or misplace every item.
    assert.equal(invertMatrix([0, 0, 0, 0, 0, 0]), null, 'all zeroes');
    assert.equal(invertMatrix([1, 2, 2, 4, 0, 0]), null, 'collinear columns');
    assert.equal(invertMatrix([0, 0, 0, 0, 10, 20]), null, 'translation only');
    assert.equal(invertMatrix([Infinity, 0, 0, 1, 0, 0]), null, 'non-finite determinant');
    assert.equal(invertMatrix([NaN, 0, 0, 1, 0, 0]), null, 'NaN determinant');
});

test('paintedSize measures the sides, not the diagonal', () => {
    // The whole reason for the column norms. A 45° placement is where taking
    // the diagonal, or reading a and d straight off, gives the wrong answer —
    // and a wrong painted size feeds coverage, which is what decides whether a
    // page has a scan on it at all.
    const side = 400;
    const diagonal = side / Math.SQRT2;
    const rotated = [diagonal, diagonal, -diagonal, diagonal, 0, 0];
    const { width, height } = paintedSize(rotated);
    close(width, side, '45° width');
    close(height, side, '45° height');
});

test('paintedSize reports a flipped placement as positive', () => {
    // Flips are routine in scans, and a negative size makes coverage negative,
    // which fails the coverage floor and silently drops the page
    const { width, height } = paintedSize([-500, 0, 0, -700, 500, 700]);
    close(width, 500, 'flipped width');
    close(height, 700, 'flipped height');
});

test('paintedSize ignores translation', () => {
    const { width, height } = paintedSize([200, 0, 0, 300, 999, -999]);
    close(width, 200, 'width');
    close(height, 300, 'height');
});
