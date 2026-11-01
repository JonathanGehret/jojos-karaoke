import json
import os
import shutil
import zipfile

import jsonschema
import pytest

from jojos_karaoke.package import build_manifest, read_package, slugify, song_id, write_package
from jojos_karaoke.schemas import spec_dir, validate

LYR = {"version": 1, "lines": [{"start": 0, "end": 500, "words": [{"t": "la", "s": 0, "e": 500}]}]}


def test_spec_examples_validate():
    for name in ("manifest", "lyrics"):
        with open(os.path.join(spec_dir(), "examples", f"{name}.json")) as f:
            validate(name, json.load(f))


def test_backwards_times_rejected():
    bad = {"version": 1, "lines": [{"start": 0, "end": 9, "words": [{"t": "a", "s": 5, "e": 9}, {"t": "b", "s": 1, "e": 2}]}]}
    with pytest.raises(jsonschema.ValidationError):
        validate("lyrics", bad)


def test_slug_and_id():
    assert slugify("Ünïcode Söng!!") == "unicode-song"
    assert song_id("T", "A").startswith("a-t-")


def test_roundtrip(tmp_path):
    inst = tmp_path / "i.opus"
    inst.write_bytes(b"OggS-fake")
    m = build_manifest(sid="a-t-123abc", title="T", artist="A", duration_ms=1000, language="en",
                       lyrics_source="user", has_vocals=False, has_pitch=True, cover=None, model="none")
    p = write_package(str(tmp_path / "x.jkp"), m, LYR, {"instrumental.opus": str(inst)},
                      {"version": 1, "hopMs": 20, "midi": [None, 60.5]})
    pkg = read_package(p)
    assert pkg.manifest["id"] == "a-t-123abc" and pkg.files["instrumental.opus"] == b"OggS-fake"
    assert pkg.pitch["midi"] == [None, 60.5]
    with zipfile.ZipFile(p) as z:
        assert z.getinfo("instrumental.opus").compress_type == zipfile.ZIP_STORED


def test_missing_member_rejected(tmp_path):
    m = build_manifest(sid="a-t-123abc", title="T", artist="A", duration_ms=1000, language=None,
                       lyrics_source="user", has_vocals=True, has_pitch=False, cover=None, model="none")
    with pytest.raises(ValueError):
        write_package(str(tmp_path / "x.jkp"), m, LYR, {"instrumental.opus": shutil.which("python3")})
