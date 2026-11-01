# Jojo's Karaoke

Turn songs you own into karaoke, then sing them together.

- **Maker** (`maker/`): song in → vocals removed, lyrics timed word by word → karaoke
  package (and optional MP4). Runs locally on your own machine (yours or a friend's).
- **Player** (`player/`): installable PWA. The host screen (TV/laptop in Chrome) plays the
  music and shows a QR code; guests scan it, pick a nickname, queue songs and see the lyrics
  in sync on their own phone.
- **Room server** (`room-worker/`): Cloudflare Worker + Durable Objects for rooms, queue,
  clock sync, and the online song library (R2).

Status: planning. See [docs/DESIGN.md](docs/DESIGN.md) and the GitHub issues (labels
`M1`–`M5`).

Only use audio you own. Packages, stems and lyrics are copyrighted material for private use:
the library is private to its owner and their room guests, never public.
