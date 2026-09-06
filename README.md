# Shelf — EPUB Viewer

A quiet, browser-only EPUB reader with English–Chinese translation, adjustable typography, narration, and a personal notebook.

**[Open the viewer](https://namingisnothard.github.io/epub-viewer/)**

## Bring your own book

Choose **Upload EPUB**, or drag `.epub` files onto the page. Single files open immediately; multiple files appear in the current tab's book list. Files must be non-empty EPUBs up to 100 MB each. Invalid, oversized, or unsupported encrypted publications are rejected. Identical files reuse their book identity and reading progress.

**Your books stay on your device.** Files are opened locally in browser memory, never sent to GitHub or an application server. The viewer starts empty and includes no publications, covers, catalog, or links to books on anyone's computer. Reopen the same file after refreshing the page to resume its browser-saved position and notes.

## Reading

- **中/EN** opens translation controls above the page. Translate a chapter or selected passage in either direction. Bilingual mode shows a continuous English column on the left and Chinese column on the right, with shared scrolling. **仅看原文** restores the original layout.
- **Aa** adjusts fonts, size, spacing, alignment, colors, paper texture, canvas width, columns, and scrolling or pagination. Quiet, newspaper, leather, and Kindle-style scenes are included.
- Select source text to highlight, underline, strike through, or comment. The notebook also holds bookmarks, notes, and sketches.
- **♫** uses browser speech synthesis, with voice and speed controls and sentence/word navigation.
- **Create my EPUB** downloads a personalized copy with reading styles and a notebook. It preserves the original publication's resources. Translation and generated speech are not included in the export.

With the reading area focused, use arrow keys to move through the text, **[ / ]** to change chapters, **B** to bookmark, **F** for focus mode, and **Escape** to leave focus mode or close the reader.

## Browser support and storage

The reader needs a modern browser with Web Crypto, Blob URLs, and standard DOM APIs. Translation additionally needs the native [Translator API](https://developer.chrome.com/docs/ai/translator-api), available in supported desktop Chrome browsers on HTTPS or localhost. The first translation may download language models; text translation runs on device. Unsupported browsers can still read EPUBs and see an availability message for translation. Narration voices and whether they use online services depend on the browser and operating system.

Progress, appearance, and annotations are saved in browser storage for the same origin. Translation results last until changing chapters or closing the reader. EPUB files and extracted images are held only in the current tab's memory. Large books may require substantial browser memory.

The reader displays sanitized, reflowed EPUB content. Embedded scripts and remote images are excluded from the reading page. Complex fixed-layout books can differ from their original layout. Standard ZIP EPUB archives are supported; multi-volume ZIP and ZIP64 archives are not supported.

## Run locally

The deployed site needs no setup or backend. For local development, Python 3.9+ can serve the same static files:

```sh
python3 scripts/serve.py
```

Open **http://127.0.0.1:3000**. Use `--port 3001` for another port. The server only serves application assets, binds to `127.0.0.1`, and has no upload endpoint or folder scanning.

## Checks

```sh
node --check app.js
node --check reader.js
node --check browser-epub.js
node --test scripts/test_*.cjs
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts -p 'test_*.py' -v
```

For full browser integration checks:

```sh
python3 scripts/serve.py --test
```

Open **http://127.0.0.1:3000/tests/browser.html**. The checks generate small synthetic EPUBs in memory and exercise parsing, passive markup, images, deduplication, invalid files, bilingual layout, annotations' text offsets, personalized export, and the actual reader. No personal books are required.

## Dependencies and hosting

The viewer uses a vendored copy of [JSZip 3.10.1](https://github.com/Stuk/jszip/tree/v3.10.1), distributed under its [MIT license](vendor/JSZip-LICENSE.md). No CDN or package installation is required at runtime.

GitHub Pages publishes the static files from the root of `main`; `.nojekyll` disables Jekyll processing. All URLs are relative so the viewer works under `/epub-viewer/` as well as on localhost.
