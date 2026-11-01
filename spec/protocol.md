# Room protocol

Types: `shared/protocol.ts` (source of truth). Transport: JSON over one WebSocket per device,
`/api/rooms/{CODE}/ws`.

## Connecting

| Who | Query | Notes |
|---|---|---|
| Guest | `nickname=…` (first time) or `member=<memberToken>` | `welcome.you.token` is the member token; keep it to reconnect as the same person. |
| Screen | `role=screen&token=<adminToken>` | Plays the audio and publishes playback. Also has host rights. |
| Host remote | `role=admin&token=<adminToken>` | Host rights without playing audio (phone remote, after casting). |
| Maker worker | `role=worker&token=<library token>` | Owner or contributor token of the room owner's library. |

## Authority

- **Server** owns members, the queue (fair insertion, limits, moves), jobs and uploads.
- **Screen** owns playback. It sends `playback` on every change and every 5 s; guests compute
  the position with `positionAt(playback, serverNow)`, where `serverNow` comes from
  NTP-style `ping`/`pong` (median of the fastest half of the last 30 samples).
- Host commands from a remote (`control`, `control.set`) are relayed to screens, which apply
  them and publish the new playback.

## Messages

Client → server: `ping`, `queue.add`, `queue.remove`, `queue.move`*, `queue.playNext`*,
`request.add`, `control`*, `control.set`*, `playback`†, `advance`†, `settings`*, `kick`*,
`react`, `score` (only the current singer), `job.claim`‡, `job.progress`‡, `job.done`‡,
`job.failed`‡.  (* host, † screen, ‡ worker)

Server → client: `welcome`, `pong`, `state`, `playback`, `control`, `control.set`, `library`,
`react`, `score`, `job`, `error`, `kicked`.

Close codes: `4403` removed from the room, `4404` room closed.

## HTTP next to the socket

- `POST /api/rooms/{CODE}/uploads?member=…` raw audio body (≤ 60 MB) → `{ uploadId }`
- `GET /api/rooms/{CODE}/uploads/{id}` (worker, Bearer library token) → the upload
- `GET /api/rooms/{CODE}/songs/{id}/media?member=…|admin=…` → manifest + signed URLs
  (6 h). Guests get lyrics, pitch and cover only; audio is for the host.
- `PUT /api/rooms/{CODE}/songs/{id}/lyrics?admin=…` `{ lyrics, offsetMs? }` → saves edits
