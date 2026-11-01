# CLAUDE.md — Jojo's Karaoke

Read `docs/DESIGN.md` first. Work is tracked in GitHub issues, labelled `M1`–`M5` / `later`
plus an area label (`maker`, `player`, `room`, `spec`, `infra`). Close issues from the
commit that fixes them.

## Stack
- `maker/`: Python 3.12, `uv`. Separation via audio-separator (RoFormer) / Demucs; lyrics via
  LRCLIB or faster-whisper; alignment via WhisperX / ctc-forced-aligner; video via ffmpeg.
- `player/`: TypeScript, Svelte 5, Vite, vite-plugin-pwa. Web Audio + AudioWorklet.
- `room-worker/`: Cloudflare Worker, Durable Objects, R2 (TypeScript).
- `spec/`: JSON Schemas shared by all three. Change the schema first, then the code.

## Rules
- Never commit audio, stems, packages or real song lyrics (also not in tests or fixtures;
  use self-recorded or generated audio and placeholder text).
- No downloading from YouTube/Spotify or other streaming services.
- Audio plays only on the host; guests receive lyrics and timing only.
- The lyric highlight loop runs on `requestAnimationFrame` outside Svelte reactivity.
- Drag and drop uses Pointer Events, not HTML5 drag events (they don't fire on touch).
- User text goes in via `textContent` / Svelte text bindings, never `{@html}`.
- Anything that waits on the network or a worker needs a timeout.
