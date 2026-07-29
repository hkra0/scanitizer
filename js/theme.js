// tinyko's tool follows the colour scheme: scissors in light, knife in dark.

const darkScheme = window.matchMedia('(prefers-color-scheme: dark)');

let tool = darkScheme.matches ? '🔪' : '✂️';

export function getTool() {
    return tool;
}

// `callback` runs after `tool` has been updated
export function onSchemeChange(callback) {
    darkScheme.addEventListener('change', (e) => {
        tool = e.matches ? '🔪' : '✂️';
        callback(tool);
    });
}
