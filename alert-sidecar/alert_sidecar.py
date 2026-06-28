#!/usr/bin/env python3
# alert_sidecar.py — bearer-authenticated push API for critical alerts.
# Zero third-party deps. Owns the alert set: validates, persists atomically
# (temp + os.replace under a lock), and serves the current list as JSON.
import hmac, json, os, re, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

TOKEN = os.environ.get("ALERT_API_TOKEN", "").strip()
ALERTS_FILE = os.environ.get("ALERTS_FILE", "/data/alerts.json")
PORT = int(os.environ.get("ALERT_PORT", "8090"))
MAX_ACTIVE = int(os.environ.get("ALERT_MAX_ACTIVE", "20"))
KEY_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")
_lock = threading.Lock()


def now_ms():
    return int(time.time() * 1000)


def _read():
    try:
        with open(ALERTS_FILE) as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (FileNotFoundError, ValueError, OSError):
        return []


def _write_atomic(items):
    d = os.path.dirname(ALERTS_FILE) or "."
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".alerts.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(items, f)
        os.replace(tmp, ALERTS_FILE)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def validate_alert(body):
    if not isinstance(body, dict):
        return None, "body must be a JSON object"
    key = body.get("key")
    if not isinstance(key, str) or not KEY_RE.match(key):
        return None, "key required, [A-Za-z0-9_.-]{1,64}"
    sev = body.get("severity", "critical")
    if sev not in ("warning", "critical"):
        return None, "severity must be warning|critical"
    title = body.get("title")
    if not isinstance(title, str) or not (1 <= len(title) <= 80):
        return None, "title required, 1..80 chars"
    msg = body.get("message")
    if not isinstance(msg, str) or not (1 <= len(msg) <= 240):
        return None, "message required, 1..240 chars"
    target = body.get("target", "all")
    if not isinstance(target, str) or len(target) > 64:
        return None, "target must be a string <=64 chars"
    return {"key": key, "severity": sev, "title": title,
            "message": msg, "target": target}, None


def upsert(alert):
    with _lock:
        items = [a for a in _read() if a.get("key") != alert["key"]]
        if len(items) >= MAX_ACTIVE:
            return None
        items.append(dict(alert, ts=now_ms()))
        _write_atomic(items)
        return len(items)


def clear(key):
    with _lock:
        items = _read()
        kept = [a for a in items if a.get("key") != key]
        changed = len(kept) != len(items)
        if changed:
            _write_atomic(kept)
        return changed


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # quiet

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _auth(self):
        # None -> token unset (fail closed); True/False -> bearer match.
        if not TOKEN:
            return None
        return hmac.compare_digest(self.headers.get("Authorization", ""), f"Bearer {TOKEN}")

    def _guard(self):
        a = self._auth()
        if a is None:
            self._json(503, {"error": "ALERT_API_TOKEN not set"})
            return False
        if not a:
            self._json(401, {"error": "unauthorized"})
            return False
        return True

    def _body(self):
        try:
            n = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            n = 0
        raw = self.rfile.read(n) if n > 0 else b"{}"
        try:
            return json.loads(raw or b"{}")
        except ValueError:
            return None

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/health":
            return self._json(200, {"ok": True})
        if path == "/alerts.json":
            return self._json(200, _read())
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        if not self._guard():
            return
        path = urlparse(self.path).path
        body = self._body()
        if body is None:
            return self._json(400, {"error": "invalid JSON"})
        if path == "/api/alert":
            alert, err = validate_alert(body)
            if err:
                return self._json(400, {"error": err})
            count = upsert(alert)
            if count is None:
                return self._json(409, {"error": "too many active alerts"})
            return self._json(200, {"ok": True, "count": count})
        if path == "/api/alert/clear":
            key = body.get("key")
            if not isinstance(key, str) or not KEY_RE.match(key):
                return self._json(400, {"error": "key required"})
            return self._json(200, {"ok": True, "cleared": clear(key)})
        return self._json(404, {"error": "not found"})

    def do_DELETE(self):
        if not self._guard():
            return
        if urlparse(self.path).path != "/api/alert":
            return self._json(404, {"error": "not found"})
        key = (parse_qs(urlparse(self.path).query).get("key") or [""])[0]
        if not KEY_RE.match(key or ""):
            return self._json(400, {"error": "key required"})
        return self._json(200, {"ok": True, "cleared": clear(key)})


def main():
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
