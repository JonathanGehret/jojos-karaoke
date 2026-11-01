"""ffmpeg/ffprobe helpers."""

from __future__ import annotations

import json
import shutil
import subprocess

import numpy as np


class FFmpegMissing(RuntimeError):
    pass


def require_ffmpeg() -> None:
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        raise FFmpegMissing(
            "ffmpeg is not installed. Install it first: "
            "Windows `winget install ffmpeg`, macOS `brew install ffmpeg`, Linux `sudo apt install ffmpeg`."
        )


def probe(path: str) -> dict:
    """Duration (s) and tags (title, artist, ...) of an audio file."""
    require_ffmpeg()
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", path],
        capture_output=True, text=True, check=True,
    ).stdout
    fmt = json.loads(out).get("format", {})
    tags = {k.lower(): v for k, v in (fmt.get("tags") or {}).items()}
    return {"duration": float(fmt.get("duration") or 0), "tags": tags}


def decode_mono(path: str, sr: int = 16000) -> np.ndarray:
    """Decode any audio file to mono float32 at `sr`."""
    require_ffmpeg()
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"],
        capture_output=True, check=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32).copy()


def encode_opus(src: str, dst: str, bitrate: str = "128k") -> None:
    require_ffmpeg()
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", src, "-vn", "-c:a", "libopus", "-b:a", bitrate,
         "-vbr", "on", "-ar", "48000", dst],
        check=True,
    )


def extract_cover(src: str, dst: str) -> bool:
    """Write embedded cover art to dst (jpg). False when there is none."""
    require_ffmpeg()
    r = subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", src, "-an", "-frames:v", "1",
         "-vf", "scale='min(800,iw)':-2", dst],
        capture_output=True,
    )
    return r.returncode == 0
