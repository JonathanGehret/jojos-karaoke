"""Transcription fallback when no lyrics are given or found (faster-whisper)."""

from __future__ import annotations

from .align import TimedWord
from .model import LyricLine

LINE_GAP_MS = 700
MAX_WORDS_PER_LINE = 10


def available() -> bool:
    try:
        import faster_whisper  # noqa: F401
        return True
    except ImportError:
        return False


def split_into_lines(words: list[TimedWord], gap_ms: int = LINE_GAP_MS,
                     max_words: int = MAX_WORDS_PER_LINE) -> list[list[TimedWord]]:
    """Group transcribed words into display lines at pauses, sentence ends and a max length."""
    lines: list[list[TimedWord]] = []
    cur: list[TimedWord] = []
    for w in words:
        if cur and (w.start - cur[-1].end > gap_ms or len(cur) >= max_words
                    or cur[-1].text.rstrip().endswith((".", "!", "?"))):
            lines.append(cur)
            cur = []
        cur.append(w)
    if cur:
        lines.append(cur)
    return lines


def transcribe(vocals_path: str, language: str | None, device: str,
               model_name: str = "large-v3-turbo") -> tuple[list[LyricLine], list[TimedWord], str]:
    """Returns (lines, timed words, detected language)."""
    from faster_whisper import WhisperModel

    dev = "cuda" if device == "cuda" else "cpu"
    model = WhisperModel(model_name, device=dev, compute_type="float16" if dev == "cuda" else "int8")
    segments, info = model.transcribe(
        vocals_path, language=language or None, word_timestamps=True, vad_filter=True,
        condition_on_previous_text=False,
    )
    words: list[TimedWord] = []
    for seg in segments:
        for w in seg.words or []:
            text = w.word.strip()
            if text:
                words.append(TimedWord(text, int(w.start * 1000), int(w.end * 1000), float(w.probability)))
    groups = split_into_lines(words)
    lines = [LyricLine(text=" ".join(w.text for w in g), start=g[0].start) for g in groups]
    return lines, words, info.language
