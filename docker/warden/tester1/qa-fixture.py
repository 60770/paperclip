#!/usr/bin/env python3
from __future__ import annotations

import argparse
import signal
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class QAHandler(BaseHTTPRequestHandler):
    server_version = "Tester1QAFixture/1.0"

    def do_GET(self) -> None:  # noqa: N802
        port = self.server.server_port
        if self.path == "/health":
            self._respond(200, "text/plain; charset=utf-8", b"ok\n")
            return
        if port == 8223 and self.path == "/redirect":
            self.send_response(302)
            self.send_header("Location", "https://example.com/")
            self.end_headers()
            return
        if port == 8223 and self.path == "/":
            self._respond(
                200,
                "text/html; charset=utf-8",
                b"""<!doctype html>
<html lang="it">
  <head><meta charset="utf-8"><title>QA 8223</title></head>
  <body>
    <h1>QA 8223 ready</h1>
    <label for="qa-upload">QA upload</label>
    <input id="qa-upload" aria-label="QA upload" type="file">
  </body>
</html>
""",
            )
            return
        if port == 8224 and self.path == "/":
            self._respond(
                200,
                "text/html; charset=utf-8",
                b"""<!doctype html>
<html lang="it">
  <head><meta charset="utf-8"><title>QA 8224</title></head>
  <body><h1>QA 8224 ready</h1></body>
</html>
""",
            )
            return
        self._respond(404, "text/plain; charset=utf-8", b"not found\n")

    def log_message(self, format: str, *args: object) -> None:
        return

    def _respond(self, status: int, content_type: str, body: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bind", required=True)
    args = parser.parse_args()

    servers = [
        ThreadingHTTPServer((args.bind, port), QAHandler) for port in (8223, 8224)
    ]
    stop = threading.Event()

    def stop_servers(_signum: int, _frame: object) -> None:
        stop.set()

    signal.signal(signal.SIGINT, stop_servers)
    signal.signal(signal.SIGTERM, stop_servers)

    threads = [
        threading.Thread(target=server.serve_forever, daemon=True) for server in servers
    ]
    for thread in threads:
        thread.start()
    print(f"QA fixture ready on {args.bind}:8223/8224", flush=True)
    stop.wait()
    for server in servers:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
