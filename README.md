# yt2mp3 — personal YouTube → MP3 service

Share a YouTube video from iPhone → iOS Shortcut POSTs it to this service on the
Synology NAS (over Tailscale) → MP3 saved into **On My iPhone/VLC** with a
sanitized title as filename.

## Architecture

- **Server**: Fastify + TypeScript, shells out to `yt-dlp` (which drives `ffmpeg`)
- **Deploy**: Docker on Synology DS220+ (x86_64), reachable only via Tailscale
- **Client**: iOS Shortcut in the share sheet (no app, no Apple developer account)
- **Auth**: `X-Auth-Token` shared-secret header (`AUTH_TOKEN` env var)

## API

- `GET /health` → `{ ok: true, queueDepth: <n> }`
- `POST /convert` `{ "url": "https://youtube.com/watch?v=..." }`
  - headers: `X-Auth-Token: <secret>`
  - returns `audio/mpeg` with `Content-Disposition: attachment; filename="<sanitized title>.mp3"`
  - `503` if the conversion queue is full (see below)

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
npm test          # vitest unit tests (sanitizer)
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

The filename comes from the server's Content-Disposition header, so naming is
handled server-side. Anything saved into the VLC folder appears in VLC's
library automatically.

## Playwright API test (against the live NAS)

```bash
BASE_URL=http://ds220.tailXXXX.ts.net:3030 AUTH_TOKEN=... npm run test:api
```

## Known issues / backlog (good Claude Code tasks)

- [ ] Long videos: add async job mode (`POST /jobs` → poll → download) so the
      Shortcut doesn't hold one long HTTP request
- [ ] If YouTube starts bot-blocking even from the residential IP: add
      `--cookies` support (mount a cookies.txt into the container)
- [x] Rate limiting / single-conversion queue (DS220+ has limited CPU;
      concurrent ffmpeg runs will crawl) — see [Concurrency](#concurrency)
- [ ] Embed ID3 tags (title, channel as artist) via yt-dlp `--embed-metadata`
- [ ] Optional: also drop a copy of the MP3 onto a NAS shared folder
- [x] GitHub Actions: run vitest on push (skip Playwright, needs live server)

## Legal note

Downloading YouTube audio violates YouTube's Terms of Service, even for
personal use. Personal project, personal risk.

