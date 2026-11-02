from jojos_karaoke.separate import auto_backend

ALL = ["roformer", "fast", "demucs"]


def test_gpu_prefers_roformer():
    assert auto_backend(ALL, "cuda") == "roformer"
    assert auto_backend(ALL, "mps") == "roformer"


def test_cpu_prefers_fast_model():
    assert auto_backend(ALL, "cpu") == "fast"


def test_demucs_only_and_nothing():
    assert auto_backend(["demucs"], "cpu") == "demucs"
    assert auto_backend([], "cuda") == ""
