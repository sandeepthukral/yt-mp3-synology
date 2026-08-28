# YT → MP3 (Personal Synology Service) — Chrome Extension

A minimal Manifest V3 Chrome extension that pairs with your
[yt-mp3-synology](https://github.com/sandeepthukral/yt-mp3-synology) server. Click the
toolbar button on a YouTube video and it hands the URL to your NAS, then saves the
resulting MP3 straight to your Downloads folder — no popup, no extra clicks.

Requires a server new enough to return a `downloadKey` from `POST /jobs`.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Click the extension's toolbar icon once to pin it, then click it again — since no
   Token/IP/Port are set yet, it'll open the settings page for you automatically.

## Configure

1. On the settings page, fill in:
   - **Token** — the `AUTH_TOKEN` value from your NAS's `.env`.
   - **IP Address / Hostname** — e.g. your Tailscale MagicDNS name (`ds220.tailXXXX.ts.net`)
     or a LAN IP.
   - **Port** — `3030` by default per the server's README.
   - **Use HTTPS** — leave unchecked unless you've put HTTPS in front of the service.
2. Click **Save settings**. Chrome will ask you to confirm access to that specific
   host/port — accept it so the extension is allowed to contact your server.
3. Optionally click **Test connection** to confirm the NAS answers `/health`.

Until all three fields are filled in, the settings page shows a warning banner, and
clicking the toolbar button will pop up a notification telling you to finish setup
instead of silently failing.

## Use it

1. Open any YouTube video — `youtube.com`, `m.youtube.com`, `music.youtube.com`, or a
   `youtu.be` link all work.
2. Click the toolbar button.
3. The badge shows `•••` while converting. On success it flashes a green check and the
   MP3 lands in your Downloads folder using the filename the server sent back
   (`Content-Disposition`). On failure (bad token, server busy, network issue) you'll
   get a system notification explaining what happened.

## Notes

- The extension only ever talks to the exact host/port you configured — permission is
  requested per-origin via `chrome.permissions.request`, not a blanket `<all_urls>` grant.
- There's no popup UI by design, matching a "click and it just downloads" workflow;
  everything else (setup, errors) surfaces via the settings page and notifications.
- Only one conversion runs at a time. Clicking again while one is in flight tells you
  so rather than queueing a second.

## How it handles long videos

Earlier versions made a single `POST /convert` request and waited for the MP3 to come
back in the response body. That capped the workable file size, for two reasons:

- A service worker has no `URL.createObjectURL`, so the response had to be base64'd
  into a `data:` URL before `chrome.downloads` would take it. That inflates the file by
  about a third and holds all of it in memory as one JavaScript string.
- MV3 gives no guarantee that a worker outlives a single long request.

It now uses the server's job API instead:

1. `POST /jobs` → `{ id, downloadKey, status }`, which is written to
   `chrome.storage.local` as the pending job.
2. Poll `GET /jobs/:id` every 3 seconds until `done`.
3. Hand `GET /jobs/:id/download?key=…` to `chrome.downloads`, which streams it to disk.

Nothing reads the file's bytes, so a three-hour podcast costs the same memory as a
three-minute song. And because the pending job lives in storage rather than in the
worker's memory, a worker Chrome shuts down mid-conversion is revived by a
`chrome.alarms` tick — hence the `alarms` permission — and carries on polling. Once
the download has started, Chrome owns it and it completes regardless.

The `?key=` is a per-job secret, not your `AUTH_TOKEN`: `chrome.downloads` can't set
request headers, and putting the shared token in a URL would leak it into Chrome's
download history. The key dies with the job.
