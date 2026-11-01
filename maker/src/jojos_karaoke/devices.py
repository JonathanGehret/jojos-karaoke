"""Pick the fastest available compute device."""

from __future__ import annotations


def best_device(prefer: str | None = None) -> str:
    if prefer and prefer != "auto":
        return prefer
    try:
        import torch
    except ImportError:
        return "cpu"
    if torch.cuda.is_available():
        return "cuda"
    mps = getattr(torch.backends, "mps", None)
    if mps is not None and mps.is_available():
        return "mps"
    return "cpu"


def describe() -> str:
    try:
        import torch
    except ImportError:
        return "cpu (PyTorch not installed: install with `uv tool install 'jojos-karaoke[ml]'`)"
    dev = best_device()
    if dev == "cuda":
        return f"cuda ({torch.cuda.get_device_name(0)})"
    return dev
