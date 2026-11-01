import os
import subprocess

from jojos_karaoke.lrc import to_lrc
from jojos_karaoke.lyrics import parse_lrc
from jojos_karaoke.video import build_ass, render_video

LYR = {"version": 1, "lines": [
    {"start": 3000, "end": 4000, "words": [{"t": "la", "s": 3000, "e": 3500}, {"t": "lo{x}", "s": 3600, "e": 4000}]},
    {"start": 4500, "end": 5500, "words": [{"t": "li", "s": 4500, "e": 5500}]},
]}


def test_lrc_roundtrip():
    text = to_lrc(LYR, "T", "A")
    assert "[00:03.00]<00:03.00>la <00:03.60>lo{x} <00:04.00>" in text
    back = parse_lrc(text)
    assert back[0].start == 3000 and back[0].word_times[:2] == [3000, 3600]


def test_ass_karaoke_tags():
    ass = build_ass(LYR, "Title", "Artist")
    events = [ln for ln in ass.splitlines() if ln.startswith("Dialogue")]
    assert events[0].endswith(r"Title\N{\fs40}Artist")              # title card
    first = events[1]
    assert ",Top," in first and r"{\k300}{\kf50}la {\k10}{\kf40}lo(x)" in first   # braces escaped
    assert ",Bottom," in events[2]
    assert "0:00:03.00" in events[2]  # second line previews while the first is sung


def test_render_video(tmp_path, tone):
    out = render_video(LYR, tone, str(tmp_path / "v.mp4"), title="T", artist="A")
    assert os.path.getsize(out) > 1000
    dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of",
                                "csv=p=0", out], capture_output=True, text=True).stdout)
    assert 7.5 < dur < 8.6
