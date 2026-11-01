# CLAUDE.md — Jojo's Karaoke

Read `docs/DESIGN.md` first. Work is tracked in GitHub issues, labelled `M1`–`M5` / `later`
plus an area label (`maker`, `player`, `room`, `spec`, `infra`). Close issues from the
commit that fixes them.

## Stack
- `maker/`: Python 3.12, `uv`. Separation via audio-separator (RoFormer) / Demucs; lyrics via
  LRCLIB or faster-whisper; alignment via ctc-forced-aligner; video via ffmpeg.
- `player/`: TypeScript, Svelte 5, Vite, vite-plugin-pwa. Web Audio + SoundTouch AudioWorklet.
- `room-worker/`: Cloudflare Worker, Durable Objects, R2 (TypeScript).
- `spec/`: JSON Schemas shared by all three. Change the schema first, then the code.

## Commands
- `npm test` (player unit + room-worker integration under `wrangler dev`), `npm run typecheck`
- `cd maker && uv run pytest && uv run ruff check src tests`
- `npm run test:e2e`: headless Chromium host + guest + the real `jojo worker`. CI runs it
  with `JOJO_E2E_STRICT=1` so a missing browser fails instead of skipping.

## Rules
- Never commit audio, stems, packages or real song lyrics (also not in tests or fixtures;
  use self-recorded or generated audio and placeholder text).
- No downloading from YouTube/Spotify or other streaming services.
- Audio plays only on the host; guests receive lyrics and timing only.
- The lyric highlight loop runs on `requestAnimationFrame` outside Svelte reactivity.
- Drag and drop uses Pointer Events, not HTML5 drag events (they don't fire on touch).
- User text goes in via `textContent` / Svelte text bindings, never `{@html}`.
- Anything that waits on the network or a worker needs a timeout.
- The server owns the queue; the screen owns playback (see `spec/protocol.md`).
- ML backends (audio-separator, Demucs, faster-whisper, ctc-forced-aligner) are optional
  imports; the pipeline must keep working without them (fallback timing, `--separator none`).
