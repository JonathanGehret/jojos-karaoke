import asyncio
import json
import os

from jojos_karaoke.config import Config
from jojos_karaoke.pipeline import Options
from jojos_karaoke.worker import serve, ws_url


def test_ws_url():
    assert ws_url("https://x.dev", "k7q2", "t") == "wss://x.dev/api/rooms/K7Q2/ws?role=worker&token=t&nickname=worker"
    assert ws_url("http://localhost:8787", "AB", "t").startswith("ws://localhost:8787/api/rooms/AB/ws")


def test_worker_processes_one_job(tmp_path, tone, monkeypatch):
    """Fake room server: offers one job, expects progress then job.done with the uploaded id."""
    import websockets

    uploaded = {}

    class FakeLib:
        def __init__(self, cfg):
            pass

        def download_upload(self, room, upload_id, dst):
            assert (room, upload_id) == ("AB12", "up1")
            with open(tone, "rb") as s, open(dst, "wb") as d:
                d.write(s.read())
            return dst

        def upload_package(self, path):
            uploaded["path"] = path
            assert os.path.exists(path)
            return "nobody-req-abc123"

    monkeypatch.setattr("jojos_karaoke.worker.Library", FakeLib)
    got = []

    async def handler(ws):
        async for raw in ws:
            msg = json.loads(raw)
            got.append(msg)
            if msg["type"] == "job.claim" and not any(m["type"] == "job.done" for m in got):
                await ws.send(json.dumps({"type": "job", "job": {
                    "id": "j1", "uploadId": "up1", "title": "Req", "artist": "Nobody",
                    "lyrics": "la la\nlo lo", "queueItemId": "q1", "state": "claimed"}}))

    async def main():
        async with websockets.serve(handler, "127.0.0.1", 0) as srv:
            port = srv.sockets[0].getsockname()[1]
            cfg = Config(server=f"http://127.0.0.1:{port}", token="t")
            await asyncio.wait_for(serve("ab12", cfg, Options(separator="none", lookup=False, pitch=False),
                                         once=True, log=lambda *_: None), 60)

    asyncio.run(main())
    types = [m["type"] for m in got]
    assert "job.failed" not in types, got
    assert "job.progress" in types
    done = [m for m in got if m["type"] == "job.done"]
    assert done == [{"type": "job.done", "jobId": "j1", "songId": "nobody-req-abc123"}]
