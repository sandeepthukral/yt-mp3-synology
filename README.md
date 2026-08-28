# yt2mp3 — personal YouTube → MP3 service

Share a YouTube video from iPhone → iOS Shortcut POSTs it to this service on the
Synology NAS (over Tailscale) → MP3 saved into **On My iPhone/VLC** with a
sanitized title as filename.

## Architecture

- **Server**: Fastify + TypeScript, shells out to `yt-dlp` (which drives `ffmpeg`)
- **Deploy**: Docker on Synology DS220+ (x86_64), reachable only via Tailscale
- **Clients**: iOS Shortcut in the share sheet (no app, no Apple developer
  account), plus a Chrome extension in `extension/`
- **Auth**: `X-Auth-Token` shared-secret header (`AUTH_TOKEN` env var)

## API

All routes except `/health` require the `X-Auth-Token: <secret>` header.

- `GET /health` → `{ ok: true, queueDepth: <n> }`
- `POST /convert` `{ "url": "https://youtube.com/watch?v=..." }`
  - returns `audio/mpeg` with `Content-Disposition: attachment; filename="<sanitized title>.mp3"`
  - `503` if the conversion queue is full (see below)
  - one long-lived HTTP request — fine for short videos, see async mode for the rest

### Async job mode

For long videos, where holding a single HTTP request open is fragile:

- `POST /jobs` `{ "url": "..." }` → `202 { id, downloadKey, status: "queued" }`
- `GET /jobs/:id` → `{ id, downloadKey, status, filename?, error? }`
  - `status` is `queued` → `running` → `done` | `error`
- `GET /jobs/:id/download` → the mp3, same headers as `/convert`
  - `409` if the job isn't finished yet, `502` if it failed, `404` if the id is
    unknown *or* has expired
  - accepts `?key=<downloadKey>` instead of the header, for clients that hand
    this URL to something that can't set one (`chrome.downloads`, a plain link).
    A per-job key rather than `AUTH_TOKEN` keeps the shared token out of
    download histories and access logs, and the grant expires with the job.

Jobs share the same one-at-a-time queue and `MAX_QUEUE` limit as `/convert`.
A finished job's mp3 is kept on disk for `JOB_TTL_MS` (default 30 min) so a
dropped download can be retried, then swept along with the job record.

## ID3 tags

Extracted mp3s carry embedded metadata (`--embed-metadata`), with the YouTube
channel mapped onto the **Artist** field, so VLC groups downloads by channel.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` (`3030` in Docker) | Listen port |
| `AUTH_TOKEN` | — (required) | Shared secret for `X-Auth-Token` |
| `MAX_QUEUE` | `4` | Queued conversions before `503` |
| `DOWNLOAD_TIMEOUT_MS` | `900000` | Per-conversion yt-dlp timeout |
| `JOB_TTL_MS` | `1800000` | How long a finished async job is retained |
| `SAVE_DIR` | `/share` | A copy of each mp3 is written here, in addition to being returned to the caller |
| `COOKIES_FILE` | unset | If set, passed to yt-dlp as `--cookies` |
| `YTDLP_PATH` | `yt-dlp` | yt-dlp binary location |

`SAVE_DIR` is wired up in `docker-compose.yml` to `/volume1/music/downloaded`
on the NAS. Saving a copy never replaces the download — the requester still
gets the file back on the same request. `COOKIES_FILE` needs its own bind
mount, still commented out in the compose file. A failed copy to `SAVE_DIR` (share
unmounted, disk full) is logged and ignored rather than failing the conversion,
and colliding filenames get a ` (2)`, ` (3)` suffix.

## Concurrency

Conversions are **serialized** — one yt-dlp/ffmpeg job runs at a time, because the
DS220+'s CPU crawls under concurrent encodes. Extra requests wait their turn.

- Requests beyond `MAX_QUEUE` (default `4`, incl. the in-flight one) get
  `503 "server busy, try again shortly"` instead of piling up and starving the NAS.
- `GET /health` reports the current `queueDepth` so you can see how backed up it is.
- Auth/URL validation happen *before* queueing, so bad requests still fail fast
  (`401`/`400`) without taking a slot.

Configure via the `MAX_QUEUE` env var.

## Local dev

```bash
nvm use 22   # or your usual node
npm install
npm test          # vitest unit tests (sanitizer, jobs, save-copy naming)
npm run dev       # needs yt-dlp + ffmpeg on PATH
```

## Deploy on the Synology

```bash
# on the NAS (or build on your Mac and push to a registry)
echo "AUTH_TOKEN=$(openssl rand -hex 24)" > .env
docker compose up -d --build
curl http://localhost:3030/health
```

Note the token — the Shortcut needs it.

## Tailscale

1. Package Center → install **Tailscale** on the NAS → log in.
2. Install Tailscale on iPhone → same account → enable VPN, turn on
   "VPN On Demand".
3. Note the NAS MagicDNS name, e.g. `ds220.tailXXXX.ts.net`.
4. Verify from the phone (Safari): `http://ds220.tailXXXX.ts.net:3030/health`

## iOS Shortcut recipe

Create a new Shortcut, name it **"YT → MP3"**:

1. Shortcut settings → enable **Show in Share Sheet**, accept **URLs** only.
2. Action: **Get Contents of URL**
   - URL: `http://ds220.tailXXXX.ts.net:3030/convert`
   - Method: `POST`
   - Headers: `X-Auth-Token` = your token
   - Request Body: JSON → field `url` = **Shortcut Input**
3. Action: **Save File** (input: Contents of URL)
   - Turn **Ask Where to Save** OFF
   - Destination: On My iPhone → **VLC**
4. Optional: **Show Notification** — "Saved ✔︎"

### Long videos: the async variant

`/convert` holds one HTTP request open for the whole conversion, which iOS will
eventually give up on. For long videos, build the Shortcut against the job API
instead:

1. **Get Contents of URL** — `POST` to `…/jobs`, same headers and JSON body as
   above. **Get Dictionary Value** `id` from the result.
2. **Repeat** 60 times:
   - **Get Contents of URL** — `GET …/jobs/<id>` with the token header
   - **If** **Get Dictionary Value** `status` is `done` → **Exit Repeat**
   - **Wait** 5 seconds
3. **Get Contents of URL** — `GET …/jobs/<id>/download` with the token header.
4. **Save File** as before.

The filename comes from the server's Content-Disposition header, so naming is
handled server-side. Anything saved into the VLC folder appears in VLC's
library automatically.

## Chrome extension

`extension/` is a Manifest V3 extension: click the toolbar button on a YouTube
tab and the MP3 lands in Downloads. It uses the job API above and hands the
download URL to `chrome.downloads`, so Chrome streams the file to disk and
long videos aren't limited by the service worker's memory. Load it unpacked —
see [extension/README.md](extension/README.md).

## Playwright API test (against the live NAS)

```bash
BASE_URL=http://ds220.tailXXXX.ts.net:3030 AUTH_TOKEN=... npm run test:api
```

## Known issues / backlog (good Claude Code tasks)

- [x] Long videos: add async job mode (`POST /jobs` → poll → download) so the
      Shortcut doesn't hold one long HTTP request — see [Async job mode](#async-job-mode)
- [x] If YouTube starts bot-blocking even from the residential IP: add
      `--cookies` support (mount a cookies.txt into the container) — set `COOKIES_FILE`
- [x] Rate limiting / single-conversion queue (DS220+ has limited CPU;
      concurrent ffmpeg runs will crawl) — see [Concurrency](#concurrency)
- [x] Embed ID3 tags (title, channel as artist) via yt-dlp `--embed-metadata`
      — see [ID3 tags](#id3-tags)
- [x] Optional: also drop a copy of the MP3 onto a NAS shared folder — set `SAVE_DIR`
- [x] GitHub Actions: run vitest on push (skip Playwright, needs live server)

## Legal note

Downloading YouTube audio violates YouTube's Terms of Service, even for
personal use. Personal project, personal risk.

