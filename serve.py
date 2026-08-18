#!/usr/bin/env python3
"""Dev static server with SPA fallback.

Vault is one index.html with client-side clean-URL routing (/portfolio,
/calc, ...). Plain `python3 -m http.server` returns a bare 404 for those
paths, so refreshing on any route but `/` shows a blank error page locally —
even though production is fine (GitHub Pages bounces through 404.html).

This server mirrors production: a request for a path that isn't a real file
falls back to index.html, letting the in-app router resolve the route. Real
files (assets, data, other .html pages) are still served directly.

Usage: python3 serve.py [port]   (default 4173)
"""
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class SPARequestHandler(SimpleHTTPRequestHandler):
    def send_head(self):
        path = self.translate_path(self.path)
        # Only fall back for "clean route" requests: no file on disk, not a
        # directory, and not an explicit asset (has no extension / isn't found).
        if not os.path.exists(path) and not os.path.isdir(path):
            _, ext = os.path.splitext(path)
            if not ext:  # a route like /portfolio, not a missing asset.py
                self.path = '/index.html'
        return super().send_head()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 4173
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    httpd = ThreadingHTTPServer(('', port), SPARequestHandler)
    print(f'Vault dev server (SPA fallback) → http://localhost:{port}')
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        httpd.shutdown()
