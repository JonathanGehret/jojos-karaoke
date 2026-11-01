"""Export timed lyrics as (enhanced) LRC for other karaoke apps."""

from __future__ import annotations


def _ts(ms: int) -> str:
    ms = max(0, int(ms))
    return f"{ms // 60000:02d}:{(ms // 1000) % 60:02d}.{(ms % 1000) // 10:02d}"


def to_lrc(lyrics: dict, title: str = "", artist: str = "", enhanced: bool = True) -> str:
    out = []
    if title:
        out.append(f"[ti:{title}]")
    if artist:
        out.append(f"[ar:{artist}]")
    for ln in lyrics["lines"]:
        if enhanced:
            body = " ".join(f"<{_ts(w['s'])}>{w['t']}" for w in ln["words"]) + f" <{_ts(ln['end'])}>"
        else:
            body = " ".join(w["t"] for w in ln["words"])
        out.append(f"[{_ts(ln['start'])}]{body}")
    return "\n".join(out) + "\n"
