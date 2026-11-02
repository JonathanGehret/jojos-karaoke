"""`jojo` command line."""

from __future__ import annotations

import argparse
import asyncio
import getpass
import json
import os
import shutil
import sys

from . import __version__


def _bar(stage: str, pct: float, eta) -> None:
    width = 30
    fill = int(width * pct / 100)
    eta_s = f" ~{int(eta) // 60}:{int(eta) % 60:02d} left" if eta else ""
    sys.stderr.write(f"\r[{'#' * fill}{'.' * (width - fill)}] {pct:5.1f}% {stage:<9}{eta_s}   ")
    if stage == "done":
        sys.stderr.write("\n")
    sys.stderr.flush()


def cmd_make(a) -> int:
    from .pipeline import Options, make

    opts = Options(lyrics_path=a.lyrics, title=a.title, artist=a.artist, language=a.lang,
                   separator=a.separator, model=a.model, device=a.device, lookup=not a.no_lookup,
                   allow_transcribe=not a.no_transcribe, pitch=a.pitch, duets=a.duets,
                   video=a.video, video_background=a.background, out_dir=a.out)
    for src in a.songs:
        print(f"♪ {src}")
        res = make(src, opts, None if a.quiet else _bar)
        for w in res.warnings:
            print(f"  ! {w}")
        print(f"  → {res.package}" + (f"\n  → {res.video}" if res.video else ""))
        if a.lrc:
            from .lrc import to_lrc

            p = os.path.splitext(res.package)[0] + ".lrc"
            with open(p, "w", encoding="utf-8") as f:
                f.write(to_lrc(res.lyrics, res.manifest["title"], res.manifest["artist"]))
            print(f"  → {p}")
        if a.upload:
            from .library import Library

            sid = Library().upload_package(res.package)
            print(f"  ↑ uploaded to your library as {sid}")
    return 0


def cmd_video(a) -> int:
    import tempfile

    from .package import read_package
    from .video import render_video

    pkg = read_package(a.package)
    with tempfile.TemporaryDirectory() as td:
        inst = os.path.join(td, "instrumental.opus")
        with open(inst, "wb") as f:
            f.write(pkg.files["instrumental.opus"])
        bg = a.background
        if not bg and "cover.jpg" in pkg.files:
            bg = os.path.join(td, "cover.jpg")
            with open(bg, "wb") as f:
                f.write(pkg.files["cover.jpg"])
        out = a.out or os.path.splitext(a.package)[0] + ".mp4"
        render_video(pkg.lyrics, inst, out, title=pkg.manifest["title"], artist=pkg.manifest["artist"],
                     background=bg)
    print(f"→ {out}")
    return 0


def cmd_lrc(a) -> int:
    from .lrc import to_lrc
    from .package import read_package

    pkg = read_package(a.package)
    sys.stdout.write(to_lrc(pkg.lyrics, pkg.manifest["title"], pkg.manifest["artist"], not a.plain))
    return 0


def cmd_doctor(a) -> int:
    from . import align, separate, transcribe
    from .config import Config, config_path
    from .devices import describe

    ok = True

    def row(name, good, detail):
        nonlocal ok
        ok &= bool(good) or name.startswith("(optional)")
        print(f"  {'✓' if good else '✗'} {name:<28} {detail}")

    print(f"jojos-karaoke {__version__}, Python {sys.version.split()[0]}")
    ff = shutil.which("ffmpeg")
    row("ffmpeg", ff, ff or "missing: winget/brew/apt install ffmpeg")
    row("compute device", True, describe())
    seps = separate.available_backends()
    row("vocal separation", seps, ", ".join(seps) or "not installed: uv tool install 'jojos-karaoke[ml]'")
    row("(optional) word alignment", align.aligner_available(),
        "ctc-forced-aligner" if align.aligner_available() else "not installed (fallback timing is used)")
    row("(optional) transcription", transcribe.available(),
        "faster-whisper" if transcribe.available() else "not installed (needs lyrics text)")
    row("model cache", True, os.path.join(separate.cache_dir(), "models"))
    cfg = Config.load()
    if cfg.token:
        try:
            from .library import Library

            me = Library(cfg).whoami()
            row("library login", True, f"{me.get('name')} @ {cfg.server}")
        except Exception as e:  # noqa: BLE001
            row("library login", False, str(e))
    else:
        row("(optional) library login", False, f"not logged in ({config_path()})")
    return 0 if ok else 1


def cmd_login(a) -> int:
    from .config import Config
    from .library import Library

    cfg = Config.load()
    if a.server:
        cfg.server = a.server.rstrip("/")
    cfg.token = a.token or getpass.getpass("Library token (from the app: Settings → Maker token): ").strip()
    me = Library(cfg).whoami()
    cfg.save()
    print(f"Logged in as {me.get('name')} ({me.get('role')}) at {cfg.server}")
    return 0


def cmd_logout(a) -> int:
    from .config import Config

    cfg = Config.load()
    cfg.token = None
    cfg.save()
    print("Logged out.")
    return 0


def cmd_library(a) -> int:
    from .library import Library

    lib = Library()
    if a.delete:
        lib.delete(a.delete)
        print(f"Deleted {a.delete}")
        return 0
    songs = lib.songs()
    if a.json:
        print(json.dumps(songs, indent=1))
    for s in songs:
        print(f"{s['id']:<48} {s.get('artist', '')} - {s['title']}")
    return 0


def cmd_upload(a) -> int:
    from .library import Library

    lib = Library()
    for p in a.packages:
        print(f"↑ {lib.upload_package(p)}")
    return 0


def cmd_worker(a) -> int:
    from .config import Config
    from .pipeline import Options
    from .worker import serve

    opts = Options(separator=a.separator, device=a.device, language=a.lang)
    cfg = Config.load()
    if a.server:
        cfg.server = a.server.rstrip("/")
    try:
        asyncio.run(serve(a.room, cfg, base_opts=opts, once=a.once, key=a.key, to_library=a.library))
    except KeyboardInterrupt:
        pass
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="jojo", description="Jojo's Karaoke maker")
    p.add_argument("--version", action="version", version=f"jojos-karaoke {__version__}")
    sub = p.add_subparsers(dest="cmd", required=True)

    m = sub.add_parser("make", help="song file(s) → karaoke package")
    m.add_argument("songs", nargs="+")
    m.add_argument("--lyrics", help="lyrics .txt or .lrc (otherwise looked up, then transcribed)")
    m.add_argument("--title")
    m.add_argument("--artist")
    m.add_argument("--lang", help="language code, e.g. en, de")
    m.add_argument("--separator", default="auto", choices=["auto", "roformer", "demucs", "fast", "none"])
    m.add_argument("--model", help="override the separation model file")
    m.add_argument("--device", default="auto", choices=["auto", "cuda", "mps", "cpu"])
    m.add_argument("--no-lookup", action="store_true", help="don't look lyrics up on LRCLIB")
    m.add_argument("--no-transcribe", action="store_true")
    m.add_argument("--pitch", action="store_true", help="also store the vocal pitch contour (for future scoring)")
    m.add_argument("--duets", action="store_true", help='plain lyrics use "A: …" / "B: …" singer prefixes')
    m.add_argument("--video", action="store_true", help="also render an MP4")
    m.add_argument("--background", help="image for the video background")
    m.add_argument("--lrc", action="store_true", help="also write an enhanced .lrc")
    m.add_argument("--upload", action="store_true", help="upload to your online library")
    m.add_argument("-o", "--out", default=".")
    m.add_argument("-q", "--quiet", action="store_true")
    m.set_defaults(fn=cmd_make)

    v = sub.add_parser("video", help="render an MP4 from a package")
    v.add_argument("package")
    v.add_argument("--background")
    v.add_argument("-o", "--out")
    v.set_defaults(fn=cmd_video)

    lr = sub.add_parser("lrc", help="print a package's lyrics as LRC")
    lr.add_argument("package")
    lr.add_argument("--plain", action="store_true", help="line timing only")
    lr.set_defaults(fn=cmd_lrc)

    sub.add_parser("doctor", help="check the installation").set_defaults(fn=cmd_doctor)

    li = sub.add_parser("login", help="connect to your online library")
    li.add_argument("--server")
    li.add_argument("--token")
    li.set_defaults(fn=cmd_login)
    sub.add_parser("logout").set_defaults(fn=cmd_logout)

    lb = sub.add_parser("library", help="list (or --delete) songs in your library")
    lb.add_argument("--delete", metavar="SONG_ID")
    lb.add_argument("--json", action="store_true")
    lb.set_defaults(fn=cmd_library)

    up = sub.add_parser("upload", help="upload existing .jkp packages")
    up.add_argument("packages", nargs="+")
    up.set_defaults(fn=cmd_upload)

    w = sub.add_parser("worker", help="process on-the-spot song requests for a room")
    w.add_argument("--room", required=True)
    w.add_argument("--key", help="the room's helper key (shown on the host screen); not needed after `jojo login`")
    w.add_argument("--server", help="app URL (default: from `jojo login`)")
    w.add_argument("--library", action="store_true", help="also add each song to your online library")
    w.add_argument("--separator", default="auto", choices=["auto", "roformer", "demucs", "fast", "none"])
    w.add_argument("--device", default="auto", choices=["auto", "cuda", "mps", "cpu"])
    w.add_argument("--lang")
    w.add_argument("--once", action="store_true", help=argparse.SUPPRESS)
    w.set_defaults(fn=cmd_worker)
    return p


def main(argv: list[str] | None = None) -> int:
    # Windows consoles default to a legacy codepage that can't print ✓/✗ or the progress bar
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")
    a = build_parser().parse_args(argv)
    try:
        return a.fn(a)
    except Exception as e:  # noqa: BLE001
        if os.environ.get("JOJO_DEBUG"):
            raise
        print(f"error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
