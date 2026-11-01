import json

from jojos_karaoke import cli
from jojos_karaoke.package import read_package
from jojos_karaoke.pipeline import Options, make


def test_make_without_models(tmp_path, tone):
    """Whole pipeline with no ML installed: passthrough separation, user lyrics,
    voice-activity timing, package + video."""
    lyr = tmp_path / "l.txt"
    lyr.write_text("la la\n\nlo lo\n")
    stages = []
    res = make(tone, Options(lyrics_path=str(lyr), separator="none", lookup=False, video=True,
                             out_dir=str(tmp_path)), lambda s, p, e: stages.append((s, p)))
    pkg = read_package(res.package)
    assert pkg.manifest["title"] == "Test Tone" and pkg.manifest["artist"] == "Nobody"
    assert pkg.manifest["lyricsSource"] == "user"
    assert "vocals" not in pkg.manifest["files"]           # passthrough: no vocal stem
    assert [w["t"] for ln in pkg.lyrics["lines"] for w in ln["words"]] == ["la", "la", "lo", "lo"]
    assert res.video and res.video.endswith(".mp4")
    pcts = [p for _, p in stages]
    assert pcts == sorted(pcts) and stages[-1] == ("done", 100.0)
    assert any("guessed" in w for w in res.warnings)


def test_lrc_input_uses_line_timings(tmp_path, tone):
    lrc = tmp_path / "l.lrc"
    lrc.write_text("[00:01.00]la la\n[00:05.00]lo lo\n")
    res = make(tone, Options(lyrics_path=str(lrc), separator="none", lookup=False, pitch=False,
                             out_dir=str(tmp_path)))
    assert [ln["start"] for ln in res.lyrics["lines"]] == [1000, 5000]


def test_cli_make_and_lrc(tmp_path, tone, capsys):
    lyr = tmp_path / "l.txt"
    lyr.write_text("la la\n")
    assert cli.main(["make", tone, "--lyrics", str(lyr), "--separator", "none", "--no-lookup",
                     "-q", "--lrc", "-o", str(tmp_path)]) == 0
    jkp = next(tmp_path.glob("*.jkp"))
    assert next(tmp_path.glob("*.lrc"))
    capsys.readouterr()
    assert cli.main(["lrc", str(jkp)]) == 0
    assert "la" in capsys.readouterr().out


def test_cli_error_is_friendly(tmp_path, capsys):
    assert cli.main(["make", str(tmp_path / "missing.mp3"), "--separator", "none", "-q"]) == 1
    assert "error:" in capsys.readouterr().err


def test_doctor_runs(capsys):
    cli.main(["doctor"])
    assert "ffmpeg" in capsys.readouterr().out


def test_lyrics_text_option(tmp_path, tone):
    res = make(tone, Options(lyrics_text="[00:01.00]la\n[00:05.00]lo\n", separator="none",
                             lookup=False, pitch=False, out_dir=str(tmp_path)))
    assert json.dumps(res.lyrics).count('"t"') == 2
