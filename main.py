"""Local development server for the DeepSeek streaming chat bot.

Run:
    python main.py

The browser app can call DeepSeek directly. For browsers/environments where the
DeepSeek API does not expose CORS, the app also supports a same-origin streaming
proxy at /proxy/*. The app state is saved to ./data/app-state.json by default so
multiple devices on the same LAN can share sessions, settings, cards, presets,
world books, and API configuration.
"""

from __future__ import annotations

import http.client
import json
import mimetypes
import os
import socket
import threading
from pathlib import Path
from socketserver import ThreadingMixIn
from http.server import SimpleHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
WEB_ROOT = ROOT / "web"
DATA_ROOT = Path(os.environ.get("CHATBOT_DATA_DIR", ROOT / "data")).resolve()
STATE_FILE = Path(os.environ.get("CHATBOT_STATE_FILE", DATA_ROOT / "app-state.json")).resolve()
DEFAULT_HOST = os.environ.get("HOST", "0.0.0.0")
DEFAULT_PORT = int(os.environ.get("PORT", "8000"))
MAX_STATE_BODY_BYTES = int(os.environ.get("CHATBOT_MAX_STATE_BYTES", str(80 * 1024 * 1024)))
STATE_LOCK = threading.Lock()


class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


class StateConflictError(Exception):
    def __init__(self, current: dict):
        super().__init__("State has been updated by another client")
        self.current = current


class ChatBotHandler(SimpleHTTPRequestHandler):
    server_version = "DeepSeekChatBot/1.0"

    def translate_path(self, path: str) -> str:  # noqa: D401 - inherited API
        """Serve files from ./web instead of the repository root."""
        parsed = urlparse(path)
        clean_path = parsed.path.lstrip("/") or "index.html"
        candidate = (WEB_ROOT / clean_path).resolve()
        if WEB_ROOT not in candidate.parents and candidate != WEB_ROOT:
            return str(WEB_ROOT / "index.html")
        if candidate.is_dir():
            candidate = candidate / "index.html"
        return str(candidate)

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self) -> None:  # noqa: N802 - inherited API
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self._send_json({"ok": True})
            return
        if parsed.path == "/api/state":
            self._handle_get_state()
            return
        super().do_GET()

    def do_OPTIONS(self) -> None:  # noqa: N802 - inherited API
        if self.path.startswith("/proxy/"):
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", self.headers.get("Origin", ""))
            self.send_header("Access-Control-Allow-Headers", "content-type, x-api-key, x-target-url")
            self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
            self.end_headers()
            return
        self.send_error(404)

    def do_POST(self) -> None:  # noqa: N802 - inherited API
        parsed = urlparse(self.path)
        if parsed.path == "/api/state":
            self._handle_save_state()
            return
        if parsed.path.startswith("/proxy/"):
            self._proxy_deepseek()
            return
        self.send_error(404, "Unknown endpoint")

    def _send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _handle_get_state(self) -> None:
        try:
            payload = read_state_file()
            self._send_json(payload)
        except Exception as exc:  # pragma: no cover - local safety net
            self._send_json({"error": f"Failed to read state: {exc}"}, 500)

    def _handle_save_state(self) -> None:
        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
        except ValueError:
            self._send_json({"error": "Invalid Content-Length"}, 400)
            return
        if length <= 0:
            self._send_json({"error": "Empty request body"}, 400)
            return
        if length > MAX_STATE_BODY_BYTES:
            self._send_json({"error": f"State payload is too large. Limit: {MAX_STATE_BODY_BYTES} bytes"}, 413)
            return

        try:
            raw = self.rfile.read(length)
            payload = json.loads(raw.decode("utf-8"))
            data = payload.get("data") if isinstance(payload, dict) and "data" in payload else payload
            force = bool(payload.get("force")) if isinstance(payload, dict) else False
            base_revision = None if force else (payload.get("baseRevision") if isinstance(payload, dict) else None)
            saved = write_state_file(data, expected_revision=base_revision)
            self._send_json(saved)
        except json.JSONDecodeError as exc:
            self._send_json({"error": f"Invalid JSON: {exc}"}, 400)
        except StateConflictError as exc:
            self._send_json({"error": str(exc), "conflict": True, "current": exc.current}, 409)
        except Exception as exc:  # pragma: no cover - local safety net
            self._send_json({"error": f"Failed to save state: {exc}"}, 500)

    def _proxy_deepseek(self) -> None:
        length = int(self.headers.get("Content-Length", "0") or "0")
        body = self.rfile.read(length)
        api_key = self.headers.get("x-api-key", "").strip()
        target_url = self.headers.get("x-target-url", "").strip()

        if not api_key:
            self._send_json({"error": "Missing x-api-key header"}, 401)
            return
        if not target_url:
            self._send_json({"error": "Missing x-target-url header"}, 400)
            return

        parsed = urlparse(target_url)
        if parsed.scheme != "https" or not parsed.netloc:
            self._send_json({"error": "Only https target URLs are allowed"}, 400)
            return

        # Keep the proxy intentionally small and transparent. It is designed for
        # a same-origin local GUI, not for public deployment.
        path = parsed.path or "/"
        if parsed.query:
            path += f"?{parsed.query}"

        upstream_headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream, application/json",
            "User-Agent": "DeepSeekChatBotLocal/1.0",
        }

        conn = http.client.HTTPSConnection(parsed.netloc, timeout=120)
        try:
            conn.request("POST", path, body=body, headers=upstream_headers)
            resp = conn.getresponse()
            content_type = resp.getheader("Content-Type") or "application/octet-stream"

            self.send_response(resp.status, resp.reason)
            self.send_header("Content-Type", content_type)
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.end_headers()

            while True:
                chunk = resp.read(8192)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
        except Exception as exc:  # pragma: no cover - safety net for local server
            try:
                self._send_json({"error": f"Proxy error: {exc}"}, 502)
            except Exception:
                pass
        finally:
            conn.close()

    def guess_type(self, path: str) -> str:  # noqa: D401 - inherited API
        """Add common modern MIME types for static assets."""
        if path.endswith(".js"):
            return "text/javascript"
        if path.endswith(".css"):
            return "text/css"
        return mimetypes.guess_type(path)[0] or "application/octet-stream"


def main() -> None:
    DATA_ROOT.mkdir(parents=True, exist_ok=True)
    os.chdir(WEB_ROOT)
    server = ThreadingHTTPServer((DEFAULT_HOST, DEFAULT_PORT), ChatBotHandler)
    print(f"DeepSeek Chat Bot is listening on {DEFAULT_HOST}:{DEFAULT_PORT}")
    print(f"Server-side shared state: {STATE_FILE}")
    print("Open one of these URLs:")
    for url in get_access_urls(DEFAULT_PORT):
        print(f"  - {url}")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
    finally:
        server.server_close()


def get_access_urls(port: int) -> list[str]:
    """Return browser-usable URLs.

    0.0.0.0 is a bind/listen address, not a good address to type into a
    browser. Show loopback plus likely LAN addresses instead.
    """
    urls = [f"http://127.0.0.1:{port}", f"http://localhost:{port}"]
    seen = set(urls)

    candidates: set[str] = set()
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, family=socket.AF_INET):
            candidates.add(info[4][0])
    except OSError:
        pass

    # This common UDP trick discovers the preferred outbound LAN address
    # without actually sending packets.
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            candidates.add(sock.getsockname()[0])
    except OSError:
        pass

    for ip in sorted(candidates):
        if ip.startswith("127."):
            continue
        url = f"http://{ip}:{port}"
        if url not in seen:
            urls.append(url)
            seen.add(url)
    return urls


def read_state_file() -> dict:
    with STATE_LOCK:
        if not STATE_FILE.exists():
            return {"exists": False, "updatedAt": None, "revision": 0, "data": None}
        with STATE_FILE.open("r", encoding="utf-8") as file:
            payload = json.load(file)
        if not isinstance(payload, dict) or "data" not in payload:
            return {
                "exists": True,
                "updatedAt": None,
                "revision": 0,
                "data": payload,
            }
        return {
            "exists": True,
            "updatedAt": payload.get("updatedAt"),
            "revision": int(payload.get("revision") or 0),
            "data": payload.get("data"),
        }


def write_state_file(data: object, expected_revision: int | None = None) -> dict:
    updated_at = current_iso_timestamp()
    with STATE_LOCK:
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        current_revision = 0
        if STATE_FILE.exists():
            try:
                with STATE_FILE.open("r", encoding="utf-8") as file:
                    current_payload = json.load(file)
                if isinstance(current_payload, dict):
                    current_revision = int(current_payload.get("revision") or 0)
            except Exception:
                current_revision = 0
        if expected_revision is not None and int(expected_revision) != current_revision:
            current = {
                "exists": STATE_FILE.exists(),
                "updatedAt": None,
                "revision": current_revision,
                "data": None,
            }
            if STATE_FILE.exists():
                try:
                    with STATE_FILE.open("r", encoding="utf-8") as file:
                        current_payload = json.load(file)
                    if isinstance(current_payload, dict) and "data" in current_payload:
                        current.update({
                            "updatedAt": current_payload.get("updatedAt"),
                            "revision": int(current_payload.get("revision") or current_revision),
                            "data": current_payload.get("data"),
                        })
                    else:
                        current["data"] = current_payload
                except Exception:
                    pass
            raise StateConflictError(current)
        revision = current_revision + 1
        payload = {
            "updatedAt": updated_at,
            "revision": revision,
            "data": data,
        }
        if STATE_FILE.exists():
            backup = STATE_FILE.with_suffix(f"{STATE_FILE.suffix}.bak")
            try:
                backup.write_bytes(STATE_FILE.read_bytes())
            except OSError:
                pass
        tmp = STATE_FILE.with_suffix(f"{STATE_FILE.suffix}.tmp")
        with tmp.open("w", encoding="utf-8") as file:
            json.dump(payload, file, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, STATE_FILE)
    return {"ok": True, "exists": True, "updatedAt": updated_at, "revision": revision}


def current_iso_timestamp() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


if __name__ == "__main__":
    main()
