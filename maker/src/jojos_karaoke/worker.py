"""`jojo worker`: take on-the-spot song requests from a room and process them locally."""

from __future__ import annotations

import asyncio
import json
import os
import random
import tempfile
import urllib.parse

from .config import Config
from .library import Library, RoomClient
from .pipeline import Options, make

IDLE_POLL_S = 5


def ws_url(server: str, room: str, token: str) -> str:
    u = urllib.parse.urlparse(server)
    scheme = "wss" if u.scheme == "https" else "ws"
    q = urllib.parse.urlencode({"role": "worker", "token": token, "nickname": "worker"})
    return f"{scheme}://{u.netloc}{u.path.rstrip('/')}/api/rooms/{room.upper()}/ws?{q}"


async def run_job(job: dict, room: str, client: RoomClient, send, base_opts: Options,
                  library: Library | None = None) -> str:
    loop = asyncio.get_running_loop()
    with tempfile.TemporaryDirectory(prefix="jojo-job-") as td:
        src = os.path.join(td, "upload")
        await asyncio.to_thread(client.download_upload, room, job["uploadId"], src)

        def progress(stage, pct, eta):
            loop.call_soon_threadsafe(asyncio.ensure_future, send(
                {"type": "job.progress", "jobId": job["id"], "stage": stage, "pct": pct, "etaS": eta}))

        opts = Options(**{**base_opts.__dict__, "title": job.get("title") or None,
                          "artist": job.get("artist") or "", "lyrics_text": job.get("lyrics"),
                          "out_dir": td, "video": False})
        res = await asyncio.to_thread(make, src, opts, progress)
        # hand the package to the room: the host screen keeps it on its device and the guest
        # who brought the song can download it
        await asyncio.to_thread(client.put_result, room, job["id"], res.package)
        if library is not None:
            await asyncio.to_thread(library.upload_package, res.package)
        return res.manifest["id"]


async def serve(room: str, cfg: Config | None = None, base_opts: Options | None = None,
                once: bool = False, log=print, key: str | None = None, to_library: bool = False) -> None:
    import websockets

    cfg = cfg or Config.load()
    room = room.strip().upper()
    token = key or cfg.token or ""
    client = RoomClient(cfg.server, token)
    library = Library(cfg) if to_library else None
    base_opts = base_opts or Options()
    backoff = 1
    while True:
        try:
            async with websockets.connect(ws_url(cfg.server, room, token), open_timeout=15,
                                          ping_interval=20, ping_timeout=20) as ws:
                backoff = 1
                log(f"Connected to room {room.upper()}. Waiting for song requests…")

                async def send(msg):
                    await ws.send(json.dumps(msg))

                busy = False
                await send({"type": "job.claim"})
                while True:
                    try:
                        raw = await asyncio.wait_for(ws.recv(), IDLE_POLL_S)
                    except asyncio.TimeoutError:
                        if not busy:
                            await send({"type": "job.claim"})
                        continue
                    msg = json.loads(raw)
                    if msg.get("type") == "kicked":
                        log("Removed from the room.")
                        return
                    if msg.get("type") == "error":
                        log(f"Room: {msg.get('message')}")
                    if msg.get("type") != "job" or not msg.get("job") or busy:
                        continue
                    job = msg["job"]
                    busy = True
                    log(f"Processing request: {job.get('artist', '')} - {job.get('title', '')}")
                    try:
                        sid = await run_job(job, room, client, send, base_opts, library)
                        await send({"type": "job.done", "jobId": job["id"], "songId": sid})
                        log(f"Done: {sid}")
                    except Exception as e:  # noqa: BLE001
                        await send({"type": "job.failed", "jobId": job["id"], "error": str(e)[:300]})
                        log(f"Failed: {e}")
                    busy = False
                    if once:
                        return
                    await send({"type": "job.claim"})
        except (OSError, asyncio.TimeoutError) as e:
            log(f"Connection lost ({e}); retrying in {backoff}s")
        except Exception as e:  # websockets.ConnectionClosed and friends
            if once:
                raise
            log(f"Connection closed ({e}); retrying in {backoff}s")
        await asyncio.sleep(backoff + random.random())
        backoff = min(60, backoff * 2)
