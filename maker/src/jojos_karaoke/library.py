"""Client for the online library on the room server (see room-worker/src/library.ts)."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

from .config import Config

TIMEOUT = 60


class LibraryError(RuntimeError):
    pass


class Library:
    def __init__(self, cfg: Config | None = None):
        self.cfg = cfg or Config.load()
        if not self.cfg.token:
            raise LibraryError("Not logged in. Run `jojo login` first.")

    def _req(self, method: str, path: str, body: bytes | None = None, ctype: str | None = None,
             timeout: float = TIMEOUT):
        req = urllib.request.Request(self.cfg.server + path, data=body, method=method)
        req.add_header("Authorization", f"Bearer {self.cfg.token}")
        if ctype:
            req.add_header("Content-Type", ctype)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310
                data = r.read()
                return json.loads(data) if data and r.headers.get_content_type() == "application/json" else data
        except urllib.error.HTTPError as e:
            msg = e.read().decode("utf-8", "replace")[:300]
            raise LibraryError(f"{method} {path}: HTTP {e.code} {msg}") from None
        except OSError as e:
            raise LibraryError(f"{method} {path}: {e}") from None

    def whoami(self) -> dict:
        return self._req("GET", "/api/me")

    def songs(self) -> list[dict]:
        return self._req("GET", "/api/library/songs")["songs"]

    def delete(self, sid: str) -> None:
        self._req("DELETE", f"/api/library/songs/{sid}")

    def upload_package(self, pkg_path: str) -> str:
        """Upload each member of a .jkp, then commit the manifest. Returns the song id."""
        from .package import read_package

        pkg = read_package(pkg_path)
        sid = pkg.manifest["id"]
        types = {".opus": "audio/ogg", ".jpg": "image/jpeg", ".png": "image/png"}
        for name, data in pkg.files.items():
            self._req("PUT", f"/api/library/songs/{sid}/files/{name}", data,
                      types.get(os.path.splitext(name)[1], "application/octet-stream"), timeout=300)
        self._req("PUT", f"/api/library/songs/{sid}/files/lyrics.json",
                  json.dumps(pkg.lyrics).encode(), "application/json")
        if pkg.pitch is not None:
            self._req("PUT", f"/api/library/songs/{sid}/files/pitch.json",
                      json.dumps(pkg.pitch).encode(), "application/json")
        self._req("POST", f"/api/library/songs/{sid}/commit", json.dumps(pkg.manifest).encode(),
                  "application/json")
        return sid

    def download_upload(self, room: str, upload_id: str, dst: str) -> str:
        data = self._req("GET", f"/api/rooms/{room}/uploads/{upload_id}", timeout=300)
        with open(dst, "wb") as f:
            f.write(data)
        return dst
