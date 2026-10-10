"""Static file server for Hamlet that tells browsers to revalidate every file,
so a refresh always picks up the latest game code."""
import http.server
import os
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".webmanifest": "application/manifest+json", ".js": "text/javascript"}

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


if __name__ == "__main__":
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    port = int(os.environ.get("PORT", "8080"))
    bind = os.environ.get("BIND", "127.0.0.1")
    print(f"Hamlet: http://{'localhost' if bind == '127.0.0.1' else bind}:{port}", flush=True)
    http.server.ThreadingHTTPServer((bind, port), NoCacheHandler).serve_forever()
