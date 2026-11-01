"""Load and apply the JSON Schemas from spec/."""

from __future__ import annotations

import json
import os
from functools import cache

import jsonschema


def spec_dir() -> str:
    here = os.path.dirname(__file__)
    bundled = os.path.join(here, "spec")
    if os.path.isdir(bundled):
        return bundled
    return os.path.abspath(os.path.join(here, "..", "..", "..", "spec"))  # repo checkout


@cache
def schema(name: str) -> dict:
    with open(os.path.join(spec_dir(), f"{name}.schema.json"), encoding="utf-8") as f:
        return json.load(f)


def validate(name: str, doc: dict) -> None:
    jsonschema.validate(doc, schema(name))
    if name == "lyrics":
        prev = 0
        for i, ln in enumerate(doc["lines"]):
            for w in ln["words"]:
                if w["e"] < w["s"] or w["s"] < prev:
                    raise jsonschema.ValidationError(f"line {i}: word times go backwards at {w['t']!r}")
                prev = w["s"]
