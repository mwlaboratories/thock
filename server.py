#!/usr/bin/env python3
"""thock — minimal static-file server for local dev.

The app stores WAVs directly on the user's filesystem via the
File System Access API; nothing is uploaded. This script just hands
out the HTML/JS/CSS that drives that. For production, deploy the
files to any static host (Vercel, GitHub Pages, S3, ...).
"""
from __future__ import annotations

import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PORT = 8765


class Handler(SimpleHTTPRequestHandler):
    # AudioWorklet modules need a strict JS MIME type
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "application/javascript",
        ".mjs": "application/javascript",
    }

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))


def main() -> None:
    handler = partial(Handler, directory=str(ROOT))
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), handler)
    print(f"thock static files on http://127.0.0.1:{PORT}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstopping")
        srv.server_close()


if __name__ == "__main__":
    main()
