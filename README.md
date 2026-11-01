# Jojo's Karaoke

Turn songs you own into karaoke, then sing them together.

- **Maker**: song in → vocals removed, lyrics timed word by word → karaoke package (`.jkp`).
  Two ways to run it:
  - **In the browser** (*Make a song* in the app): nothing to install, uses the graphics card
    through WebGPU. Can also make guests' requests during a party.
  - **Python CLI** (`maker/`): best quality (RoFormer models), MP4 videos, batch jobs.
- **Player** (`player/`, Svelte PWA): the host screen (TV/laptop in Chrome) plays the music
  and shows a QR code; guests scan it, pick a nickname, queue songs, request new ones, and
  see the lyrics in sync on their phone.
- **Room server** (`room-worker/`): Cloudflare Worker + Durable Objects + R2. Rooms, queue,
  clock sync, the private online song library, and on-the-spot processing jobs.

Design and decisions: [docs/DESIGN.md](docs/DESIGN.md). Protocol: [spec/protocol.md](spec/protocol.md).

Only use audio you own. Songs, stems and lyrics are copyrighted: the library is private to
its owner, the makers they invite and their party guests. It is never public.

---

## Using it

1. **Host**: open the app on the TV/laptop → *Library & settings* → create your library.
   → *Host a party* → *Start the party*.
2. **Guests**: scan the QR code (or open `/join` and type the 4-letter code), enter a
   nickname, tap songs to queue them. When it's your turn your phone buzzes.
3. **Add songs**: *Make a song* in the app (Chrome on a laptop/desktop), or on a computer
   with the CLI below: `jojo make song.mp3 --upload`.
4. **Songs on the spot**: a guest uploads their own copy in the *Request* tab. The host
   ticks *Make requests on this device* in the queue panel (or a friend opens *Make a song →
   Help at a party*, or runs `jojo worker --room CODE`); the song joins the queue when ready.

Host screen keys: Space play/pause · N skip · ←/→ seek · +/− key · [ ] tempo · V guide
vocal · F fullscreen · Q queue · , . lyrics offset. The 📱 button shows a QR to control
the room from your own phone; *Cast* sends the screen to a TV (Chrome).

## Making songs in the browser

*Make a song* runs vocal removal (UVR MDX-Net Inst HQ 3) and word timing (Whisper, via
transformers.js) inside Chrome. The models download once (≈ 67 MB plus 40–250 MB for
Whisper) and stay in the browser cache.

- With a graphics card (WebGPU: Chrome/Edge on a laptop or desktop): roughly 1–3 minutes per song.
- Without WebGPU it runs on the CPU: an 8-second clip took ~40 s in testing, so expect 10+ minutes for a song.
- Phones are too slow for this; use a laptop.
- Lyrics: pasted, looked up on LRCLIB, or transcribed. English uses `whisper-tiny.en`, other
  languages `whisper-small`.

## Installing the CLI maker (you and your friends)

You need **ffmpeg** and **uv** (a one-file Python installer):

| | ffmpeg | uv |
|---|---|---|
| Windows | `winget install ffmpeg` | `winget install astral-sh.uv` |
| macOS | `brew install ffmpeg` | `brew install uv` |
| Linux | `sudo apt install ffmpeg` | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |

Then:

```bash
uv tool install 'jojos-karaoke[ml] @ git+https://github.com/JonathanGehret/jojos-karaoke#subdirectory=maker'
# NVIDIA GPU: use [gpu] instead of [ml]
jojo doctor          # checks ffmpeg, GPU, models, login
jojo login --server https://<your-app> --token <token from Library & settings>
jojo make song.mp3 --upload               # lyrics: looked up on LRCLIB, else transcribed
jojo make song.mp3 --lyrics song.txt      # or .lrc; "A: …"/"B: …" prefixes + --duets for duets
jojo make song.mp3 --video                # also an MP4 with the word wipe
jojo worker --room K7Q2                   # make guests' requests during a party
```

The first run downloads the models (a few hundred MB). Expect roughly 1–3 minutes per song on
a laptop CPU and well under a minute on a GPU or Apple Silicon. Friends get their own token
from the host (*Library & settings → Friends who make songs*); their songs go into the
host's library.

Without the `[ml]` extra the maker still works with `--separator none` (no vocal removal)
and lyrics you provide; timing then comes from the LRC timestamps or is estimated.

## Deploying the app (Cloudflare, free tier)

```bash
npm install
npx wrangler login
npx wrangler r2 bucket create jojos-karaoke-library
cd room-worker
openssl rand -base64 32 | npx wrangler secret put MEDIA_SECRET
npx wrangler secret put SIGNUP_CODE        # optional: only people with the code can create a library
cd .. && npm run deploy                    # builds the PWA, uploads ONNX Runtime to R2, deploys the Worker
```

## Developing

```bash
npm install && (cd maker && uv sync)
npm run build && npm run dev               # app + API on http://localhost:8787
(cd player && npm run dev)                 # hot reload on :5173, proxies /api to :8787

npm test                                   # player unit tests + room server integration
npm run typecheck
(cd maker && uv run pytest && uv run ruff check src tests)
npm run test:e2e                           # headless Chromium: party + CLI worker, and the browser maker
JOJO_E2E_REAL_MODEL=1 node player/e2e/maker.mjs   # same, with the real 67 MB separation model
```

The e2e test needs Playwright's Chromium and `uv`; it skips without Playwright unless
`JOJO_E2E_STRICT=1` (CI sets it).
