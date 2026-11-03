# Room protocol

Types: `shared/protocol.ts` (source of truth). Transport: JSON over one WebSocket per device,
`/api/rooms/{CODE}/ws`.

## Connecting

| Who | Query | Notes |
|---|---|---|
| Guest | `nickname=…` (first time) or `member=<memberToken>` | `welcome.you.token` is the member token; keep it to reconnect as the same person. |
| Screen | `role=screen&token=<adminToken>` | Plays the audio and publishes playback. Also has host rights. |
| Host remote | `role=admin&token=<adminToken>` | Host rights without playing audio (phone remote, after casting). |
| Maker worker | `role=worker&token=<worker key>` | The room's helper key (`wk_…`, returned when the room is created and shown on the host screen), the host token, or a library token of the room owner. |

## Authority

- **Server** owns members, the queue (fair insertion, limits, moves), jobs and uploads.
- **Screen** owns playback and the songs on its device: it sends `screen.library` (summaries)
  and, for the song now playing, `lyrics` (already shifted by the song's offset), which the
  server relays to everyone (and replays to late joiners).
- **Screen** owns playback. It sends `playback` on every change and every 10 s while playing; guests compute
  the position with `positionAt(playback, serverNow)`, where `serverNow` comes from
  NTP-style `ping`/`pong` (median of the fastest half of the last 30 samples).
- Host commands from a remote (`control`, `control.set`) are relayed to screens, which apply
  them and publish the new playback.

## Messages

Client → server: `ping`, `queue.add`, `queue.remove`, `queue.move`*, `queue.playNext`*,
`request.add`, `control`*, `control.set`*, `playback`†, `advance`†, `settings`*, `kick`*,
`react`, `job.claim`‡, `job.progress`‡, `job.done`‡,
`job.failed`‡.  (* host, † screen, ‡ worker)

Server → client: `welcome`, `pong`, `state`, `playback`, `control`, `control.set`, `library`,
`react`, `job`, `error`, `kicked`.

Close codes: `4403` removed from the room, `4404` room closed.

## HTTP next to the socket

- `POST /api/rooms/{CODE}/uploads?member=…` raw audio body (≤ 60 MB) → `{ uploadId }`
- `POST /api/rooms` → `{ code, adminToken, workerKey }`; a library token is optional (it adds that online library)
- `GET /api/rooms/{CODE}/uploads/{id}` (worker, Bearer key) → the upload
- `POST /api/rooms/{CODE}/results/{jobId}` (worker) `.jkp` body → then `job.done`
- `GET /api/rooms/{CODE}/results/{jobId|queueItemId}?admin=…|member=…` → the `.jkp` (host or the requester only)
- `GET /api/rooms/{CODE}/songs/{id}/media?member=…|admin=…` → manifest + signed URLs
  (6 h). Guests get lyrics and cover only; audio is for the host.
- `PUT /api/rooms/{CODE}/songs/{id}/lyrics?admin=…` `{ lyrics, offsetMs? }` → saves edits
