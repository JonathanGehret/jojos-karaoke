import numpy as np

from jojos_karaoke.pitch import SR, contour, hz_to_midi, yin_frame


def test_yin_finds_a_sine():
    t = np.arange(1024) / SR
    for f in (110.0, 220.0, 440.0, 660.0):
        f0, ap = yin_frame(np.sin(2 * np.pi * f * t), SR)
        assert abs(f0 - f) / f < 0.01, f
        assert ap < 0.1


def test_noise_is_unvoiced():
    rng = np.random.default_rng(1)
    f0, _ = yin_frame(rng.standard_normal(1024), SR)
    assert f0 is None


def test_contour_on_tone(tone):
    from jojos_karaoke.audio import decode_mono

    c = contour(decode_mono(tone, SR))
    assert c[10] is None                                  # 0.2 s: silence
    assert abs(c[100] - hz_to_midi(220)) < 0.3            # 2.0 s: 220 Hz
    assert abs(c[300] - hz_to_midi(330)) < 0.3            # 6.0 s: 330 Hz
