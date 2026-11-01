"""Lyrics input: plain text, LRC / enhanced LRC, and lookup on LRCLIB."""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
import urllib.request

from . import __version__
from .model import LyricLine

LRCLIB = "https://lrclib.net/api"
_TS = re.compile(r"\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]")
_WORD_TS = re.compile(r"<(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)>")
_META = re.compile(r"^\[([a-zA-Z#]+):(.*)\]\s*$")
# Section markers like "[Chorus]" or "(x2)" on their own line
_SECTION = re.compile(r"^\s*(\[[^\]]*\]|\([^)]*\))\s*$")
_SINGER = re.compile(r"^\s*([A-Za-z0-9]{1,16})\s*:\s+(.+)$")


def _ms(minutes: str, seconds: str) -> int:
    seconds = seconds.replace(":", ".")
    return int(round((int(minutes) * 60 + float(seconds)) * 1000))


def parse_text(text: str, singer_prefixes: bool = False) -> list[LyricLine]:
    """Plain lyrics: one line per line, blank lines and section markers dropped.
    With singer_prefixes, "A: some words" assigns the line to singer A (duets)."""
    out: list[LyricLine] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or _SECTION.match(line):
            continue
        singer = None
        if singer_prefixes and (m := _SINGER.match(line)):
            singer, line = m.group(1), m.group(2).strip()
        out.append(LyricLine(text=line, singer=singer))
    return out


def looks_like_lrc(text: str) -> bool:
    return sum(1 for ln in text.splitlines() if _TS.match(ln.strip())) >= 2


def parse_lrc(text: str) -> list[LyricLine]:
    """LRC with optional [offset:±ms], repeated timestamps and enhanced <mm:ss.xx> word tags."""
    offset = 0
    out: list[LyricLine] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        meta = _META.match(line)
        if meta and not _TS.match(line):
            if meta.group(1).lower() == "offset":
                try:
                    offset = int(meta.group(2).strip())
                except ValueError:
                    pass
            continue
        stamps = []
        while m := _TS.match(line):
            stamps.append(_ms(m.group(1), m.group(2)))
            line = line[m.end():]
        if not stamps:
            continue
        word_times = None
        if _WORD_TS.search(line):
            word_times, words = [], []
            for m in _WORD_TS.finditer(line):
                nxt = _WORD_TS.search(line, m.end())
                chunk = line[m.end(): nxt.start() if nxt else len(line)].strip()
                for i, w in enumerate(chunk.split()):
                    word_times.append(_ms(m.group(1), m.group(2)) if i == 0 else -1)
                    words.append(w)
            line = " ".join(words)
            if not words:
                continue
        text_line = line.strip()
        if not text_line or _SECTION.match(text_line):
            continue
        for st in stamps:
            wt = None
            if word_times is not None:
                delta = st - stamps[0]
                wt = [(t - offset + delta) if t >= 0 else -1 for t in word_times]
            out.append(LyricLine(text=text_line, start=max(0, st - offset), word_times=wt))
    out.sort(key=lambda ln: ln.start or 0)
    return out


def load_lyrics_file(path: str, singer_prefixes: bool = False) -> list[LyricLine]:
    with open(path, encoding="utf-8-sig") as f:
        text = f.read()
    if path.lower().endswith(".lrc") or looks_like_lrc(text):
        return parse_lrc(text)
    return parse_text(text, singer_prefixes)


def _get_json(url: str, timeout: float):
    req = urllib.request.Request(url, headers={
        "User-Agent": f"jojos-karaoke/{__version__} (https://github.com/JonathanGehret/jojos-karaoke)"
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 (fixed https host)
        return json.loads(r.read().decode("utf-8"))


def fetch_lrclib(artist: str, title: str, duration_s: float | None = None,
                 timeout: float = 8.0) -> tuple[str | None, str | None]:
    """Look up lyrics on LRCLIB. Returns (synced_lrc, plain_text); either may be None.
    Never raises: network trouble just means "not found"."""
    if not title:
        return None, None
    params = {"track_name": title, "artist_name": artist or ""}
    if duration_s:
        params["duration"] = str(int(round(duration_s)))
    try:
        try:
            d = _get_json(f"{LRCLIB}/get?{urllib.parse.urlencode(params)}", timeout)
            candidates = [d]
        except urllib.error.HTTPError as e:
            if e.code != 404:
                return None, None
            q = urllib.parse.urlencode({"track_name": title, "artist_name": artist or ""})
            candidates = _get_json(f"{LRCLIB}/search?{q}", timeout) or []
        best = pick_lrclib_candidate(candidates, duration_s)
        if not best:
            return None, None
        return best.get("syncedLyrics") or None, best.get("plainLyrics") or None
    except (OSError, ValueError, TimeoutError):
        return None, None


def pick_lrclib_candidate(candidates: list[dict], duration_s: float | None) -> dict | None:
    """Prefer synced lyrics, then the closest duration (within 8 s when known)."""
    ok = [c for c in candidates if isinstance(c, dict) and not c.get("instrumental")
          and (c.get("syncedLyrics") or c.get("plainLyrics"))]
    if duration_s:
        ok = [c for c in ok if not c.get("duration") or abs(float(c["duration"]) - duration_s) <= 8]
    if not ok:
        return None

    def score(c):
        dd = abs(float(c.get("duration") or duration_s or 0) - (duration_s or 0))
        return (0 if c.get("syncedLyrics") else 1, dd)

    return sorted(ok, key=score)[0]
