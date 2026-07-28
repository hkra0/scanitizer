// 2D affine matrices in PDF's own layout: [a, b, c, d, e, f], applied to row
// vectors as [x y 1] * [[a b 0] [c d 0] [e f 1]].
//
// Shared by the extractor, which maps page space into an image's unit square,
// and the text layer, which maps that unit square back onto a new page.

/**
 * Compose two matrices: the result applies `inner` first, then `outer`.
 * This is the order PDF's `cm` operator wants — CTM' = cm × CTM.
 */
export function multiplyMatrices(outer, inner) {
    return [
        outer[0] * inner[0] + outer[2] * inner[1],
        outer[1] * inner[0] + outer[3] * inner[1],
        outer[0] * inner[2] + outer[2] * inner[3],
        outer[1] * inner[2] + outer[3] * inner[3],
        outer[0] * inner[4] + outer[2] * inner[5] + outer[4],
        outer[1] * inner[4] + outer[3] * inner[5] + outer[5],
    ];
}

// null when the matrix is singular — a degenerate placement nothing can be
// mapped through
export function invertMatrix(m) {
    const det = m[0] * m[3] - m[1] * m[2];
    if (!det || !Number.isFinite(det)) return null;
    return [
        m[3] / det,
        -m[1] / det,
        -m[2] / det,
        m[0] / det,
        (m[2] * m[5] - m[3] * m[4]) / det,
        (m[1] * m[4] - m[0] * m[5]) / det,
    ];
}

// The side lengths of the parallelogram the unit square is painted into.
// Taking the column norms rather than the diagonal keeps this correct for
// rotated and flipped placements, which are common in scans.
export function paintedSize(m) {
    return {
        width: Math.hypot(m[0], m[1]),
        height: Math.hypot(m[2], m[3]),
    };
}
