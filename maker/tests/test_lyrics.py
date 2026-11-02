from jojos_karaoke import lyrics as lyr
from jojos_karaoke.lyrics import (
    clean_title,
    looks_like_lrc,
    main_artist,
    parse_lrc,
    parse_text,
    pick_lrclib_candidate,
)


def test_plain_text_drops_blanks_and_sections():
    lines = parse_text("[Chorus]\nla la la\n\n(x2)\ndo re mi\n")
    assert [ln.text for ln in lines] == ["la la la", "do re mi"]


def test_singer_prefixes_only_when_enabled():
    assert parse_text("A: la la")[0].text == "A: la la"
    ln = parse_text("A: la la\nB: do re", singer_prefixes=True)
    assert [(x.singer, x.text) for x in ln] == [("A", "la la"), ("B", "do re")]


def test_lrc_lines_offset_and_repeats():
    text = "[ti:x]\n[offset:+500]\n[00:01.00]la la\n[00:03.50][00:10.00]do re\n"
    assert looks_like_lrc(text)
    lines = parse_lrc(text)
    assert [(ln.start, ln.text) for ln in lines] == [(500, "la la"), (3000, "do re"), (9500, "do re")]


def test_enhanced_lrc_word_times():
    lines = parse_lrc("[00:01.00]<00:01.00>la <00:01.50>lu lo <00:02.40>li\n[00:05.00]x y")
    assert lines[0].text == "la lu lo li"
    assert lines[0].word_times == [1000, 1500, -1, 2400]
    assert lines[1].word_times is None


def test_lrclib_candidate_prefers_synced_and_close_duration():
    c = [
        {"duration": 200, "plainLyrics": "a"},
        {"duration": 260, "syncedLyrics": "[00:01.00]b"},
        {"duration": 203, "syncedLyrics": "[00:01.00]c"},
        {"duration": 201, "instrumental": True},
    ]
    assert pick_lrclib_candidate(c, 201)["syncedLyrics"].endswith("c")
    assert pick_lrclib_candidate(c, None)["syncedLyrics"]
    assert pick_lrclib_candidate([{"duration": 100, "plainLyrics": "a"}], 300) is None


def test_clean_title_and_main_artist():
    assert clean_title("Some Song (Official Video)") == "Some Song"
    assert clean_title("Some Song [Remastered 2011]") == "Some Song"
    assert clean_title("Some Song - 2009 Remaster") == "Some Song"
    assert clean_title("Some Song feat. Somebody") == "Some Song"
    assert clean_title("(Live)") == "(Live)"
    assert main_artist("Band A feat. Band B") == "Band A"
    assert main_artist("Duo One & Duo Two") == "Duo One"


def test_lrclib_candidate_skips_other_songs_from_loose_search():
    c = [{"trackName": "Different Thing", "artistName": "Someone Else", "duration": 200, "syncedLyrics": "[00:01.00]x"},
         {"trackName": "Placeholder Song", "artistName": "Test Band", "duration": 201, "plainLyrics": "y"}]
    best = pick_lrclib_candidate(c, 200, "Placeholder Song (Official Video)", "Test Band")
    assert best["plainLyrics"] == "y"
    assert pick_lrclib_candidate(c[:1], 200, "Placeholder Song", "Test Band") is None


def test_fetch_lrclib_falls_back_to_free_text_search(monkeypatch):
    calls = []

    def fake(url, timeout):
        calls.append(url)
        if "q=" in url:
            return [{"trackName": "Placeholder Song", "artistName": "Test Band", "duration": 180,
                     "syncedLyrics": "[00:01.00]la"}]
        return []

    monkeypatch.setattr(lyr, "_get_json", fake)
    synced, _ = lyr.fetch_lrclib("Test Band", "Placeholder Song (Lyrics)", None)
    assert synced == "[00:01.00]la"
    assert "track_name=Placeholder+Song&" in calls[0] and "q=" in calls[-1]
