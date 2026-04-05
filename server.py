#!/usr/bin/env python3

from __future__ import annotations

import argparse
import functools
import http.server
import socketserver
from pathlib import Path


class StaticHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".wasm": "application/wasm",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve the FractWasm app locally.")
    parser.add_argument("--host", default="127.0.0.1", help="Bind host, default: 127.0.0.1")
    parser.add_argument("--port", type=int, default=8088, help="Bind port, default: 8088")
    args = parser.parse_args()

    root = Path(__file__).resolve().parent
    handler = functools.partial(StaticHandler, directory=str(root))

    with socketserver.TCPServer((args.host, args.port), handler) as httpd:
        print(f"Serving {root} at http://{args.host}:{args.port}")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopping server.")


if __name__ == "__main__":
    main()
