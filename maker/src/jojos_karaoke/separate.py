"""Vocal separation: song → instrumental + vocals (WAV), then encoded by the pipeline."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from collections.abc import Callable
from dataclasses import dataclass

MODELS = {
    # audio-separator model files. RoFormer models are the current state of the art for vocals.
    "roformer": "model_bs_roformer_ep_317_sdr_12.9755.ckpt",
    "fast": "UVR-MDX-NET-Inst_HQ_3.onnx",
}


@dataclass
class Stems:
    instrumental: str
    vocals: str | None
    model: str


class SeparatorUnavailable(RuntimeError):
    pass


def available_backends() -> list[str]:
    out = []
    try:
        import audio_separator  # noqa: F401
        out += ["roformer", "fast"]
    except ImportError:
        pass
    try:
        import demucs  # noqa: F401
        out.append("demucs")
    except ImportError:
        pass
    return out


def _audio_separator(src: str, outdir: str, model_file: str) -> Stems:
    from audio_separator.separator import Separator

    sep = Separator(output_dir=outdir, output_format="WAV",
                    model_file_dir=os.environ.get("JOJO_MODEL_DIR") or os.path.join(cache_dir(), "models"))
    sep.load_model(model_filename=model_file)
    files = [f if os.path.isabs(f) else os.path.join(outdir, f) for f in sep.separate(src)]
    voc = next((f for f in files if "(vocals)" in os.path.basename(f).lower()), None)
    inst = next((f for f in files if "(instrumental)" in os.path.basename(f).lower()
                 or "(no_vocals)" in os.path.basename(f).lower()), None)
    if not inst:
        raise RuntimeError(f"separator produced no instrumental stem: {files}")
    return Stems(inst, voc, model_file)


def _demucs(src: str, outdir: str, model: str = "htdemucs_ft", device: str = "cpu") -> Stems:
    cmd = [sys.executable, "-m", "demucs", "--two-stems=vocals", "-n", model, "-o", outdir, src]
    if device in ("cuda", "mps"):
        cmd += ["-d", device]
    subprocess.run(cmd, check=True)
    base = os.path.splitext(os.path.basename(src))[0]
    d = os.path.join(outdir, model, base)
    return Stems(os.path.join(d, "no_vocals.wav"), os.path.join(d, "vocals.wav"), f"demucs:{model}")


def _passthrough(src: str, outdir: str) -> Stems:
    """No separation (for testing, or tracks that are already instrumental)."""
    dst = os.path.join(outdir, "instrumental" + os.path.splitext(src)[1])
    shutil.copyfile(src, dst)
    return Stems(dst, None, "none")


Backend = Callable[[str, str], Stems]


def separate(src: str, outdir: str, backend: str = "auto", device: str = "cpu",
             model: str | None = None) -> Stems:
    os.makedirs(outdir, exist_ok=True)
    have = available_backends()
    if backend == "auto":
        backend = "roformer" if "roformer" in have else ("demucs" if "demucs" in have else "")
        if not backend:
            raise SeparatorUnavailable(
                "No vocal separation model installed. Run: uv tool install 'jojos-karaoke[ml]' "
                "(or --separator none to skip)."
            )
    if backend == "none":
        return _passthrough(src, outdir)
    if backend in ("roformer", "fast"):
        if backend not in have:
            raise SeparatorUnavailable("audio-separator is not installed (pip install 'jojos-karaoke[ml]').")
        return _audio_separator(src, outdir, model or MODELS[backend])
    if backend == "demucs":
        if "demucs" not in have:
            raise SeparatorUnavailable("demucs is not installed (pip install 'jojos-karaoke[ml]').")
        return _demucs(src, outdir, model or "htdemucs_ft", device)
    raise ValueError(f"unknown separator {backend!r}")


def cache_dir() -> str:
    base = os.environ.get("XDG_CACHE_HOME") or os.path.join(os.path.expanduser("~"), ".cache")
    return os.path.join(base, "jojos-karaoke")
