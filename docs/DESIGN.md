# Jojo's Karaoke: design

## Decisions so far

| Question | Decision |
|---|---|
| Where does vocal removal run? | **Locally**, on the machine of whoever adds the song (host or friend). A hosted GPU server is a later option (issue, label `later`). |
| Where do songs live? | **Online only.** Processed packages are uploaded to a private library (Cloudflare R2) and streamed when played. No download/offline copy needed. |
| Can guests request songs that aren't in the library? | **Yes, on the spot.** A guest requests a song (and uploads their own copy of the audio from their phone); a processing worker on the host's or a friend's machine picks the job up and the song joins the queue when ready. |
| Player stack | **TypeScript + Svelte 5 + Vite + vite-plugin-pwa.** Small bundles, no virtual DOM, fast. The lyric highlight runs in its own `requestAnimationFrame` loop outside the framework. |
| Key/tempo | **SoundTouch AudioWorklet** (`@soundtouchjs/audio-worklet`, actively maintained). Tempo via the source `playbackRate`, which the worklet compensates so the key stays put. (The planned Rubber Band WASM port hasn't been updated since 2022.) |
| Queue authority | **The room server** owns the queue (fair insertion, limits); **the screen** owns playback. Simpler and safer than the host sending the full queue. |
| Rust? | Not for now (see below). |

### Why not Rust (for now)

- **Maker**: the slow part is neural networks (separation, transcription, alignment), which
  run on PyTorch/ONNX on the GPU. Rust wouldn't make them faster, and the best models and
  tools (audio-separator, Demucs, WhisperX, faster-whisper) are Python-first.
- **Player**: runs in the browser, so TypeScript. The heavy audio DSP (key/tempo) already
  exists as an AudioWorklet (SoundTouch).
- **Room server**: tiny message relay; TypeScript on Workers is the simplest path.
- **Where Rust would help**: a one-click desktop app for friends who don't want to install
  Python. That's a later issue (Tauri wrapping the maker).

---

## 1. Maker (`maker/`, Python 3.12, managed with `uv`)

```
song.mp3 ─► separate ─► instrumental + vocals
lyrics?  ─► given txt/lrc │ else fetch synced lyrics (LRCLIB) │ else transcribe vocals
          ─► align words to the vocal stem ─► package (.jkp) ─► upload to library
                                                            └─► optional MP4
```

| Step | Default | Fallback |
|---|---|---|
| Separate | `audio-separator` with a **RoFormer** vocal model (BS-RoFormer by default, `--model` to pick another) | Demucs `htdemucs_ft`; a lighter MDX model (`--separator fast`) for weak CPUs |
| Lyrics | user text / `.lrc` → LRCLIB lookup by artist/title/duration | faster-whisper `large-v3-turbo` on the vocal stem |
| Align | `ctc-forced-aligner` (MMS, 1000+ languages) for word timings; a sequence diff maps its words back onto the lyric lines so a dropped word doesn't shift the rest | LRC line timings; without any model, timing from where the vocal stem is audible (marked for review) |
| Video | ffmpeg + libass, ASS `\k` karaoke tags | — |

Picks CUDA / Apple Metal (MPS) / CPU automatically. Models download on first run.

Commands:
- `jojo make song.mp3 [--lyrics file] [--lang de] [--video] [--upload]`
- `jojo worker --room K7Q2` connects to a room and processes on-the-spot requests.

## 2. Package format (`.jkp`, a zip)

```
manifest.json      id, title, artist, durationMs, language, cover?, formatVersion
instrumental.opus  required
vocals.opus        optional (guide-vocal slider)
lyrics.json        lines → words with start/end ms; optional singer per line (duets)
cover.jpg          optional
```

```json
{ "lines": [ { "start": 12340, "end": 15800, "singer": "A",
               "words": [ { "t": "word", "s": 12340, "e": 12900 } ] } ] }
```

JSON Schemas live in `spec/` and are shared by maker, player and worker. Also exports
(enhanced) `.lrc`.

## 3. Player (`player/`)

### Host screen
Big two-line lyrics with word-by-word wipe, next-line preview, countdown dots after
instrumental gaps, duet colours. Shows the QR code, queue and "Up next: nickname, song".

Audio (Web Audio + AudioWorklet): instrumental and vocal stems play in sync; **guide vocal
slider**; **key ±6 semitones** and **tempo ±20 %** via the SoundTouch AudioWorklet; lyrics offset nudge
(per song and per device, for Bluetooth delay). Fullscreen, Screen Wake Lock.

### Guests (any phone browser, no install)
Scan QR → nickname → browse/search library → queue a song or **request a new one**
(upload audio from the phone) → synced lyrics on their own screen → "you're up next" alert.

### Queue rules
Host can reorder (pointer-events drag, works on touch), remove, skip, play next. **Fair
rotation**: round-robin by singer; optional max songs per person.

## 4. Room server (`room-worker/`, Cloudflare Worker + Durable Objects + R2)

- One Durable Object per room, WebSocket Hibernation API. Host gets a secret token at
  creation; host-only actions are checked server side.
- QR encodes `https://<app>/join/K7Q2`.
- **Only lyrics and timing travel to guests; audio plays only on the host**, so no echo.
- **Clock sync**: NTP-style pings on join, median offset to server time. The host publishes
  `{ songId, state, startAtServerMs, positionMs, rate }`; guests compute the position
  themselves. Re-sync on pause/seek/tempo change and every ~10 s. Target: within 50 ms.
- **Library**: packages in R2 under the owner's account; served via short-lived signed URLs
  to the host and members of the owner's room only.
- **Jobs**: on-the-spot requests become jobs in the room; a connected `jojo worker` claims
  one, downloads the uploaded audio, processes, uploads the package and the song enters the
  queue. Uploaded source audio is deleted after processing.

Messages (JSON over WebSocket; full list in `spec/protocol.md`):

| From | Type | Payload |
|---|---|---|
| guest | `join` | nickname |
| any | `ping` / `pong` | client time / server time |
| guest | `queue.add` | songId |
| guest | `request.add` | title, artist, uploadId |
| host | `queue.set` | full ordered queue (host is the authority) |
| host | `playback` | songId, state, startAtServerMs, positionMs, rate, key |
| worker | `job.claim` / `job.progress` / `job.done` | jobId, stage, songId |
| server | `room` | members, queue, playback, jobs (on join/reconnect) |

## 5. Repo layout

```
maker/         Python package + CLI (separate, lyrics, align, package, video, upload, worker)
player/        Svelte 5 + Vite PWA (host/, guest/, lib/ for lyrics renderer, audio, clock)
room-worker/   Cloudflare Worker + Durable Objects + R2
spec/          JSON Schemas for the package and the room protocol
docs/          this file
```

## 6. Milestones (issue labels)

- **M1 Maker**: separate → lyrics → align → package (+ MP4). Proves quality.
- **M2 Solo player**: play a package with all audio and lyric features.
- **M3 Rooms & library**: online library, rooms, QR join, synced lyrics, shared queue.
- **M4 On-the-spot requests**: upload from phone, processing worker, job status in queue.
- **M5 / later**: reactions and casting (done); hosted GPU server, singing scores (#22), desktop app, in-browser processing.
