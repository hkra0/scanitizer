// Half-block bitmap font: 3 cols x 6 pixel rows per glyph, packed into 3
// text rows (█ = both halves, ▀ = upper, ▄ = lower)
// Lowercase: the x-height sits in the lower two rows, the top row carries
// only the ascender of 't' and the dot of 'i'
const GLYPHS = {
    s: ['   ', '█▀▀', '▄▄█'],
    c: ['   ', '█▀▀', '█▄▄'],
    a: ['   ', '▀▀█', '█▄█'], // flat top + right stem, so it doesn't read as 'o'
    n: ['   ', '█▀█', '█ █'],
    i: ['▀', '█', '█'],
    t: [' █ ', '▀█▀', ' █▄'],
    z: ['   ', '▀▀█', '▄█▄'],
    e: ['   ', '███', '█▄▄'],
    r: ['  ', '█▀', '█ '],
};

const WORD = 'scanitizer';

export const LOGO = [0, 1, 2].map((row) =>
    WORD.split('').map((ch) => GLYPHS[ch][row]).join(' ')
);

// Column span of the accented 'c', accounting for the one-column gaps
export const LOGO_C = WORD.slice(0, WORD.indexOf('c'))
    .split('').reduce((n, ch) => n + GLYPHS[ch][0].length + 1, 0);

export const LOGO_C_END = LOGO_C + GLYPHS.c[0].length;
