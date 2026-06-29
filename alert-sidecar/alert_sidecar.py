#!/usr/bin/env python3
# alert_sidecar.py — bearer-authenticated push API for critical alerts.
# Zero third-party deps. Owns the alert set: validates, persists atomically
# (temp + os.replace under a lock), and serves the current list as JSON.
import hmac, json, os, re, tempfile, threading, time
import urllib.request, urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

TOKEN = os.environ.get("ALERT_API_TOKEN", "").strip()
ALERTS_FILE = os.environ.get("ALERTS_FILE", "/data/alerts.json")
PORT = int(os.environ.get("ALERT_PORT", "8090"))
MAX_ACTIVE = int(os.environ.get("ALERT_MAX_ACTIVE", "20"))
KEY_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")
_lock = threading.Lock()

SNAPSHOT_TOKEN = os.environ.get("SNAPSHOT_TOKEN", "").strip()
SNAPSHOTS_DIR = os.environ.get("SNAPSHOTS_DIR", "/data/snapshots")
SNAPSHOT_MAX_BYTES = int(os.environ.get("SNAPSHOT_MAX_BYTES", str(1024 * 1024)))
SNAPSHOT_RETENTION_DAYS = int(os.environ.get("SNAPSHOT_RETENTION_DAYS", "30"))
SNAPSHOT_MAX_PER_ROOM = int(os.environ.get("SNAPSHOT_MAX_PER_ROOM", "1000"))
# No '.' at all (blocks '.', '..', dotfiles) and must start with an alnum/underscore.
PROFILE_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9 _\-]{0,63}$")
HA_WEBHOOK_URL = os.environ.get("HA_WEBHOOK_URL", "").strip()


def snap_name(ms):
    t = time.gmtime(ms / 1000)
    return time.strftime("%Y%m%d-%H%M%S", t) + "-%03d.jpg" % (ms % 1000)


def prune_room(room_dir):
    try:
        entries = []
        cutoff = time.time() - SNAPSHOT_RETENTION_DAYS * 86400
        for e in os.scandir(room_dir):
            if not e.is_file() or e.name.startswith("."):   # skip in-flight .snap.*.tmp
                continue
            entries.append((e.stat().st_mtime, e.path))
        for mt, path in entries:           # age-based
            if mt < cutoff:
                try: os.unlink(path)
                except OSError: pass
        remaining = [p for mt, p in sorted(entries) if os.path.exists(p)]
        excess = len(remaining) - SNAPSHOT_MAX_PER_ROOM   # count-based (newest kept)
        for path in remaining[:max(0, excess)]:
            try: os.unlink(path)
            except OSError: pass
    except OSError:
        pass


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
    typ = body.get("type")
    if typ is not None and not re.match(r"^[a-z0-9_]{1,32}$", str(typ)):
        return None, "type must match ^[a-z0-9_]{1,32}$"
    out = {"key": key, "severity": sev, "title": title, "message": msg, "target": target}
    if typ is not None:
        out["type"] = typ
    return out, None


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

    def _guard_snapshot(self):
        if not SNAPSHOT_TOKEN:
            self._json(503, {"error": "SNAPSHOT_TOKEN not set"})
            return False
        if not hmac.compare_digest(self.headers.get("Authorization", ""), f"Bearer {SNAPSHOT_TOKEN}"):
            self._json(401, {"error": "unauthorized"})
            return False
        return True

    def _handle_snapshot(self):
        if not self._guard_snapshot():
            return
        if self.headers.get("Content-Type", "").split(";")[0].strip() != "image/jpeg":
            return self._json(415, {"error": "Content-Type must be image/jpeg"})
        try:
            n = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            n = 0
        if n <= 0:
            return self._json(400, {"error": "empty body"})
        if n > SNAPSHOT_MAX_BYTES:
            return self._json(413, {"error": "snapshot too large"})
        profile = (parse_qs(urlparse(self.path).query).get("profile") or ["unknown"])[0]
        if not PROFILE_RE.match(profile):
            return self._json(400, {"error": "bad profile"})
        # Defense in depth: ensure the resolved path stays inside SNAPSHOTS_DIR.
        base = os.path.realpath(SNAPSHOTS_DIR)
        room_dir = os.path.realpath(os.path.join(SNAPSHOTS_DIR, profile))
        if room_dir != base and not room_dir.startswith(base + os.sep):
            return self._json(400, {"error": "bad profile"})
        body = self.rfile.read(n)
        if body[:3] != b"\xff\xd8\xff":   # JPEG SOI marker — reject non-jpeg payloads
            return self._json(415, {"error": "body is not a JPEG"})
        try:
            os.makedirs(room_dir, exist_ok=True)
            name = snap_name(now_ms())
            fd, tmp = tempfile.mkstemp(dir=room_dir, prefix=".snap.", suffix=".tmp")
            with os.fdopen(fd, "wb") as f:
                f.write(body)
            os.replace(tmp, os.path.join(room_dir, name))
            prune_room(room_dir)
            return self._json(200, {"ok": True, "stored": os.path.join(profile, name)})
        except OSError as e:
            return self._json(500, {"error": "store failed: %s" % e})

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

    def _handle_presence(self):
        body = self._body()
        if not isinstance(body, dict):
            return self._json(400, {"error": "bad body"})
        room = body.get("room")
        present = body.get("present")
        if not isinstance(room, str) or not PROFILE_RE.match(room) or not isinstance(present, bool):
            return self._json(400, {"error": "room (profile) + present(bool) required"})
        if not HA_WEBHOOK_URL:
            return self._json(200, {"ok": True, "relayed": False})
        try:
            data = json.dumps({"room": room, "present": present}).encode()
            req = urllib.request.Request(HA_WEBHOOK_URL, data=data,
                                         headers={"Content-Type": "application/json"}, method="POST")
            with urllib.request.urlopen(req, timeout=4):
                pass
            return self._json(200, {"ok": True, "relayed": True})
        except Exception:
            return self._json(200, {"ok": True, "relayed": False})  # HA down -> never error the kiosk

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/health":
            return self._json(200, {"ok": True})
        if path == "/alerts.json":
            return self._json(200, _read())
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/presence":
            return self._handle_presence()
        if path == "/api/snapshot":
            return self._handle_snapshot()
        if not self._guard():
            return
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
