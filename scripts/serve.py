#!/usr/bin/env python3
"""Serve the static viewer locally. EPUB files are handled only in the browser."""
import argparse
import mimetypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
ASSETS = {'index.html', 'app.js', 'styles.css', 'reader.js', 'reader.css', 'narration.js',
          'translation.js', 'browser-epub.js', 'vendor/jszip.min.js',
          'assets/paper-kraft.svg', 'assets/paper-cotton.svg', 'assets/paper-grain.svg'}


class Handler(BaseHTTPRequestHandler):
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        name = urlsplit(self.path).path.removeprefix('/') or 'index.html'
        if name not in ASSETS or not (ROOT / name).resolve().is_relative_to(ROOT):
            return self.send_error(404)
        try:
            data = (ROOT / name).read_bytes()
        except OSError:
            return self.send_error(404)
        self.send_response(200)
        self.send_header('Content-Type', mimetypes.guess_type(name)[0] or 'application/octet-stream')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(data)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=3000)
    parser.add_argument('--test', action='store_true', help='Serve browser integration checks')
    args = parser.parse_args()
    if args.test:
        ASSETS.update({'tests/browser.html', 'tests/browser.js'})
    print(f'Shelf is ready at http://127.0.0.1:{args.port}', flush=True)
    ThreadingHTTPServer(('127.0.0.1', args.port), Handler).serve_forever()
