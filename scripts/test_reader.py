"""Self-contained fixtures: no personal books or external files are required."""
import html
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch
from xml.etree import ElementTree as ET
import serve


def publication(title='A Quiet Page', text='A small story about a garden.', encrypted=False):
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w') as z:
        z.writestr('mimetype', 'application/epub+zip')
        z.writestr('META-INF/container.xml', '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>')
        z.writestr('book.opf', f'<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>{html.escape(title)}</dc:title><dc:creator>Example Author</dc:creator><dc:language>en</dc:language></metadata><manifest><item id="c" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="image" href="image.svg" media-type="image/svg+xml"/></manifest><spine><itemref idref="c"/></spine></package>')
        z.writestr('chapter.xhtml', f'<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter One</title></head><body><h1>A Quiet Page</h1><p>{html.escape(text)}</p><img src="image.svg" alt="A circle"/></body></html>')
        z.writestr('image.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><circle cx="50" cy="50" r="30" fill="green"/></svg>')
        if encrypted:
            z.writestr('META-INF/encryption.xml', '<encryption><EncryptionMethod Algorithm="unsupported"/></encryption>')
    return output.getvalue()


class Socket:
    def __init__(self, request):
        self.request = io.BytesIO(request)
        self.output = bytearray()
    def makefile(self, *args):
        return self.request
    def sendall(self, data):
        self.output.extend(data)


def request(path, method='GET', body=b'', headers=None):
    fields = {'Host':'localhost:3000', 'Content-Length':str(len(body)), **(headers or {})}
    wire = f'{method} {path} HTTP/1.1\r\n' + ''.join(f'{key}: {value}\r\n' for key, value in fields.items()) + '\r\n'
    socket = Socket(wire.encode() + body)
    with patch.object(serve.Handler, 'log_message'):
        serve.Handler(socket, ('127.0.0.1', 12345), None)
    head, _, payload = bytes(socket.output).partition(b'\r\n\r\n')
    return int(head.split()[1]), payload


class ReaderTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.scope = patch.multiple(serve, ROOT=self.root, BOOKS=[])
        self.scope.start()
        serve.read_book.cache_clear()
    def tearDown(self):
        serve.read_book.cache_clear()
        self.scope.stop()
        self.directory.cleanup()

    def test_starts_empty_and_does_not_discover_files(self):
        (self.root/'not-uploaded.epub').write_bytes(publication())
        status, body = request('/api/library')
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {'books':[]})
        self.assertEqual(request('/api/refresh', 'POST')[0], 404)
        imported = serve.import_epub('chosen.epub', publication('Uploaded'))
        self.assertEqual(len(imported['books']), 1)
        self.assertEqual(imported['book']['title'], 'Uploaded')

    def test_static_routes_never_expose_local_or_uploaded_files(self):
        book = serve.import_epub('chosen.epub', publication())['book']
        for path in ['/.git/config', '/README.md', '/scripts/serve.py', '/library-data.js', '/external-metadata.json', '/assets/covers/private.jpg', '/not-uploaded.epub', '/' + book['file'], '/%2e%2e/index.html']:
            for method in ['GET', 'HEAD']:
                with self.subTest(path=path, method=method):
                    self.assertEqual(request(path, method)[0], 404)
        self.assertEqual(request('/')[0], 200)
        self.assertEqual(request('/reader.js?v=3')[0], 200)
        self.assertEqual(request('/index.html', 'HEAD'), (200, b''))

    def test_upload_validates_and_deduplicates_by_content(self):
        payload = publication()
        status, body = request('/api/upload', 'POST', payload, {'X-Filename':'example.epub'})
        self.assertEqual(status, 201)
        first = json.loads(body)['book']
        duplicate = serve.import_epub('renamed.epub', payload)
        self.assertTrue(duplicate['duplicate'])
        self.assertEqual(duplicate['book']['id'], first['id'])
        second = serve.import_epub('example.epub', publication('Another book'))
        self.assertNotEqual(second['book']['id'], first['id'])
        self.assertEqual((self.root/first['file']).read_bytes(), payload)
        for name, data in [('wrong.pdf',payload), ('bad.epub',b'broken'), ('locked.epub',publication(encrypted=True))]:
            with self.subTest(name=name), self.assertRaises(ValueError):
                serve.import_epub(name, data)
        self.assertEqual(len(serve.BOOKS), 2)
        self.assertEqual(len(list(self.root.glob('*.epub'))), 2)

    def test_upload_origin_and_limits(self):
        self.assertEqual(request('/api/upload', 'POST', publication(), {'X-Filename':'a.epub', 'Origin':'https://unrelated.example'})[0], 403)
        self.assertEqual(request('/api/upload', 'POST', b'', {'X-Filename':'a.epub'})[0], 413)
        self.assertEqual(request('/api/upload', 'POST', b'x', {'X-Filename':'a.epub','Content-Length':str(serve.MAX_UPLOAD+1)})[0], 413)

    def test_uploaded_chapters_and_resources(self):
        book = serve.import_epub('example.epub', publication())['book']
        status, body = request('/api/book/'+book['id'])
        self.assertEqual(status, 200)
        self.assertIn('A small story', json.loads(body)['chapters'][0]['html'])
        self.assertEqual(request('/api/resource?book='+book['id']+'&path=image.svg')[0], 200)
        self.assertEqual(request('/api/book/unknown')[0], 400)
        self.assertEqual(request('/api/resource?book='+book['id']+'&path=book.opf')[0], 400)

    def test_passive_markup(self):
        parser = serve.ReadingHTML('test', 'OPS/chapter.xhtml')
        parser.feed('<html><body><p onclick="bad()">Hello <em>reader</em></p><script>bad()</script><iframe>bad</iframe><a href="next.xhtml#one">Next</a><img src="image.svg"/><img src="https://tracker.example/x"/></body></html>')
        markup = ''.join(parser.output)
        self.assertIn('<em>reader</em>', markup)
        self.assertIn('data-path="OPS/next.xhtml"', markup)
        self.assertNotIn('bad', markup)
        self.assertNotIn('tracker', markup)

    def test_personal_export_preserves_original(self):
        payload = publication()
        book = serve.import_epub('example.epub', payload)['book']
        data = {'preferences':{'paper':'kraft','texture':75,'theme':'night','size':24,'columns':2}, 'annotations':[{'kind':'note','path':'chapter.xhtml','chapterTitle':'One','text':'A thought & another'}, {'kind':'highlight','quote':'A small story','path':'chapter.xhtml'}]}
        status, exported = request('/api/export/'+book['id'], 'POST', json.dumps(data).encode())
        self.assertEqual(status, 200)
        with zipfile.ZipFile(io.BytesIO(exported)) as z:
            self.assertEqual(z.infolist()[0].filename, 'mimetype')
            self.assertEqual(z.infolist()[0].compress_type, zipfile.ZIP_STORED)
            opf, package = serve.package(z)
            for item in package.find('{*}manifest'):
                self.assertIn(serve.resolve(opf,item.get('href')), z.namelist())
            css = z.read(next(name for name in z.namelist() if name.endswith('/reading.css')))
            self.assertIn(b'24.0px', css)
            self.assertIn(b'#19241f', css)
            self.assertTrue(any(name.endswith('/paper.svg') for name in z.namelist()))
            notebook = ET.fromstring(z.read(next(name for name in z.namelist() if name.endswith('/notebook.xhtml'))))
            self.assertIn('A thought & another', ''.join(notebook.itertext()))
            with zipfile.ZipFile(io.BytesIO(payload)) as original:
                self.assertEqual(z.read('image.svg'), original.read('image.svg'))
        self.assertEqual((self.root/book['file']).read_bytes(), payload)


if __name__ == '__main__':
    unittest.main()
