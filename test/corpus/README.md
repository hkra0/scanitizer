# test/corpus

Real PDFs for `test/regression.html` to run against. Nothing here is committed —
the directory is in `.gitignore`, because a regression corpus is documents, and
documents are the one thing this project should never be carrying around.

Put files in, list them, open the harness:

```bash
cd test/corpus && ls *.pdf > list.txt
```

Then serve the repo and click **run test/corpus**:

```bash
python3 -m http.server 4173
```

`http://localhost:4173/test/regression.html`

The list is a plain file so a run is repeatable and reviewable: the same set,
in the same order, every time. Blank lines and `#` comments are skipped.

## What to put in it

The checks compare the output against the input, so the corpus should be things
that are *hard to preserve*, not things that are easy:

- **Documents with structure** — outlines, named destinations, page labels,
  form fields, a tagged structure tree. These are what `pdf/sweep.js` could
  wrongly decide are unreachable, and the harness checks each one survives.
- **TeX output** — heavy cross-referencing and outlines. `ghostscript`,
  `bash` and most `/usr/share/doc` PDFs qualify.
- **Real scans**, ideally CCITT G4 or JBIG2, which are what the extractor is
  for and what the pdf.js version pin is about.
- **Watermarked and stamped files**, so `pdf/strip.js` is exercised rather than
  just present. Expect `warn` on these: text and ink going at the same time as
  a mark is the tool working, and only the file can say whether it took the
  right thing.
- **Mixed documents** — a scan that also contains born-digital pages. The
  harness fails a rebuilt file whose page count changed — the failure a mixed
  document used to pass as a success — unless `keep non-scan pages` was
  switched off, in which case the drop is checked as the configured behaviour.
- **Anything that has ever come out wrong.** A corpus earns its keep by
  accumulating the awkward cases, not by being large.

Some non-personal starting material exists on most macOS machines:
`/usr/share/doc/bash/*.pdf`, `/usr/share/cups/ipptool/*.pdf`,
`/System/Library/ProductDocuments/`, and any `Acknowledgments.pdf` inside
`/Applications`.
