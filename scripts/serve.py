#!/usr/bin/env python3
"""Upload-only EPUB viewer. No directory scanning or bundled publications."""
from __future__ import annotations
import argparse
import hashlib
import html
import io
import json
import mimetypes
import posixpath
import re
import threading
import zipfile
from datetime import datetime, timezone
from functools import lru_cache
from html.parser import HTMLParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlsplit
from xml.etree import ElementTree as ET
import tempfile

APP_ROOT = Path(__file__).resolve().parent.parent
UPLOADS = tempfile.TemporaryDirectory(prefix="shelf-uploads-")
ROOT = Path(UPLOADS.name)

def clean_markup(value):
    return html.unescape(re.sub(r"<[^>]+>", " ", value)).strip()

OPF = 'http://www.idpf.org/2007/opf'
XHTML = 'http://www.w3.org/1999/xhtml'
ET.register_namespace('', OPF)
ET.register_namespace('dc', 'http://purl.org/dc/elements/1.1/')
LOCK = threading.Lock()
BOOKS = []


def package(z):
    container = ET.fromstring(z.read('META-INF/container.xml'))
    path = container.find('.//{*}rootfile').get('full-path')
    return path, ET.fromstring(z.read(path))


def resolve(base, href):
    return posixpath.normpath(posixpath.join(posixpath.dirname(base), unquote(urlsplit(href).path)))


class ReadingHTML(HTMLParser):
    """Allow only passive book markup; never execute embedded publication code."""
    allowed = set('p div span h1 h2 h3 h4 h5 h6 em strong b i u s small sup sub blockquote pre code ul ol li dl dt dd table thead tbody tfoot tr th td caption hr br img a figure figcaption section article aside ruby rt rp'.split())
    void = {'br', 'hr', 'img'}
    blocked = {'script', 'style', 'iframe', 'object', 'form', 'audio', 'video'}

    def __init__(self, book_id, path):
        super().__init__(convert_charrefs=True)
        self.book_id, self.path = book_id, path
        self.output, self.skip, self.in_body = [], 0, False

    def handle_starttag(self, tag, pairs):
        attrs = dict(pairs)
        if tag == 'body':
            self.in_body = True
            return
        if not self.in_body:
            return
        if tag in self.blocked:
            self.skip += 1
        if self.skip:
            return
        if tag == 'image':  # SVG wrappers commonly contain the cover image.
            tag = 'img'
            attrs['src'] = attrs.get('xlink:href', attrs.get('href', ''))
        if tag not in self.allowed:
            return
        safe = {}
        for key in ('id', 'lang', 'title', 'alt', 'colspan', 'rowspan'):
            if key in attrs:
                safe[key] = ('reader-' if key == 'id' else '') + attrs[key]
        if tag == 'img':
            src = attrs.get('src', '')
            if urlsplit(src).scheme or src.startswith('//'):
                return
            safe['src'] = '/api/resource?' + f'book={self.book_id}&path={quote(resolve(self.path, src), safe="")}'
        if tag == 'a':
            href = attrs.get('href', '')
            parsed = urlsplit(href)
            if parsed.scheme in ('https', 'http'):
                safe.update(href=href, target='_blank', rel='noopener noreferrer')
            elif not parsed.scheme and not href.startswith('//'):
                safe.update(href='#', **{'data-path': resolve(self.path, href) if parsed.path else self.path, 'data-fragment': unquote(parsed.fragment)})
        self.output.append('<' + tag + ''.join(f' {k}="{html.escape(v, quote=True)}"' for k, v in safe.items()) + '>')

    def handle_endtag(self, tag):
        if tag == 'body':
            self.in_body = False
        if not self.in_body:
            return
        if tag in self.blocked:
            self.skip = max(0, self.skip - 1)
            return
        if not self.skip and tag in self.allowed and tag not in self.void:
            self.output.append(f'</{tag}>')

    def handle_data(self, data):
        if self.in_body and not self.skip:
            self.output.append(html.escape(data))


@lru_cache(maxsize=8)
def read_book(book_id, filename, modified):
    with zipfile.ZipFile(ROOT / filename) as z:
        opf_path, root = package(z)
        if 'META-INF/encryption.xml' in z.namelist():
            enc = ET.fromstring(z.read('META-INF/encryption.xml'))
            methods = [e.get('Algorithm', '') for e in enc.findall('.//{*}EncryptionMethod')]
            if any(m not in ('http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC') for m in methods):
                raise ValueError('This EPUB is encrypted and cannot be opened in Shelf.')
        manifest = {n.get('id'): n for n in root.findall('.//{*}manifest/{*}item')}
        labels = {}
        for item in manifest.values():
            if item.get('media-type') == 'application/x-dtbncx+xml':
                nav_path = resolve(opf_path, item.get('href'))
                nav = ET.fromstring(z.read(nav_path))
                for point in nav.findall('.//{*}navPoint'):
                    content, label = point.find('{*}content'), point.find('{*}navLabel/{*}text')
                    if content is not None and label is not None:
                        labels.setdefault(resolve(nav_path, content.get('src', '')), label.text or '')
        chapters = []
        for ref in root.findall('.//{*}spine/{*}itemref'):
            item = manifest.get(ref.get('idref'))
            if item is None or 'html' not in item.get('media-type', ''):
                continue
            path = resolve(opf_path, item.get('href'))
            raw = z.read(path).decode('utf-8-sig', 'replace')
            heading = re.search(r'<h[1-3]\b[^>]*>([\s\S]*?)</h[1-3]>', raw, re.I)
            doc_title = re.search(r'<title\b[^>]*>([\s\S]*?)</title>', raw, re.I)
            title = labels.get(path) or (clean_markup(heading.group(1)) if heading else '') or (clean_markup(doc_title.group(1)) if doc_title else '') or f'Section {len(chapters) + 1}'
            parser = ReadingHTML(book_id, path)
            parser.feed(raw)
            markup = ''.join(parser.output)
            chapters.append({'path': path, 'title': title[:180], 'html': markup, 'words': len(clean_markup(markup).split())})
        if not chapters:
            raise ValueError('No readable chapters were found in this EPUB.')
        return {'chapters': chapters}


def number(value, default, low, high):
    try:
        n = float(value)
        return max(low, min(high, n)) if n == n else default
    except (TypeError, ValueError):
        return default


MAX_UPLOAD = 100 * 1024 * 1024


def import_epub(filename, payload):
    """Validate and import without replacing existing publications or their IDs."""
    global BOOKS
    filename = re.sub(r'[\x00-\x1f<>:"/\\|?*]', '_', filename).strip(' .')
    if not filename.lower().endswith('.epub') or not 0 < len(payload) <= MAX_UPLOAD:
        raise ValueError('Choose a non-empty .epub file up to 100 MB.')
    filename = filename[:-5][:120].strip(' .') + '.epub'
    if filename == '.epub':
        filename = 'Imported book.epub'
    try:
        with zipfile.ZipFile(io.BytesIO(payload)) as z:
            entries = z.infolist()
            if len(entries) > 10000 or sum(n.file_size for n in entries) > 512*1024*1024 or any(n.file_size > MAX_UPLOAD for n in entries):
                raise ValueError('This EPUB is too large when unpacked.')
            if z.read('mimetype').strip() != b'application/epub+zip':
                raise ValueError('This file is not an EPUB publication.')
            opf, root = package(z)
            manifest = {n.get('id'): n for n in root.findall('.//{*}manifest/{*}item')}
            spine = root.findall('.//{*}spine/{*}itemref')
            if not spine or not any(ref.get('idref') in manifest and 'html' in manifest[ref.get('idref')].get('media-type', '') for ref in spine):
                raise ValueError('This EPUB has no readable chapters.')
            for ref in spine:
                item = manifest.get(ref.get('idref'))
                if item is None or resolve(opf, item.get('href', '')) not in z.namelist():
                    raise ValueError('This EPUB is missing a chapter file.')
            if z.testzip():
                raise ValueError('This EPUB contains a damaged file.')
    except (zipfile.BadZipFile, KeyError, ET.ParseError, AttributeError, RuntimeError, NotImplementedError) as exc:
        raise ValueError('This EPUB is damaged or unsupported. Choose another file.') from exc
    book_id = hashlib.sha256(payload).hexdigest()
    with LOCK:
        existing = next((book for book in BOOKS if book['id'] == book_id), None)
        if existing:
            return {'books': BOOKS, 'book': existing, 'duplicate': True}
        target = ROOT / (book_id + '.epub')
        try:
            target.write_bytes(payload)
            chapters = read_book(book_id, target.name, target.stat().st_mtime_ns)['chapters']
            with zipfile.ZipFile(target) as z:
                _, package_root = package(z)
                metadata = package_root.find('{*}metadata')
                def value(name, fallback=''):
                    node = metadata.find('{*}' + name) if metadata is not None else None
                    return ''.join(node.itertext()).strip() if node is not None else fallback
                language = value('language', 'en').lower().split('-')[0]
                book = {'id': book_id, 'file': target.name,
                        'title': value('title', Path(filename).stem) or Path(filename).stem,
                        'author': value('creator', 'Unknown author') or 'Unknown author',
                        'language': {'en':'English', 'zh':'Chinese', 'de':'German', 'fr':'French', 'es':'Spanish', 'ja':'Japanese'}.get(language, language),
                        'wordCount': sum(chapter['words'] for chapter in chapters)}
            BOOKS.append(book)
        except Exception:
            target.unlink(missing_ok=True)
            read_book.cache_clear()
            raise
        return {'books': BOOKS, 'book': book, 'duplicate': False}


def custom_epub(filename, data):
    prefs = data.get('preferences', {})
    fonts = {'literary': 'Georgia, serif', 'classic': 'Palatino, serif', 'clean': 'Arial, sans-serif', 'mono': 'monospace'}
    themes = {'paper': ('#faf7f0', '#283830'), 'white': ('#ffffff', '#202522'), 'sepia': ('#eee0c6', '#493c2a'), 'night': ('#19241f', '#e0e6dc')}
    bg, fg = themes.get(prefs.get('theme'), themes['paper'])
    papers = {'smooth': ('Smooth', bg, fg), 'kraft': ('Kraft paper', '#d6b686', '#382919'), 'cotton': ('Cotton paper', '#f5f1e7', '#343b33'), 'grain': ('Fine-grain paper', '#e5dfd1', '#383a32')}
    paper = prefs.get('paper') if prefs.get('paper') in papers else 'smooth'
    paper_label, paper_bg, paper_fg = papers[paper]
    if prefs.get('theme') != 'night':
        bg, fg = paper_bg, paper_fg
    strength = number(prefs.get('texture'), 55, 0, 100)
    paper_svg = None
    if paper != 'smooth' and strength > 0:
        # Package the same passive vector texture, with opacity baked in for EPUB apps.
        svg = (APP_ROOT / 'assets' / f'paper-{paper}.svg').read_text()
        paper_svg = svg.replace('>', f'><g opacity="{strength / 100:g}">', 1).replace('</svg>', '</g></svg>').encode()
    columns = int(number(prefs.get('columns'), 1, 1, 3))
    experiences = {'quiet': 'Quiet', 'newspaper': 'Newspaper', 'leather': 'Leather book', 'kindle': 'Kindle-style e-ink'}
    experience = experiences.get(prefs.get('experience'), 'Quiet')
    css = f'''html, body {{ background: {bg} !important; color: {fg} !important; }}
body {{ font-family: {fonts.get(prefs.get('font'), fonts['literary'])} !important; font-size: {number(prefs.get('size'), 20, 14, 32)}px !important; line-height: {number(prefs.get('line'), 1.8, 1.3, 2.4)} !important; max-width: {number(prefs.get('width'), 680, 440, 1600)}px; margin: auto !important; padding: 1.5em !important; }}
p, li, blockquote {{ font-family: inherit !important; font-size: 1em !important; line-height: inherit !important; color: inherit !important; letter-spacing: {number(prefs.get('spacing'), 0, 0, 2)}px !important; text-align: {'justify' if prefs.get('align') == 'justify' else 'left'} !important; }}
p {{ margin-top: 0; margin-bottom: {number(prefs.get('paragraph'), 1, 0.3, 2)}em !important; }}
img, svg {{ max-width: 100%; height: auto; }} a {{ color: inherit; }} blockquote {{ border-left: 2px solid #bd815e; padding-left: 1em; }}
body {{ column-count: {columns}; column-gap: 2em; }}
body.shelf-notebook {{ column-count: 1; }}
@media (max-width: 600px) {{ body {{ column-count: 1; }} }}
.shelf-mark-highlight {{ background: #ebd79b; color: #283830; }}
.shelf-mark-underline {{ text-decoration: underline; text-underline-offset: .2em; }}
.shelf-mark-wavy {{ text-decoration: underline; text-decoration-style: wavy; text-underline-offset: .22em; }}
.shelf-mark-strikethrough {{ text-decoration: line-through; }}'''
    if paper_svg:
        css += '\nbody { background-image: url("paper.svg") !important; background-repeat: repeat !important; }'
    with zipfile.ZipFile(ROOT / filename) as src:
        opf_path, root = package(src)
        base = posixpath.dirname(opf_path)
        # Unique directory avoids overwriting any publication resource.
        folder = 'shelf-personal'
        while any(n.startswith(posixpath.join(base, folder) + '/') for n in src.namelist()):
            folder += '-copy'
        css_path = posixpath.join(base, folder, 'reading.css')
        note_path = posixpath.join(base, folder, 'notebook.xhtml')
        manifest, spine = root.find('{*}manifest'), root.find('{*}spine')
        ids = {n.get('id') for n in manifest}
        token = 'shelf-personal'
        while any(token + suffix in ids for suffix in ('-css', '-notes', '-paper')):
            token += '-copy'
        original_items = list(manifest)
        ET.SubElement(manifest, f'{{{OPF}}}item', {'id': token+'-css', 'href': folder+'/reading.css', 'media-type': 'text/css'})
        note_item = ET.SubElement(manifest, f'{{{OPF}}}item', {'id': token+'-notes', 'href': folder+'/notebook.xhtml', 'media-type': 'application/xhtml+xml'})
        if paper_svg:
            ET.SubElement(manifest, f'{{{OPF}}}item', {'id': token+'-paper', 'href': folder+'/paper.svg', 'media-type': 'image/svg+xml'})
        ET.SubElement(spine, f'{{{OPF}}}itemref', {'idref': token+'-notes'})
        sections = [f'<h1>My reading notebook</h1><p>Created with Shelf. Your notes, bookmarks, and sketches.</p><p>Reading setup: {experience} · {columns} column(s). Paper: {paper_label} · texture {strength:g}%.</p>']
        valid_paths = {resolve(opf_path, n.get('href', '')) for n in original_items if 'html' in n.get('media-type', '')}
        has_svg = False
        for note in data.get('annotations', [])[:2000]:
            if not isinstance(note, dict):
                continue
            label = html.escape(str(note.get('chapterTitle', 'Reading note'))[:300])
            target = note.get('path', '')
            if target in valid_paths:
                label = f'<a href="{html.escape(quote(posixpath.relpath(target, posixpath.dirname(note_path)), safe="/"))}">{label}</a>'
            sections.append(f'<section><h2>{html.escape(str(note.get("kind", "note")).title())} · {label}</h2>')
            if note.get('quote'):
                style = note.get('markStyle', note.get('kind', 'highlight'))
                style = style if style in ('highlight', 'underline', 'wavy', 'strikethrough') else 'highlight'
                sections.append(f'<blockquote><span class="shelf-mark-{style}">'+html.escape(str(note['quote'])[:10000])+'</span></blockquote>')
            if note.get('text'):
                sections.append('<p>'+html.escape(str(note['text'])[:20000]).replace('\n', '<br/>')+'</p>')
            strokes = note.get('strokes', [])
            if strokes:
                has_svg = True
                sections.append('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 300"><rect width="600" height="300" fill="#faf7f0"/>')
                for stroke in strokes[:1000]:
                    points = ' '.join(f'{number(p[0], 0, 0, 600)},{number(p[1], 0, 0, 300)}' for p in stroke.get('points', [])[:10000] if isinstance(p, list) and len(p) == 2)
                    color = stroke.get('color', '#284c3c')
                    color = color if re.fullmatch(r'#[a-fA-F0-9]{6}', str(color)) else '#284c3c'
                    sections.append(f'<polyline points="{points}" stroke="{color}" fill="none" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>')
                sections.append('</svg>')
            sections.append('</section>')
        if len(sections) == 1:
            sections.append('<p>No annotations yet.</p>')
        if has_svg and root.get('version', '').startswith('3'):
            note_item.set('properties', 'svg')
        notebook = f'<?xml version="1.0" encoding="utf-8"?><html xmlns="{XHTML}"><head><title>My reading notebook</title><link rel="stylesheet" type="text/css" href="reading.css"/></head><body class="shelf-notebook">{"".join(sections)}</body></html>'
        modified = {}
        for item in original_items:
            path = resolve(opf_path, item.get('href', ''))
            if 'html' in item.get('media-type', ''):
                raw = src.read(path).decode('utf-8-sig')
                link = f'<link xmlns="{XHTML}" rel="stylesheet" type="text/css" href="{html.escape(quote(posixpath.relpath(css_path, posixpath.dirname(path)), safe="/"))}"/>'
                raw, count = re.subn(r'</(?:\w+:)?head\s*>', lambda m: link + m.group(0), raw, count=1, flags=re.I)
                if not count:
                    raise ValueError('This EPUB has a chapter without a valid document head.')
                # Make the notebook discoverable in EPUB 3 navigation.
                if 'nav' in item.get('properties', '').split():
                    raw = re.sub(r'(<nav\b[^>]*epub:type=["\']toc["\'][^>]*>[\s\S]*?)(</ol>)', lambda m: m.group(1) + f'<li><a href="{quote(posixpath.relpath(note_path, posixpath.dirname(path)), safe="/")}">My reading notebook</a></li>' + m.group(2), raw, count=1)
                modified[path] = raw.encode()
            elif item.get('media-type') == 'application/x-dtbncx+xml':
                ncx = ET.fromstring(src.read(path))
                navmap = ncx.find('{*}navMap')
                if navmap is not None:
                    ns = navmap.tag.split('}')[0] + '}'
                    orders = [int(n.get('playOrder')) for n in ncx.iter() if (n.get('playOrder') or '').isdigit()]
                    point = ET.SubElement(navmap, ns+'navPoint', {'id': token+'-notes', 'playOrder': str(max(orders, default=0)+1)})
                    label = ET.SubElement(point, ns+'navLabel')
                    ET.SubElement(label, ns+'text').text = 'My reading notebook'
                    ET.SubElement(point, ns+'content', {'src': quote(posixpath.relpath(note_path, posixpath.dirname(path)), safe='/')})
                    modified[path] = ET.tostring(ncx, encoding='utf-8', xml_declaration=True)
        for meta in root.findall('.//{*}meta'):
            if meta.get('property') == 'dcterms:modified':
                meta.text = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        modified.update({opf_path: ET.tostring(root, encoding='utf-8', xml_declaration=True), css_path: css.encode(), note_path: notebook.encode()})
        if paper_svg:
            modified[posixpath.join(base, folder, 'paper.svg')] = paper_svg
        output = io.BytesIO()
        with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as dst:
            dst.writestr('mimetype', 'application/epub+zip', compress_type=zipfile.ZIP_STORED)
            for item in src.infolist():
                if item.filename != 'mimetype' and item.filename not in modified:
                    dst.writestr(item.filename, src.read(item.filename))
            for path, content in modified.items():
                dst.writestr(path, content)
        return output.getvalue()


class Handler(BaseHTTPRequestHandler):
    def do_HEAD(self):
        self.do_GET()

    def respond(self, data, kind='application/json', status=200, filename=None):
        if not isinstance(data, bytes):
            data = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        if kind == 'image/svg+xml':
            self.send_header('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'")
        if filename:
            self.send_header('Content-Disposition', "attachment; filename*=UTF-8''" + quote(filename))
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(data)

    def get_book(self, book_id):
        book = next((b for b in BOOKS if b['id'] == book_id), None)
        if not book:
            raise ValueError('Book not found in this server session. Upload your EPUB again.')
        return book

    def do_GET(self):
        url = urlsplit(self.path)
        try:
            if url.path == '/api/library':
                return self.respond({'books': BOOKS})
            if url.path.startswith('/api/book/'):
                book = self.get_book(url.path.rsplit('/', 1)[-1])
                return self.respond(read_book(book['id'], book['file'], (ROOT/book['file']).stat().st_mtime_ns))
            if url.path == '/api/resource':
                q = parse_qs(url.query)
                book = self.get_book(q.get('book', [''])[0])
                path = q.get('path', [''])[0]
                kind = mimetypes.guess_type(path)[0] or ''
                if not kind.startswith('image/'):
                    raise ValueError('Unsupported image resource.')
                with zipfile.ZipFile(ROOT/book['file']) as z:
                    return self.respond(z.read(path), kind)
            allowed = {'/index.html', '/app.js', '/reader.js', '/narration.js', '/translation.js', '/styles.css', '/reader.css', '/assets/paper-kraft.svg', '/assets/paper-cotton.svg', '/assets/paper-grain.svg'}
            path = '/index.html' if url.path == '/' else url.path
            if path not in allowed:
                return self.send_error(404)
            local = (APP_ROOT / path.lstrip('/')).resolve()
            if not local.is_relative_to(APP_ROOT):
                return self.send_error(404)
            return self.respond(local.read_bytes(), mimetypes.guess_type(path)[0] or 'application/octet-stream')
        except (ValueError, KeyError, OSError, zipfile.BadZipFile, ET.ParseError) as exc:
            return self.respond({'error': str(exc)}, status=400)

    def do_POST(self):
        global BOOKS
        # Same-origin operations only, even when another website targets localhost.
        origin = self.headers.get('Origin')
        if origin and origin != 'http://' + self.headers.get('Host', ''):
            return self.respond({'error': 'Origin not allowed'}, status=403)
        try:
            if self.path == '/api/upload':
                size = int(self.headers.get('Content-Length', 0))
                if not 0 < size <= MAX_UPLOAD:
                    return self.respond({'error': 'Choose a non-empty EPUB up to 100 MB.'}, status=413)
                payload = self.rfile.read(size)
                if len(payload) != size:
                    raise ValueError('The upload was interrupted. Please retry.')
                result = import_epub(unquote(self.headers.get('X-Filename', '')), payload)
                return self.respond(result, status=200 if result['duplicate'] else 201)
            if self.path.startswith('/api/export/'):
                book = self.get_book(self.path.rsplit('/', 1)[-1])
                size = int(self.headers.get('Content-Length', 0))
                if not 0 < size <= 8_000_000:
                    raise ValueError('The notebook is too large to export.')
                data = json.loads(self.rfile.read(size))
                if not isinstance(data, dict) or not isinstance(data.get('preferences', {}), dict) or not isinstance(data.get('annotations', []), list):
                    raise ValueError('Invalid notebook data.')
                output = custom_epub(book['file'], data)
                return self.respond(output, 'application/epub+zip', filename=book['title']+' — My edition.epub')
            self.send_error(404)
        except (ValueError, KeyError, TypeError, OSError, zipfile.BadZipFile, ET.ParseError) as exc:
            self.respond({'error': str(exc)}, status=400)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=3000)
    args = parser.parse_args()
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    print(f'Shelf is ready at http://127.0.0.1:{args.port}', flush=True)
    server.serve_forever()
