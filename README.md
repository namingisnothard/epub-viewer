# Shelf — EPUB Viewer

A quiet, upload-only EPUB reader with English–Chinese translation, adjustable typography, narration, and a personal notebook. Built with vanilla JavaScript and Python's standard library.

## Run locally

Requires Python 3.9+ and a modern browser. No packages, account, or API key are needed.

```sh
python3 scripts/serve.py
```

Open **http://127.0.0.1:3000**. To use another port:

```sh
python3 scripts/serve.py --port 3001
```

Choose **Upload EPUB**, or drag `.epub` files into the upload area. Single uploads open immediately; multiple uploads appear in the session's book list. Files must be non-empty EPUBs up to 100 MB each. Invalid or unsupported encrypted publications are rejected; identical uploads reuse their book identity and progress.

The viewer starts empty. It does not scan folders, discover books on your computer, load a bundled catalog, or link to local publications. Uploaded files are held in a temporary directory for the running server session. Restarting the server starts a fresh session; upload the same file again to resume its browser-saved reading position.

## Reading

- **中/EN** opens translation controls above the page. Choose English → Chinese or Chinese → English and translate a chapter or selected passage. Bilingual mode shows a continuous English column on the left and Chinese column on the right, with shared scrolling. **仅看原文** restores the original layout.
- **Aa** adjusts fonts, size, spacing, alignment, colors, paper texture, canvas width, columns, and scrolling or pagination. Quiet, newspaper, leather, and Kindle-style scenes are included.
- Select source text to highlight, underline, strike through, or comment. The notebook also holds bookmarks, notes, and sketches.
- **♫** uses browser speech synthesis, with voice and speed controls and sentence/word navigation.
- **Create my EPUB** downloads a personalized copy with reading styles and a notebook. It preserves the original publication. Translation and generated speech are not included in the export.

With the reading area focused, use arrow keys to move through the text, **[ / ]** to change chapters, **B** to bookmark, **F** for focus mode, and **Escape** to leave focus mode or close the reader.

## Translation and storage

Translation uses the browser's native [Translator API](https://developer.chrome.com/docs/ai/translator-api). A supported desktop Chrome browser on localhost or HTTPS is required. The first translation may download language models; subsequent translations run on device. Unsupported browsers show an availability message. Translation quality and available speech voices depend on the browser and operating system.

Progress, appearance, and annotations are saved in browser storage for the same origin. Translation results last until changing chapters or closing the reader. Uploads are shared by browsers connected to the same local server process. This is a personal local application, not a multi-user hosting service; the server binds to `127.0.0.1` only.

The reader displays sanitized, reflowed EPUB content. Embedded scripts and remote images are excluded. Complex fixed-layout books can differ from their original layout.

## Checks

```sh
node --check app.js
node --check reader.js
node --check translation.js
node --test scripts/test_narration.cjs scripts/test_translation.cjs
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts -p 'test_*.py' -v
```

Tests generate their own small EPUBs. No publications, covers, personal metadata, credentials, or machine-specific paths are needed or included. Checks cover upload validation and deduplication, an empty starting catalog, blocked file routes (including HEAD requests), sanitized content, resource loading, export integrity, narration, and translation lifecycle handling.
