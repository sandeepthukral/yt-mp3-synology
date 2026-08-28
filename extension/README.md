# YT → MP3 (Personal Synology Service) — Chrome Extension

A minimal Manifest V3 Chrome extension that pairs with your
[yt-mp3-synology](https://github.com/sandeepthukral/yt-mp3-synology) server. Click the
toolbar button on a YouTube video and it POSTs the URL to your NAS, then saves the
returned MP3 straight to your Downloads folder — no popup, no extra clicks.

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
- Long conversions keep the extension's service worker alive for as long as the
  `fetch()` to `/convert` is pending. If your NAS is slow on very long videos and Chrome
  kills the worker before it responds, the request will fail — the server-side
  `MAX_QUEUE` / async job mode listed in the repo's backlog would be the fix for that.
- There's no popup UI by design, matching a "click and it just downloads" workflow;
  everything else (setup, errors) surfaces via the settings page and notifications.
