"""Timed-lyrics data model, matching spec/lyrics.schema.json."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Word:
    t: str
    s: int  # start ms
    e: int  # end ms
    low_confidence: bool = False

    def to_json(self) -> dict:
        d = {"t": self.t, "s": int(self.s), "e": int(self.e)}
        if self.low_confidence:
            d["lowConfidence"] = True
        return d


@dataclass
class Line:
    words: list[Word]
    singer: str | None = None

    @property
    def start(self) -> int:
        return self.words[0].s

    @property
    def end(self) -> int:
        return self.words[-1].e

    @property
    def text(self) -> str:
        return " ".join(w.t for w in self.words)

    def to_json(self) -> dict:
        d: dict = {"start": self.start, "end": self.end, "words": [w.to_json() for w in self.words]}
        if self.singer:
            d["singer"] = self.singer
        return d


@dataclass
class Lyrics:
    lines: list[Line] = field(default_factory=list)
    singers: dict[str, str] = field(default_factory=dict)

    def to_json(self) -> dict:
        d: dict = {"version": 1, "lines": [ln.to_json() for ln in self.lines if ln.words]}
        if self.singers:
            d["singers"] = self.singers
        return d

    @classmethod
    def from_json(cls, d: dict) -> Lyrics:
        lines = [
            Line(
                words=[Word(w["t"], w["s"], w["e"], bool(w.get("lowConfidence"))) for w in ln["words"]],
                singer=ln.get("singer"),
            )
            for ln in d.get("lines", [])
        ]
        return cls(lines=lines, singers=dict(d.get("singers", {})))


@dataclass
class LyricLine:
    """A line of lyrics text before timing, with optional known timings from an LRC."""

    text: str
    start: int | None = None  # ms, from LRC line tag
    word_times: list[int] | None = None  # ms per word, from enhanced LRC
    singer: str | None = None
