"""Karaoke MP4 via ffmpeg + libass (ASS \\kf karaoke tags give the word wipe)."""

from __future__ import annotations

import os
import subprocess
import tempfile

from .audio import require_ffmpeg

W, H = 1280, 720
SUNG = "&H004DD3FF"      # gold (ASS colours are &HAABBGGRR)
UNSUNG = "&H00FFFFFF"    # white
OUTLINE = "&H00201010"
PREVIEW_MS = 3000        # show a line this long before it starts after a gap


def _ass_time(ms: int) -> str:
    ms = max(0, int(ms))
    cs = ms // 10
    return f"{cs // 360000}:{(cs // 6000) % 60:02d}:{(cs // 100) % 60:02d}.{cs % 100:02d}"


def _esc(text: str) -> str:
    return text.replace("\\", "\\\\").replace("{", "(").replace("}", ")").replace("\n", " ")


def build_ass(lyrics: dict, title: str = "", artist: str = "") -> str:
    head = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {W}
PlayResY: {H}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Top,DejaVu Sans,56,{SUNG},{UNSUNG},{OUTLINE},&H80000000,1,0,0,0,100,100,0,0,1,4,2,2,60,60,230,1
Style: Bottom,DejaVu Sans,56,{SUNG},{UNSUNG},{OUTLINE},&H80000000,1,0,0,0,100,100,0,0,1,4,2,2,60,60,130,1
Style: Title,DejaVu Sans,64,&H00FFFFFF,&H00FFFFFF,{OUTLINE},&H80000000,1,0,0,0,100,100,0,0,1,4,2,5,60,60,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    events = []
    lines = lyrics["lines"]
    first = lines[0]["start"] if lines else 0
    if title and first >= 2500:
        card = _esc(title) + (r"\N{\fs40}" + _esc(artist) if artist else "")
        events.append(f"Dialogue: 0,{_ass_time(0)},{_ass_time(min(5000, first - 1000))},Title,,0,0,0,,{card}")
    for i, ln in enumerate(lines):
        prev_start = lines[i - 1]["start"] if i else None
        prev_end = lines[i - 1]["end"] if i else 0
        if prev_start is not None and ln["start"] - prev_end < PREVIEW_MS:
            show = prev_start  # appears as the preview line while the previous one is sung
        else:
            show = max(0, ln["start"] - PREVIEW_MS)
        hide = ln["end"] + 300
        nxt = lines[i + 2]["start"] if i + 2 < len(lines) else None  # slot reused by line i+2
        if nxt is not None:
            hide = min(hide, max(ln["end"], nxt - 1))
        parts = []
        cursor = show
        for w in ln["words"]:
            if w["s"] > cursor:
                parts.append(f"{{\\k{(w['s'] - cursor) // 10}}}")
            parts.append(f"{{\\kf{max(1, (w['e'] - w['s']) // 10)}}}{_esc(w['t'])} ")
            cursor = w["e"]
        style = "Top" if i % 2 == 0 else "Bottom"
        events.append(f"Dialogue: 0,{_ass_time(show)},{_ass_time(hide)},{style},,0,0,0,,{''.join(parts).rstrip()}")
    return head + "\n".join(events) + "\n"


def render_video(lyrics: dict, audio_path: str, out_path: str, *, title: str = "", artist: str = "",
                 background: str | None = None, color: str = "0x14112b", fps: int = 30) -> str:
    """background: an image path (blurred, darkened) or None for a solid colour."""
    require_ffmpeg()
    out_path = os.path.abspath(out_path)
    audio_path = os.path.abspath(audio_path)
    with tempfile.TemporaryDirectory() as td:
        with open(os.path.join(td, "lyrics.ass"), "w", encoding="utf-8") as f:
            f.write(build_ass(lyrics, title, artist))
        if background:
            vin = ["-loop", "1", "-framerate", str(fps), "-i", os.path.abspath(background)]
            vf = (f"scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},"
                  "boxblur=20:2,eq=brightness=-0.25,ass=lyrics.ass,format=yuv420p")
        else:
            vin = ["-f", "lavfi", "-i", f"color=c={color}:s={W}x{H}:r={fps}"]
            vf = "ass=lyrics.ass,format=yuv420p"
        cmd = ["ffmpeg", "-v", "error", "-y", *vin, "-i", audio_path, "-vf", vf,
               "-map", "0:v", "-map", "1:a", "-shortest", "-c:v", "libx264", "-preset", "veryfast",
               "-tune", "stillimage", "-crf", "26", "-c:a", "aac", "-b:a", "192k",
               "-movflags", "+faststart", out_path]
        subprocess.run(cmd, check=True, cwd=td)  # cwd: the ass filter path needs no escaping
    return out_path
