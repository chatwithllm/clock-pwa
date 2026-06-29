import json, os, tempfile, threading, unittest, urllib.request, urllib.error
from http.server import ThreadingHTTPServer

import alert_sidecar as A


class LogicTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.NamedTemporaryFile(suffix=".json", delete=False)
        self.tmp.close()
        A.ALERTS_FILE = self.tmp.name
        A.MAX_ACTIVE = 3
        A.now_ms = lambda: 1000  # deterministic

    def tearDown(self):
        os.unlink(self.tmp.name)

    def test_validate_ok_defaults(self):
        a, err = A.validate_alert({"key": "leak_1", "title": "Leak", "message": "wet"})
        self.assertIsNone(err)
        self.assertEqual(a["severity"], "critical")
        self.assertEqual(a["target"], "all")

    def test_validate_rejects_bad_key(self):
        _, err = A.validate_alert({"key": "bad key!", "title": "x", "message": "y"})
        self.assertIsNotNone(err)

    def test_validate_rejects_bad_severity(self):
        _, err = A.validate_alert({"key": "k", "severity": "boom", "title": "x", "message": "y"})
        self.assertIsNotNone(err)

    def test_validate_rejects_oversized(self):
        _, err = A.validate_alert({"key": "k", "title": "t", "message": "m" * 241})
        self.assertIsNotNone(err)

    def test_upsert_replaces_by_key(self):
        a, _ = A.validate_alert({"key": "k", "title": "a", "message": "1"})
        self.assertEqual(A.upsert(a), 1)
        b, _ = A.validate_alert({"key": "k", "title": "b", "message": "2"})
        self.assertEqual(A.upsert(b), 1)  # replaced, still 1
        items = json.load(open(self.tmp.name))
        self.assertEqual(items[0]["title"], "b")
        self.assertEqual(items[0]["ts"], 1000)

    def test_clear_idempotent(self):
        a, _ = A.validate_alert({"key": "k", "title": "a", "message": "1"})
        A.upsert(a)
        self.assertTrue(A.clear("k"))
        self.assertFalse(A.clear("k"))
        self.assertEqual(json.load(open(self.tmp.name)), [])

    def test_cap_exceeded(self):
        for i in range(3):
            a, _ = A.validate_alert({"key": f"k{i}", "title": "a", "message": "1"})
            self.assertIsNotNone(A.upsert(a))
        a, _ = A.validate_alert({"key": "k3", "title": "a", "message": "1"})
        self.assertIsNone(A.upsert(a))  # cap = 3

    def test_validate_accepts_type(self):
        a, err = A.validate_alert({"key": "k", "title": "t", "message": "m", "type": "water_leak"})
        self.assertIsNone(err)
        self.assertEqual(a["type"], "water_leak")

    def test_validate_default_type_absent(self):
        a, _ = A.validate_alert({"key": "k", "title": "t", "message": "m"})
        self.assertNotIn("type", a)

    def test_validate_rejects_bad_type(self):
        _, err = A.validate_alert({"key": "k", "title": "t", "message": "m", "type": "Bad Type!"})
        self.assertIsNotNone(err)


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.NamedTemporaryFile(suffix=".json", delete=False)
        self.tmp.close()
        A.ALERTS_FILE = self.tmp.name
        A.TOKEN = "secret"
        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), A.Handler)
        self.port = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        os.unlink(self.tmp.name)

    def _get(self, path):
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}{path}") as r:
            return r.status, json.load(r)

    def _post(self, path, body, token="secret"):
        data = json.dumps(body).encode()
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}", data=data, method="POST")
        if token is not None:
            req.add_header("Authorization", f"Bearer {token}")
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.load(r)
        except urllib.error.HTTPError as e:
            with e:
                return e.code, json.load(e)

    def test_health_no_auth(self):
        code, _ = self._get("/api/health")
        self.assertEqual(code, 200)

    def test_post_requires_bearer(self):
        code, _ = self._post("/api/alert", {"key": "k", "title": "t", "message": "m"}, token="wrong")
        self.assertEqual(code, 401)

    def test_post_and_get_alerts(self):
        code, body = self._post("/api/alert", {"key": "leak", "title": "Leak", "message": "wet"})
        self.assertEqual(code, 200)
        self.assertTrue(body["ok"])
        _, items = self._get("/alerts.json")
        self.assertEqual(items[0]["key"], "leak")

    def test_token_unset_fails_closed(self):
        A.TOKEN = ""
        code, _ = self._post("/api/alert", {"key": "k", "title": "t", "message": "m"})
        self.assertEqual(code, 503)
        A.TOKEN = "secret"

    def test_cap_exceeded_over_http(self):
        A.MAX_ACTIVE = 2
        try:
            for i in range(2):
                code, _ = self._post("/api/alert", {"key": f"k{i}", "title": "t", "message": "m"})
                self.assertEqual(code, 200)
            code, body = self._post("/api/alert", {"key": "k2", "title": "t", "message": "m"})
            self.assertEqual(code, 409)
            self.assertIn("error", body)
        finally:
            A.MAX_ACTIVE = 20


if __name__ == "__main__":
    unittest.main()


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        A.SNAPSHOTS_DIR = self.dir
        A.SNAPSHOT_TOKEN = "snaptok"
        A.TOKEN = "secret"
        A.SNAPSHOT_MAX_PER_ROOM = 3
        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), A.Handler)
        self.port = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def tearDown(self):
        self.srv.shutdown(); self.srv.server_close()
        import shutil; shutil.rmtree(self.dir, ignore_errors=True)

    def _snap(self, body=b"\xff\xd8\xff\xe0jpegbytes", ctype="image/jpeg", token="snaptok", profile="Theater"):
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/api/snapshot?profile={profile}",
            data=body, method="POST")
        if token is not None: req.add_header("Authorization", f"Bearer {token}")
        if ctype is not None: req.add_header("Content-Type", ctype)
        try:
            with urllib.request.urlopen(req) as r: return r.status, json.load(r)
        except urllib.error.HTTPError as e:
            with e: return e.code, json.load(e)

    def test_snapshot_token_unset_fails_closed(self):
        A.SNAPSHOT_TOKEN = ""
        code, _ = self._snap()
        self.assertEqual(code, 503)
        A.SNAPSHOT_TOKEN = "snaptok"

    def test_snapshot_bad_bearer(self):
        self.assertEqual(self._snap(token="nope")[0], 401)

    def test_alert_token_does_not_authorize_snapshot(self):
        self.assertEqual(self._snap(token="secret")[0], 401)

    def test_snapshot_rejects_non_jpeg(self):
        self.assertEqual(self._snap(ctype="text/plain")[0], 415)

    def test_snapshot_rejects_non_jpeg_body(self):
        # jpeg content-type but the bytes aren't a JPEG (no SOI marker)
        self.assertEqual(self._snap(body=b"GIF89a-not-a-jpeg")[0], 415)

    def test_snapshot_rejects_path_traversal_profile(self):
        for bad in ("..", ".", ".hidden", "a/b"):
            self.assertEqual(self._snap(profile=bad)[0], 400, bad)
        import glob
        self.assertEqual(glob.glob(os.path.join(self.dir, "..", "*.jpg")), [])

    def test_snapshot_happy_writes_file(self):
        code, body = self._snap()
        self.assertEqual(code, 200)
        room = os.path.join(self.dir, "Theater")
        files = os.listdir(room)
        self.assertEqual(len(files), 1)
        self.assertTrue(files[0].endswith(".jpg"))

    def test_snapshot_retention_prunes_oldest(self):
        import time as _t
        for i in range(5):
            A.now_ms = (lambda v: (lambda: v))(1000 + i)   # distinct, increasing
            self.assertEqual(self._snap()[0], 200)
            _t.sleep(0.01)
        room = os.path.join(self.dir, "Theater")
        self.assertLessEqual(len(os.listdir(room)), 3)   # MAX_PER_ROOM


import urllib.parse


class PresenceTests(unittest.TestCase):
    def setUp(self):
        self.received = []
        outer = self
        class HA(__import__('http.server', fromlist=['BaseHTTPRequestHandler']).BaseHTTPRequestHandler):
            def log_message(self, *a): pass
            def do_POST(self):
                n = int(self.headers.get('Content-Length', '0'))
                outer.received.append(json.loads(self.rfile.read(n) or b'{}'))
                self.send_response(200); self.send_header('Content-Length', '0'); self.end_headers()
        self.ha = ThreadingHTTPServer(('127.0.0.1', 0), HA)
        threading.Thread(target=self.ha.serve_forever, daemon=True).start()
        self.ha_url = f"http://127.0.0.1:{self.ha.server_address[1]}/hook"
        self.srv = ThreadingHTTPServer(('127.0.0.1', 0), A.Handler)
        self.port = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def tearDown(self):
        self.srv.shutdown(); self.srv.server_close()
        self.ha.shutdown(); self.ha.server_close()
        A.HA_WEBHOOK_URL = ""

    def _post(self, body):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/api/presence",
                                     data=json.dumps(body).encode(), method="POST")
        try:
            with urllib.request.urlopen(req) as r: return r.status, json.load(r)
        except urllib.error.HTTPError as e:
            with e: return e.code, json.load(e)

    def test_no_webhook_is_noop(self):
        A.HA_WEBHOOK_URL = ""
        code, body = self._post({"room": "Kitchen", "present": True})
        self.assertEqual(code, 200)
        self.assertFalse(body["relayed"])

    def test_relays_to_ha(self):
        A.HA_WEBHOOK_URL = self.ha_url
        code, body = self._post({"room": "Kitchen", "present": True})
        self.assertEqual(code, 200)
        self.assertTrue(body["relayed"])
        self.assertEqual(self.received[-1], {"room": "Kitchen", "present": True})

    def test_bad_body_400(self):
        A.HA_WEBHOOK_URL = self.ha_url
        self.assertEqual(self._post({"room": "Kitchen"})[0], 400)          # missing present
        self.assertEqual(self._post({"present": True})[0], 400)            # missing room
        self.assertEqual(self._post({"room": "x/y", "present": True})[0], 400)  # bad room

    def test_relay_does_not_follow_redirects(self):
        import http.server, socketserver
        hits = []
        class Redir(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a): pass
            def do_POST(self):
                hits.append(self.path)
                self.send_response(302)
                self.send_header("Location", "http://127.0.0.1:1/evil")
                self.send_header("Content-Length", "0"); self.end_headers()
        rsrv = ThreadingHTTPServer(("127.0.0.1", 0), Redir)
        threading.Thread(target=rsrv.serve_forever, daemon=True).start()
        try:
            A.HA_WEBHOOK_URL = f"http://127.0.0.1:{rsrv.server_address[1]}/hook"
            code, body = self._post({"room": "Kitchen", "present": True})
            self.assertEqual(code, 200)
            self.assertFalse(body["relayed"])      # 302 not followed -> treated as failure
            self.assertEqual(len(hits), 1)         # only the original POST, no redirect chase
        finally:
            rsrv.shutdown(); rsrv.server_close()
