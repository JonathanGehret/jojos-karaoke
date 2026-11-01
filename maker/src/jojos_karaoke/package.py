"""Read and write .jkp packages (zip; see spec/)."""

from __future__ import annotations

import hashlib
import json
import os
import re
import unicodedata
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone

from . import __version__
from .schemas import validate


def slugify(text: str) -> str:
    t = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", t).strip("-")[:40] or "song"


def song_id(title: str, artist: str, audio_path: str | None = None) -> str:
    h = hashlib.sha1()
    h.update(f"{artist}\0{title}".encode())
    if audio_path:
        with open(audio_path, "rb") as f:
            h.update(f.read(1 << 20))
    return f"{slugify(f'{artist} {title}' if artist else title)}-{h.hexdigest()[:6]}"


def build_manifest(*, sid: str, title: str, artist: str, duration_ms: int, language: str | None,
                   lyrics_source: str, has_vocals: bool, has_pitch: bool, cover: str | None,
                   model: str) -> dict:
    files = {"instrumental": "instrumental.opus", "lyrics": "lyrics.json"}
    if has_vocals:
        files["vocals"] = "vocals.opus"
    if has_pitch:
        files["pitch"] = "pitch.json"
    if cover:
        files["cover"] = cover
    m = {
        "formatVersion": 1, "id": sid, "title": title[:200], "artist": (artist or "")[:200],
        "durationMs": int(duration_ms), "lyricsSource": lyrics_source,
        "createdAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "maker": f"jojos-karaoke {__version__}; {model}", "files": files,
    }
    if language:
        m["language"] = language
    return m


@dataclass
class Package:
    manifest: dict
    lyrics: dict
    pitch: dict | None
    files: dict[str, bytes]  # binary members by name


def write_package(path: str, manifest: dict, lyrics: dict, files: dict[str, str],
                  pitch: dict | None = None) -> str:
    """files: member name → path on disk (instrumental.opus, vocals.opus, cover.jpg)."""
    validate("manifest", manifest)
    validate("lyrics", lyrics)
    if pitch is not None:
        validate("pitch", pitch)
    for key, name in manifest["files"].items():
        if key not in ("lyrics", "pitch") and name not in files:
            raise ValueError(f"manifest lists {name} but it was not provided")
    tmp = path + ".part"
    with zipfile.ZipFile(tmp, "w") as z:
        z.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=1), zipfile.ZIP_DEFLATED)
        z.writestr("lyrics.json", json.dumps(lyrics, ensure_ascii=False, separators=(",", ":")),
                   zipfile.ZIP_DEFLATED)
        if pitch is not None:
            z.writestr("pitch.json", json.dumps(pitch, separators=(",", ":")), zipfile.ZIP_DEFLATED)
        for name, src in files.items():
            z.write(src, name, zipfile.ZIP_STORED)  # already compressed audio/images
    os.replace(tmp, path)
    return path


def read_package(path: str) -> Package:
    with zipfile.ZipFile(path) as z:
        names = set(z.namelist())
        manifest = json.loads(z.read("manifest.json"))
        validate("manifest", manifest)
        lyrics = json.loads(z.read("lyrics.json"))
        validate("lyrics", lyrics)
        pitch = json.loads(z.read("pitch.json")) if "pitch.json" in names else None
        files = {n: z.read(n) for n in names if n not in ("manifest.json", "lyrics.json", "pitch.json")}
    for key, name in manifest["files"].items():
        if key not in ("lyrics", "pitch") and name not in files:
            raise ValueError(f"package is missing {name}")
    return Package(manifest, lyrics, pitch, files)
