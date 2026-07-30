// The few browser globals the pure modules touch on the way in.
//
// `pdf/build.js` and `pdf/extract.js` hold functions that are plain arithmetic,
// but they sit in a module graph that reaches config.js, i18n.js and vendor.js —
// all of which read something off `window` or `document` at import time. So the
// import fails in node long before a test can call anything.
//
// This is a stub, not a DOM: it exists to let the module graph load, and it
// answers every question with the quietest true thing. Nothing here is a
// fixture, and no test should assert against it. Anything that needs a real DOM
// is out of scope for these tests by definition — `terminal.js` and `screens.js`
// are tested by looking at the screen, which is what they are for.
//
// Imported first in every test file, since ES modules evaluate in import order.

globalThis.window = {
    // config.js: prefers-reduced-motion, read once at import
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    // vendor.js: the last chance to notice a script tag settled
    addEventListener() {},
};

globalThis.document = {
    // vendor.js: no tags here, so every library reports as absent — which is
    // the honest answer, and nothing under test needs one
    getElementById: () => null,
    documentElement: {},
};

// i18n.js picks a language from this and writes it back onto <html>
Object.defineProperty(globalThis, 'navigator', {
    value: { languages: ['en'], language: 'en' },
    configurable: true,
});

// settings.js: an empty store, so every setting reports its default
globalThis.localStorage = {
    getItem: () => null,
    setItem() {},
};
