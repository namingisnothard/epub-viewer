"""The optional local server exposes only static application assets."""
import io
import unittest
from unittest.mock import patch
import serve

class Socket:
    def __init__(self, request):
        self.request = io.BytesIO(request)
        self.output = bytearray()
    def makefile(self, *args):
        return self.request
    def sendall(self, data):
        self.output.extend(data)

def request(path, method='GET'):
    socket = Socket(f'{method} {path} HTTP/1.1\r\nHost: localhost:3000\r\n\r\n'.encode())
    with patch.object(serve.Handler, 'log_message'):
        serve.Handler(socket, ('127.0.0.1', 12345), None)
    head, _, body = bytes(socket.output).partition(b'\r\n\r\n')
    return int(head.split()[1]), body

class ServerTests(unittest.TestCase):
    def test_only_application_assets_are_served(self):
        for path in ['/', '/browser-epub.js', '/vendor/jszip.min.js', '/reader.js?v=4']:
            self.assertEqual(request(path)[0], 200)
        self.assertEqual(request('/index.html', 'HEAD'), (200, b''))
    def test_no_books_catalog_or_private_source_routes(self):
        for path in ['/api/library','/api/upload','/book.epub','/library-data.js','/assets/covers/private.jpg','/.git/config','/scripts/serve.py','/%2e%2e/index.html']:
            for method in ['GET','HEAD']:
                with self.subTest(path=path, method=method):
                    self.assertEqual(request(path, method)[0],404)
        self.assertEqual(request('/api/upload','POST')[0],501)

if __name__ == '__main__':
    unittest.main()
