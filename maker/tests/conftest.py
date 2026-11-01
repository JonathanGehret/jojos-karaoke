import subprocess

import pytest


@pytest.fixture(scope="session")
def tone(tmp_path_factory):
    """8 s test signal: silence, 2 s of a 220 Hz tone, silence, 2 s of 330 Hz, silence.
    Stands in for a vocal stem (no real music anywhere in the tests)."""
    p = tmp_path_factory.mktemp("audio") / "tone.wav"
    expr = "if(between(t,1,3),0.5*sin(2*PI*220*t),if(between(t,5,7),0.5*sin(2*PI*330*t),0))"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i",
                    f"aevalsrc='{expr}':s=44100:d=8", "-metadata", "title=Test Tone",
                    "-metadata", "artist=Nobody", str(p)], check=True)
    return str(p)
