"""Reference pitch contour of the vocal stem (YIN), for the singing score."""

from __future__ import annotations

import numpy as np

SR = 16000
HOP_MS = 20
FRAME = 1024  # 64 ms
FMIN, FMAX = 70.0, 1100.0
THRESHOLD = 0.15


def yin_frame(frame: np.ndarray, sr: int = SR) -> tuple[float | None, float]:
    """Fundamental frequency (Hz) of one frame, or None when unvoiced; plus the aperiodicity.
    Standard YIN: difference function, cumulative mean normalisation, absolute threshold,
    parabolic interpolation."""
    n = len(frame)
    w = n // 2
    tau_min, tau_max = int(sr / FMAX), min(int(sr / FMIN), w)
    size = 1 << (2 * n - 1).bit_length()
    # cross term c[tau] = sum_{j<w} x[j] * x[j+tau]
    c = np.fft.irfft(np.fft.rfft(frame, size) * np.conj(np.fft.rfft(frame[:w], size)), size)[: tau_max + 1]
    cs = np.concatenate(([0.0], np.cumsum(frame ** 2)))
    e1 = cs[w]
    taus = np.arange(tau_max + 1)
    e2 = cs[taus + w] - cs[taus]
    d = e1 + e2 - 2 * c
    d[0] = 0.0
    cmnd = np.ones(tau_max + 1)
    running = np.cumsum(d[1:])
    cmnd[1:] = d[1:] * taus[1:] / np.maximum(running, 1e-12)
    cand = np.where(cmnd[tau_min:] < THRESHOLD)[0]
    if len(cand) == 0:
        return None, float(cmnd[tau_min:].min())
    tau = int(cand[0] + tau_min)
    while tau + 1 <= tau_max and cmnd[tau + 1] < cmnd[tau]:
        tau += 1
    shift = 0.0
    if 1 <= tau < tau_max:
        a, b, cc = cmnd[tau - 1], cmnd[tau], cmnd[tau + 1]
        den = a - 2 * b + cc
        if den != 0:
            shift = 0.5 * (a - cc) / den
    return sr / (tau + shift), float(cmnd[tau])


def hz_to_midi(f: float) -> float:
    return 69 + 12 * np.log2(f / 440.0)


def contour(x: np.ndarray, sr: int = SR, hop_ms: int = HOP_MS) -> list[float | None]:
    hop = sr * hop_ms // 1000
    out: list[float | None] = []
    rms_all = np.sqrt(np.mean(x ** 2) + 1e-12)
    gate = rms_all * 0.15
    for i in range(0, max(0, len(x) - FRAME) + 1, hop):
        fr = x[i: i + FRAME]
        if np.sqrt(np.mean(fr ** 2)) < gate:
            out.append(None)
            continue
        f0, _ = yin_frame(fr.astype(np.float64), sr)
        out.append(None if f0 is None else round(float(hz_to_midi(f0)), 1))
    return out


def pitch_json(vocals_path: str) -> dict:
    from .audio import decode_mono

    return {"version": 1, "hopMs": HOP_MS, "midi": contour(decode_mono(vocals_path, SR))}
