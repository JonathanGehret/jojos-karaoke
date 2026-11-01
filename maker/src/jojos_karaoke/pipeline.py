"""song file (+ optional lyrics) → .jkp package (+ optional MP4). Each stage reports progress."""

from __future__ import annotations

import os
import shutil
import tempfile
import time
from collections.abc import Callable
from dataclasses import dataclass, field

from . import align, separate, transcribe
from . import lyrics as lyr
from .audio import decode_mono, encode_opus, extract_cover, probe
from .devices import best_device
from .model import LyricLine
from .package import build_manifest, song_id, write_package

# rough share of total time per stage, for a progress bar
WEIGHTS = {"probe": 1, "separate": 55, "lyrics": 3, "align": 25, "pitch": 6, "package": 4, "video": 6}

Progress = Callable[[str, float, float | None], None]  # stage, pct 0..100 overall, eta seconds


@dataclass
class Options:
    lyrics_path: str | None = None
    lyrics_text: str | None = None
    title: str | None = None
    artist: str | None = None
    language: str | None = None
    separator: str = "auto"
    model: str | None = None
    device: str = "auto"
    lookup: bool = True            # LRCLIB
    allow_transcribe: bool = True
    pitch: bool = True
    duets: bool = False            # "A: words" singer prefixes in plain lyrics
    video: bool = False
    video_background: str | None = None
    out_dir: str = "."


@dataclass
class Result:
    package: str
    manifest: dict
    lyrics: dict
    video: str | None = None
    warnings: list[str] = field(default_factory=list)


class _Tracker:
    def __init__(self, cb: Progress | None, stages: list[str]):
        self.cb, self.t0 = cb, time.monotonic()
        total = sum(WEIGHTS[s] for s in stages)
        self.start, acc = {}, 0.0
        for s in stages:
            self.start[s] = acc / total * 100
            acc += WEIGHTS[s]
        self.share = {s: WEIGHTS[s] / total * 100 for s in stages}

    def __call__(self, stage: str, frac: float = 0.0) -> None:
        if not self.cb:
            return
        pct = min(100.0, self.start[stage] + self.share[stage] * frac)
        el = time.monotonic() - self.t0
        eta = el * (100 - pct) / pct if pct > 2 else None
        self.cb(stage, round(pct, 1), round(eta) if eta is not None else None)


def make(src: str, opt: Options, progress: Progress | None = None) -> Result:
    stages = ["probe", "separate", "lyrics", "align"] + (["pitch"] if opt.pitch else []) + ["package"]
    if opt.video:
        stages.append("video")
    tr = _Tracker(progress, stages)
    warnings: list[str] = []
    device = best_device(opt.device)

    tr("probe")
    info = probe(src)
    duration_ms = int(info["duration"] * 1000)
    if duration_ms <= 0:
        raise ValueError(f"{src}: could not read the duration; is it an audio file?")
    tags = info["tags"]
    title = opt.title or tags.get("title") or os.path.splitext(os.path.basename(src))[0]
    artist = opt.artist if opt.artist is not None else tags.get("artist", "")

    work = tempfile.mkdtemp(prefix="jojo-")
    try:
        tr("separate")
        stems = separate.separate(src, os.path.join(work, "stems"), opt.separator, device, opt.model)
        inst = os.path.join(work, "instrumental.opus")
        encode_opus(stems.instrumental, inst)
        voc = None
        if stems.vocals:
            voc = os.path.join(work, "vocals.opus")
            encode_opus(stems.vocals, voc, "96k")
        align_audio = stems.vocals or src

        tr("lyrics")
        lines, source = _get_lyrics(opt, artist, title, info["duration"], warnings)
        language = opt.language

        tr("align")
        transcribed_words = None
        if not lines and opt.allow_transcribe and transcribe.available():
            lines, transcribed_words, language = transcribe.transcribe(align_audio, opt.language, device)
            source = "transcribed"
        elif not lines:
            warnings.append("No lyrics found and transcription is not installed: package has no lyrics.")
            source = "none"
        timed = _time_lines(lines, align_audio, language, device, duration_ms, transcribed_words, warnings)

        pitch = None
        if opt.pitch and stems.vocals:
            from .pitch import pitch_json

            tr("pitch")
            pitch = pitch_json(stems.vocals)

        tr("package")
        sid = song_id(title, artist, src)
        cover = None
        files = {"instrumental.opus": inst}
        if voc:
            files["vocals.opus"] = voc
        cover_path = os.path.join(work, "cover.jpg")
        if extract_cover(src, cover_path):
            cover = "cover.jpg"
            files["cover.jpg"] = cover_path
        manifest = build_manifest(sid=sid, title=title, artist=artist, duration_ms=duration_ms,
                                  language=language, lyrics_source=source, has_vocals=bool(voc),
                                  has_pitch=pitch is not None, cover=cover, model=stems.model)
        os.makedirs(opt.out_dir, exist_ok=True)
        pkg = write_package(os.path.join(opt.out_dir, f"{sid}.jkp"), manifest, timed, files, pitch)

        video = None
        if opt.video:
            from .video import render_video

            tr("video")
            video = render_video(timed, inst, os.path.join(opt.out_dir, f"{sid}.mp4"), title=title,
                                 artist=artist, background=opt.video_background or (cover_path if cover else None))
        if progress:
            progress("done", 100.0, 0)
        return Result(pkg, manifest, timed, video, warnings)
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _get_lyrics(opt: Options, artist: str, title: str, duration_s: float,
                warnings: list[str]) -> tuple[list[LyricLine], str]:
    if opt.lyrics_path:
        return lyr.load_lyrics_file(opt.lyrics_path, opt.duets), "user"
    if opt.lyrics_text and opt.lyrics_text.strip():
        t = opt.lyrics_text
        return (lyr.parse_lrc(t) if lyr.looks_like_lrc(t) else lyr.parse_text(t, opt.duets)), "user"
    if opt.lookup:
        synced, plain = lyr.fetch_lrclib(artist, title, duration_s)
        if synced:
            return lyr.parse_lrc(synced), "lrclib"
        if plain:
            return lyr.parse_text(plain), "lrclib"
        warnings.append("No lyrics found on LRCLIB.")
    return [], "none"


def _time_lines(lines: list[LyricLine], audio_path: str, language: str | None, device: str,
                duration_ms: int, transcribed, warnings: list[str]) -> dict:
    if not lines:
        return {"version": 1, "lines": []}
    if transcribed is not None:
        return align.assemble(lines, transcribed, duration_ms).to_json()
    if align.aligner_available():
        try:
            words = align.ctc_align(audio_path, lines, language or "en", device)
            return align.assemble(lines, words, duration_ms).to_json()
        except Exception as e:  # noqa: BLE001 - model trouble must not lose the song
            warnings.append(f"Forced alignment failed ({e}); using fallback timing.")
    if all(ln.start is not None for ln in lines):
        warnings.append("Using line timings from LRC (words spread evenly). Install [ml] for word timing.")
        return align.from_lrc_timings(lines, duration_ms).to_json()
    warnings.append("No aligner installed: timing guessed from where vocals are audible. Review it in the editor.")
    regions = align.voiced_regions(decode_mono(audio_path, 16000), 16000)
    return align.from_voice_activity(lines, regions, duration_ms).to_json()
