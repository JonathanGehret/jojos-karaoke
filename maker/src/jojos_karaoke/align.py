"""Word-level timing: map aligner output back onto the lyric lines, with fallbacks.

The pure functions here (tokenize, match_words, distribute, voiced regions) carry all the
logic and are unit-tested; the ML backends only produce a flat list of timed words.
"""

from __future__ import annotations

import difflib
import re
import unicodedata
from dataclasses import dataclass

import numpy as np

from .model import Line, LyricLine, Lyrics, Word

MIN_WORD_MS = 80
LOW_CONFIDENCE = 0.35
_HAS_ALNUM = re.compile(r"\w", re.UNICODE)

ISO3 = {
    "en": "eng", "de": "deu", "fr": "fra", "es": "spa", "it": "ita", "pt": "por", "nl": "nld",
    "sv": "swe", "da": "dan", "no": "nor", "fi": "fin", "pl": "pol", "cs": "ces", "tr": "tur",
    "ru": "rus", "uk": "ukr", "ja": "jpn", "ko": "kor", "zh": "cmn", "ar": "ara", "hi": "hin",
    "el": "ell", "hu": "hun", "ro": "ron", "id": "ind", "vi": "vie", "th": "tha", "he": "heb",
}


@dataclass
class TimedWord:
    text: str
    start: int  # ms
    end: int  # ms
    score: float = 1.0


def tokenize(text: str) -> list[str]:
    """Split a lyric line into display words. Tokens with no letters/digits (a lone "-" or
    "…") are glued to the previous word so the aligner and the display agree on count."""
    out: list[str] = []
    for tok in text.split():
        if not _HAS_ALNUM.search(tok) and out:
            out[-1] = f"{out[-1]} {tok}"
        elif _HAS_ALNUM.search(tok):
            out.append(tok)
    return out


def norm(word: str) -> str:
    w = unicodedata.normalize("NFKD", word.lower())
    w = "".join(c for c in w if not unicodedata.combining(c))
    return re.sub(r"[^\w']", "", w).replace("'", "")


def match_words(tokens: list[str], aligned: list[TimedWord]) -> list[TimedWord | None]:
    """For each lyric token, the aligned word it corresponds to (or None). Uses a sequence
    diff on normalised text so a dropped or extra word doesn't shift everything after it."""
    if len(tokens) == len(aligned):
        return list(aligned)
    a = [norm(t) for t in tokens]
    b = [norm(w.text) for w in aligned]
    out: list[TimedWord | None] = [None] * len(tokens)
    sm = difflib.SequenceMatcher(a=a, b=b, autojunk=False)
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal" or (tag == "replace" and i2 - i1 == j2 - j1):
            for k in range(i2 - i1):
                out[i1 + k] = aligned[j1 + k]
        elif tag == "replace" and j2 > j1:
            # unequal run: spread the aligned span over the tokens
            s, e = aligned[j1].start, aligned[j2 - 1].end
            sc = min(w.score for w in aligned[j1:j2]) * 0.5
            n = i2 - i1
            for k in range(n):
                out[i1 + k] = TimedWord(tokens[i1 + k], s + (e - s) * k // n, s + (e - s) * (k + 1) // n, sc)
    return out


def distribute(tokens: list[str], start: int, end: int, low: bool = False) -> list[Word]:
    """Spread tokens over [start, end] weighted by length (longer words take longer)."""
    if not tokens:
        return []
    end = max(end, start + MIN_WORD_MS * len(tokens))
    weights = [max(1, len(norm(t))) + 1 for t in tokens]
    total = sum(weights)
    out, acc = [], 0
    for t, w in zip(tokens, weights, strict=True):
        s = start + (end - start) * acc // total
        acc += w
        e = start + (end - start) * acc // total
        out.append(Word(t, s, e, low))
    return out


def _fill_gaps(tokens: list[str], timed: list[TimedWord | None], lo: int, hi: int) -> list[Word]:
    """Interpolate times for unmatched tokens between their matched neighbours."""
    words: list[Word] = []
    i = 0
    while i < len(tokens):
        if timed[i] is not None:
            tw = timed[i]
            words.append(Word(tokens[i], tw.start, tw.end, tw.score < LOW_CONFIDENCE))
            i += 1
            continue
        j = i
        while j < len(tokens) and timed[j] is None:
            j += 1
        s = words[-1].e if words else lo
        e = timed[j].start if j < len(tokens) else hi
        if e - s < MIN_WORD_MS * (j - i):
            e = s + MIN_WORD_MS * (j - i)
        words.extend(distribute(tokens[i:j], s, e, low=True))
        i = j
    return words


def fix_monotonic(words: list[Word], duration_ms: int | None = None) -> list[Word]:
    """Times strictly non-decreasing, each word at least MIN_WORD_MS where room allows."""
    prev = 0
    for w in words:
        w.s = max(w.s, prev)
        w.e = max(w.e, w.s + MIN_WORD_MS)
        prev = w.e
    if duration_ms:
        for w in words:
            w.s = min(w.s, duration_ms - 1)
            w.e = min(w.e, duration_ms)
            if w.e <= w.s:
                w.e = w.s + 1
    return words


def assemble(lines: list[LyricLine], aligned: list[TimedWord], duration_ms: int) -> Lyrics:
    """Combine lyric lines with the aligner's flat word list."""
    tokens_per_line = [tokenize(ln.text) for ln in lines]
    flat = [t for toks in tokens_per_line for t in toks]
    timed = match_words(flat, aligned)
    words = fix_monotonic(_fill_gaps(flat, timed, 0, duration_ms), duration_ms)
    out, k = [], 0
    for ln, toks in zip(lines, tokens_per_line, strict=True):
        if toks:
            out.append(Line(words=words[k:k + len(toks)], singer=ln.singer))
        k += len(toks)
    return Lyrics(lines=out)


def from_lrc_timings(lines: list[LyricLine], duration_ms: int) -> Lyrics:
    """No aligner: use LRC line (and enhanced word) timings, spreading words in each line.
    A line ends at the next line's start, capped at ~0.5 s per word + 1 s."""
    out: list[Line] = []
    for i, ln in enumerate(lines):
        toks = tokenize(ln.text)
        if not toks or ln.start is None:
            continue
        nxt = next((x.start for x in lines[i + 1:] if x.start is not None and x.start > ln.start), duration_ms)
        end = min(nxt, ln.start + 1000 + 500 * len(toks))
        if ln.word_times and len(ln.word_times) == len(toks) and all(t >= 0 for t in ln.word_times):
            wt = ln.word_times + [end]
            words = [Word(t, wt[k], max(wt[k + 1], wt[k] + MIN_WORD_MS)) for k, t in enumerate(toks)]
        else:
            words = distribute(toks, ln.start, end)
        out.append(Line(words=words, singer=ln.singer))
    fix_monotonic([w for ln in out for w in ln.words], duration_ms)
    return Lyrics(lines=out)


def voiced_regions(x: np.ndarray, sr: int, hop_ms: int = 20, min_gap_ms: int = 600,
                   min_len_ms: int = 300) -> list[tuple[int, int]]:
    """Where the vocal stem is audible (energy above an adaptive threshold), in ms."""
    hop = max(1, sr * hop_ms // 1000)
    n = len(x) // hop
    if n == 0:
        return []
    rms = np.sqrt(np.mean(x[: n * hop].reshape(n, hop) ** 2, axis=1) + 1e-12)
    db = 20 * np.log10(rms)
    loud = np.percentile(db, 95)
    thr = max(loud - 30, np.percentile(db, 30) + 6)
    on = db > thr
    regions, start = [], None
    for i, v in enumerate(on):
        if v and start is None:
            start = i
        elif not v and start is not None:
            regions.append([start * hop_ms, i * hop_ms])
            start = None
    if start is not None:
        regions.append([start * hop_ms, n * hop_ms])
    merged: list[list[int]] = []
    for r in regions:
        if merged and r[0] - merged[-1][1] < min_gap_ms:
            merged[-1][1] = r[1]
        else:
            merged.append(r)
    return [(a, b) for a, b in merged if b - a >= min_len_ms]


def from_voice_activity(lines: list[LyricLine], regions: list[tuple[int, int]], duration_ms: int) -> Lyrics:
    """Last-resort timing without any model: lay the lines over the voiced regions in
    order, proportional to text length. Everything is marked low confidence."""
    toks = [tokenize(ln.text) for ln in lines]
    keep = [(ln, t) for ln, t in zip(lines, toks, strict=True) if t]
    if not keep:
        return Lyrics()
    if not regions:
        regions = [(0, duration_ms)]
    total_voice = sum(b - a for a, b in regions)
    total_chars = sum(sum(len(norm(w)) + 1 for w in t) for _, t in keep)
    # map a cumulative "voice time" position to song time
    def to_song(v: float) -> int:
        for a, b in regions:
            if v <= b - a:
                return int(a + v)
            v -= b - a
        return regions[-1][1]

    out, acc = [], 0.0
    for ln, t in keep:
        chars = sum(len(norm(w)) + 1 for w in t)
        s = to_song(acc / total_chars * total_voice)
        acc += chars
        e = to_song(acc / total_chars * total_voice)
        out.append(Line(words=distribute(t, s, max(e, s + MIN_WORD_MS * len(t)), low=True), singer=ln.singer))
    fix_monotonic([w for ln in out for w in ln.words], duration_ms)
    return Lyrics(lines=out)


# ---------------------------------------------------------------- ML backends


def aligner_available() -> bool:
    try:
        import ctc_forced_aligner  # noqa: F401
        return True
    except ImportError:
        return False


def ctc_align(vocals_path: str, lines: list[LyricLine], language: str, device: str) -> list[TimedWord]:
    """Forced alignment with ctc-forced-aligner (MMS, 1000+ languages)."""
    import torch
    from ctc_forced_aligner import (
        generate_emissions,
        get_alignments,
        get_spans,
        load_alignment_model,
        load_audio,
        postprocess_results,
        preprocess_text,
    )

    dev = "cuda" if device == "cuda" else "cpu"  # MPS lacks some CTC ops
    model, tokenizer = load_alignment_model(dev, dtype=torch.float16 if dev == "cuda" else torch.float32)
    wav = load_audio(vocals_path, model.dtype, model.device)
    emissions, stride = generate_emissions(model, wav, batch_size=4)
    text = " ".join(t for ln in lines for t in tokenize(ln.text))
    tokens_starred, text_starred = preprocess_text(text, romanize=True, language=ISO3.get(language, language or "eng"))
    segments, scores, blank = get_alignments(emissions, tokens_starred, tokenizer)
    spans = get_spans(tokens_starred, segments, blank)
    results = postprocess_results(text_starred, spans, stride, scores)
    out = []
    for r in results:
        sc = float(r.get("score", 0.0))
        # scores are log-probs averaged per word; map to 0..1
        conf = float(np.exp(sc)) if sc <= 0 else min(1.0, sc)
        out.append(TimedWord(r["text"], int(r["start"] * 1000), int(r["end"] * 1000), conf))
    return out
