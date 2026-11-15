"""Static server for Lighthouse runs that compresses like the real host (GitHub Pages serves text with gzip).

python3 -m http.server sends index.html uncompressed (236 KB), which no real visitor gets; this sends the same
files with Content-Encoding: gzip when the browser asks for it. Usage: python3 perf/serve_gzip.py [port]
"""

import gzip
import http.server
import pathlib
import sys

ROOT = pathlib.Path(__file__).parents[1]
TEXT = {".html", ".js", ".json", ".svg", ".css", ".webmanifest"}


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(ROOT), **k)

    def log_message(self, *a):
        pass

    def do_GET(self):
        path = pathlib.Path(self.translate_path(self.path.split("?")[0]))
        if path.is_dir():
            path = path / "index.html"
        if path.suffix in TEXT and path.is_file() and "gzip" in self.headers.get("Accept-Encoding", ""):
            body = gzip.compress(path.read_bytes(), 6)
            self.send_response(200)
            self.send_header("Content-Type", self.guess_type(str(path)))
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "max-age=600")
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()


http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 4181), H).serve_forever()
