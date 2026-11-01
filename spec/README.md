# spec

Shared contracts. Change these first, then the code that reads them.

- `manifest.schema.json`, `lyrics.schema.json`, `pitch.schema.json`: the `.jkp` package
  (a zip with `manifest.json`, `instrumental.opus`, optional `vocals.opus`, `lyrics.json`,
  optional `pitch.json` and cover). All times are integer milliseconds from the start of
  the song.
- `protocol.md`: room WebSocket messages. The TypeScript types in `shared/protocol.ts` are
  the source of truth for the code; keep this file in step.
- `examples/`: valid example documents (placeholder text, not real lyrics). Every
  implementation's tests validate against these.
