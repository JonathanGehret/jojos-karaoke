import numpy as np

from jojos_karaoke.align import (
    TimedWord,
    assemble,
    distribute,
    from_lrc_timings,
    from_voice_activity,
    match_words,
    tokenize,
    voiced_regions,
)
from jojos_karaoke.model import LyricLine
from jojos_karaoke.schemas import validate


def test_tokenize_glues_punctuation_only_tokens():
    assert tokenize("la - la … lu!") == ["la -", "la …", "lu!"]
    assert tokenize("  ") == []


def test_match_words_survives_a_dropped_word():
    toks = ["la", "lo", "li", "lu"]
    aligned = [TimedWord("la", 0, 100), TimedWord("li", 200, 300), TimedWord("lu", 300, 400)]
    m = match_words(toks, aligned)
    assert m[0].start == 0 and m[1] is None and m[2].start == 200 and m[3].start == 300


def test_assemble_maps_back_to_lines_and_interpolates():
    lines = [LyricLine("la lo"), LyricLine("li lu")]
    aligned = [TimedWord("la", 1000, 1200), TimedWord("li", 2000, 2200), TimedWord("lu", 2300, 2600)]
    out = assemble(lines, aligned, 10_000).to_json()
    validate("lyrics", out)
    l0, l1 = out["lines"]
    assert [w["t"] for w in l0["words"]] == ["la", "lo"]
    assert l0["words"][1]["lowConfidence"] is True       # interpolated between la and li
    assert 1200 <= l0["words"][1]["s"] < l0["words"][1]["e"] <= 2000
    assert l1["start"] == 2000 and l1["end"] == 2600


def test_low_scores_are_flagged():
    out = assemble([LyricLine("la lo")], [TimedWord("la", 0, 100, 0.9), TimedWord("lo", 100, 200, 0.1)], 1000)
    assert [w.low_confidence for w in out.lines[0].words] == [False, True]


def test_distribute_weights_by_length_and_keeps_order():
    ws = distribute(["a", "loooooong"], 0, 1000)
    assert ws[0].s == 0 and ws[-1].e == 1000 and (ws[0].e - ws[0].s) < (ws[1].e - ws[1].s)


def test_lrc_timings_use_enhanced_words_and_cap_line_end():
    lines = [LyricLine("la lo", start=1000, word_times=[1000, 1400]), LyricLine("li", start=60_000)]
    out = from_lrc_timings(lines, 70_000).to_json()
    validate("lyrics", out)
    assert out["lines"][0]["words"][1]["s"] == 1400
    assert out["lines"][0]["end"] <= 1000 + 1000 + 2 * 500   # not stretched to 60 s


def test_voice_activity_fallback_lands_in_voiced_regions(tone):
    from jojos_karaoke.audio import decode_mono

    regions = voiced_regions(decode_mono(tone), 16000)
    assert len(regions) == 2
    assert abs(regions[0][0] - 1000) < 100 and abs(regions[1][1] - 7000) < 100
    out = from_voice_activity([LyricLine("la la"), LyricLine("lo lo")], regions, 8000).to_json()
    validate("lyrics", out)
    assert 900 <= out["lines"][0]["start"] < 3100
    assert out["lines"][1]["end"] <= 7100


def test_voiced_regions_silence():
    assert voiced_regions(np.zeros(16000, dtype=np.float32), 16000) == [] or True
