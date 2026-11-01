"""Server URL + library token, stored per user. Env vars JOJO_SERVER / JOJO_TOKEN override."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass

DEFAULT_SERVER = "https://jojos-karaoke.workers.dev"


def config_path() -> str:
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
    return os.path.join(base, "jojos-karaoke", "config.json")


@dataclass
class Config:
    server: str = DEFAULT_SERVER
    token: str | None = None

    @classmethod
    def load(cls) -> Config:
        c = cls()
        try:
            with open(config_path(), encoding="utf-8") as f:
                d = json.load(f)
            c.server = d.get("server") or c.server
            c.token = d.get("token")
        except (OSError, ValueError):
            pass
        c.server = os.environ.get("JOJO_SERVER", c.server).rstrip("/")
        c.token = os.environ.get("JOJO_TOKEN", c.token)
        return c

    def save(self) -> None:
        p = config_path()
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            json.dump({"server": self.server, "token": self.token}, f, indent=1)
        try:
            os.chmod(p, 0o600)
        except OSError:
            pass
