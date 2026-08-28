// background.js — MV3 service worker
// Handles: reading settings, validating the active tab is a YouTube page,
// submitting a conversion job to the personal yt2mp3 server, polling it to
// completion, and letting Chrome download the finished MP3.
//
// Why the job API rather than a single POST /convert: an MV3 service worker is
// not guaranteed to outlive a long request, and — more decisively — a worker
// has no URL.createObjectURL, so a response read through fetch() has to be
// base64'd into a data: URL to be downloadable. That inflates the file ~1.33x
// and holds all of it in memory as one string, which falls over on long
// videos. Polling keeps each request short, and handing chrome.downloads a
// plain URL lets Chrome stream the file to disk with none of it in our heap.

const YT_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);

const BADGE = {
  WORKING: { text: "•••", color: "#0b2e1e" }, // dark green (matches settings-page theme)
  OK: { text: "✓", color: "#1e8e5a" },
  ERROR: { text: "!", color: "#b3261e" },
  BUSY: { text: "⏳", color: "#a15c00" },
};

// Polling cadence while this worker is alive. The alarm is the backstop for
// when it isn't: Chrome clamps alarm periods to 30s, which is too coarse for a
// three-minute song but perfectly fine as a resurrection trigger.
const POLL_ALARM = "yt2mp3-poll";
const POLL_INTERVAL_MS = 3000;
const ALARM_PERIOD_MINUTES = 0.5;

// Give up well after the server's own JOB_TTL_MS (30 min default) would have
// swept the job, so we never poll an id that can no longer exist.
const JOB_MAX_AGE_MS = 35 * 60 * 1000;

function setBadge(state) {
  chrome.action.setBadgeText({ text: state.text });
  chrome.action.setBadgeBackgroundColor({ color: state.color });
}

function clearBadgeSoon(delayMs = 4000) {
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), delayMs);
}

const DEFAULT_TITLE = "Convert this video to MP3";

function log(...args) {
  console.log(`[yt2mp3 ${new Date().toLocaleTimeString()}]`, ...args);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function notify(id, title, message) {
  chrome.notifications.create(id, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title,
    message,
    priority: 1,
  }, () => {
    // chrome.runtime.lastError is set if the OS/Chrome refused to show the
    // notification (e.g. Do Not Disturb, notifications disabled for Chrome).
    // We still have the console log + tooltip + options-page copy below, so
    // this is just for anyone inspecting the service worker console.
    if (chrome.runtime.lastError) {
      console.warn("notifications.create failed:", chrome.runtime.lastError.message);
    }
  });
}

// Records a failure through every channel that doesn't depend on system
// notifications actually being visible: console (service worker devtools),
// chrome.storage (shown on the settings page), and the toolbar tooltip.
async function recordIssue(id, title, message) {
  console.error(`[yt2mp3] ${title}: ${message}`);
  notify(id, title, message);
  chrome.action.setTitle({ title: `⚠ ${title}: ${message}` });
  await chrome.storage.local.set({
    lastError: { title, message, at: Date.now() },
  });
}

async function clearIssue() {
  chrome.action.setTitle({ title: DEFAULT_TITLE });
  await chrome.storage.local.remove("lastError");
}

async function fail(issueId, title, message) {
  setBadge(BADGE.ERROR);
  clearBadgeSoon();
  await recordIssue(issueId, title, message);
}

function isYouTubeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return YT_HOSTS.has(u.hostname.toLowerCase()) && u.protocol.startsWith("http");
  } catch {
    return false;
  }
}

async function getSettings() {
  const { token, host, port, useHttps } = await chrome.storage.local.get([
    "token",
    "host",
    "port",
    "useHttps",
  ]);
  return { token, host, port, useHttps: Boolean(useHttps) };
}

function isConfigured({ token, host, port }) {
  return Boolean(token && host && port);
}

function baseUrlFor({ host, port, useHttps }) {
  const scheme = useHttps ? "https" : "http";
  return `${scheme}://${host}:${port}`;
}

// chrome.downloads treats a filename with a separator as a path, and rejects
// anything that escapes the Downloads folder. The server already sanitizes
// titles; this is belt-and-braces against a name that still contains a slash.
function safeFilename(name) {
  const flat = String(name || "").replace(/[\\/]+/g, "-").trim();
  return flat || `youtube-audio-${Date.now()}.mp3`;
}

// --- Pending job, persisted so a restarted worker can pick it back up -------

async function getPending() {
  const { pendingJob } = await chrome.storage.local.get("pendingJob");
  return pendingJob || null;
}

async function setPending(pending) {
  await chrome.storage.local.set({ pendingJob: pending });
}

async function clearPending() {
  await chrome.storage.local.remove("pendingJob");
  await chrome.alarms.clear(POLL_ALARM);
}

// Resolves once the download reaches a terminal state, instead of trusting
// the downloadId alone (which only means "queued", not "finished").
function waitForDownloadToSettle(downloadId, timeoutMs = 10 * 60 * 1000) {
  return new Promise((resolve) => {
    let settled = false;
    // Declared before anything can call finish(): the search() callback below
    // may run before this function returns, and finish() clears the timer.
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      chrome.downloads.onChanged.removeListener(onChanged);
      clearTimeout(timer);
      resolve(result);
    };

    const onChanged = (delta) => {
      if (delta.id !== downloadId || !delta.state) return;
      if (delta.state.current === "complete") finish({ ok: true });
      else if (delta.state.current === "interrupted") {
        finish({ ok: false, error: (delta.error && delta.error.current) || "unknown reason" });
      }
    };
    chrome.downloads.onChanged.addListener(onChanged);

    // Covers the case where it already settled before the listener attached —
    // including a worker that restarted while the download was running.
    chrome.downloads.search({ id: downloadId }, (results) => {
      const item = results && results[0];
      if (!item) return;
      if (item.state === "complete") finish({ ok: true });
      else if (item.state === "interrupted") finish({ ok: false, error: item.error || "unknown reason" });
    });

    timer = setTimeout(() => finish({ ok: false, error: "timed out waiting for the download to finish" }), timeoutMs);
  });
}

// --- Submitting ------------------------------------------------------------

async function handleConvertClick(tab) {
  log("toolbar clicked, tab url:", tab && tab.url);

  const existing = await getPending();
  if (existing) {
    log("blocked: a conversion is already in flight", existing.id);
    setBadge(BADGE.WORKING);
    notify(
      "already-running",
      "Already converting",
      "One conversion is in progress. It'll download on its own — wait for it to finish before starting another."
    );
    return;
  }

  const settings = await getSettings();
  log("settings loaded:", {
    host: settings.host,
    port: settings.port,
    useHttps: settings.useHttps,
    token: settings.token ? `set (${settings.token.length} chars)` : "missing",
  });

  if (!isConfigured(settings)) {
    log("blocked: settings incomplete");
    await recordIssue(
      "config-required",
      "Setup required",
      "Add your Token, IP Address, and Port in the extension's settings page before using it."
    );
    chrome.runtime.openOptionsPage();
    return;
  }

  const tabUrl = tab && tab.url;
  if (!tabUrl || !isYouTubeUrl(tabUrl)) {
    log("blocked: active tab is not a recognized YouTube URL");
    await recordIssue(
      "not-youtube",
      "Not a YouTube page",
      "Open a YouTube video (youtube.com, m.youtube.com, music.youtube.com, or youtu.be) and click the button again."
    );
    return;
  }

  const base = baseUrlFor(settings);
  const origin = `${base}/*`;

  const hasPermission = await chrome.permissions.contains({ origins: [origin] });
  log("host permission for", origin, "->", hasPermission);
  if (!hasPermission) {
    await recordIssue(
      "perm-required",
      "Permission needed",
      "Open the extension settings and save them again to grant access to your server."
    );
    chrome.runtime.openOptionsPage();
    return;
  }

  setBadge(BADGE.WORKING);
  log("POST", `${base}/jobs`, "body:", { url: tabUrl });

  let response;
  try {
    response = await fetch(`${base}/jobs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Auth-Token": settings.token,
      },
      body: JSON.stringify({ url: tabUrl }),
    });
    log("server responded with status", response.status);
  } catch (err) {
    log("fetch threw:", err.message);
    await fail(
      "network-error",
      "Could not reach your server",
      `Check the IP address/port and that this device is on Tailscale. (${err.message})`
    );
    return;
  }

  if (response.status === 401) {
    log("rejected: 401 from server");
    await fail("auth-failed", "Authentication failed", "The server rejected the token. Check it in settings.");
    return;
  }

  if (response.status === 503) {
    setBadge(BADGE.BUSY);
    clearBadgeSoon();
    log("rejected: 503, queue full");
    await recordIssue(
      "server-busy",
      "Server busy",
      "The conversion queue on the NAS is full right now. Try again in a bit."
    );
    return;
  }

  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.text()).slice(0, 180);
    } catch {
      /* ignore */
    }
    log("rejected: unexpected status", response.status, detail);
    await fail("submit-failed", "Conversion failed", `Server returned ${response.status}. ${detail}`);
    return;
  }

  let job;
  try {
    job = await response.json();
  } catch (err) {
    await fail("bad-response", "Unexpected response", `The server didn't return a job: ${err.message}`);
    return;
  }

  if (!job.id || !job.downloadKey) {
    // An older server predates the job API, or predates the download key.
    await fail(
      "server-outdated",
      "Server needs updating",
      "The server accepted the request but didn't return a job id and download key. Update the yt2mp3 server on your NAS."
    );
    return;
  }

  log("job accepted:", job.id, "status:", job.status);
  await setPending({
    id: job.id,
    downloadKey: job.downloadKey,
    base,
    token: settings.token,
    startedAt: Date.now(),
  });
  // The alarm is what revives a worker Chrome has shut down mid-conversion.
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: ALARM_PERIOD_MINUTES });
  await drive();
}

// --- Polling and downloading ----------------------------------------------

// Module state, so it resets when the worker is torn down — which is exactly
// when an alarm should be allowed to start a fresh loop.
let driving = false;

async function drive() {
  if (driving) return;
  driving = true;
  try {
    await driveLoop();
  } finally {
    driving = false;
  }
}

async function driveLoop() {
  for (;;) {
    const pending = await getPending();
    if (!pending) return;

    if (Date.now() - pending.startedAt > JOB_MAX_AGE_MS) {
      log("giving up on job", pending.id, "- too old");
      await clearPending();
      await fail(
        "job-timeout",
        "Conversion took too long",
        "The server never finished this one. Check the NAS logs — it may still be working, or yt-dlp may have stalled."
      );
      return;
    }

    // Once Chrome owns the download it survives this worker, so from here on
    // we only have to observe it.
    if (pending.downloadId != null) {
      await finishDownload(pending);
      return;
    }

    let job;
    try {
      job = await pollJob(pending);
    } catch (err) {
      // Transient: the NAS rebooted, Tailscale dropped, laptop slept. Leave
      // the pending job in place and let the alarm retry.
      log("poll failed, will retry on the next alarm:", err.message);
      return;
    }

    if (job === "gone") {
      await clearPending();
      await fail(
        "job-expired",
        "Conversion result expired",
        "The server no longer has this job. It may have been restarted mid-conversion — try again."
      );
      return;
    }

    if (job.status === "error") {
      await clearPending();
      await fail("convert-failed", "Conversion failed", job.error || "The server didn't say why.");
      return;
    }

    if (job.status === "done") {
      await startDownload(pending, job.filename);
      continue; // next pass sees downloadId and waits for it to settle
    }

    setBadge(BADGE.WORKING);
    await sleep(POLL_INTERVAL_MS);
  }
}

// Returns the job JSON, or the string "gone" for a 404. Throws on network
// failure so the caller can distinguish "retry later" from "give up".
async function pollJob(pending) {
  const response = await fetch(`${pending.base}/jobs/${pending.id}`, {
    headers: { "X-Auth-Token": pending.token },
  });
  if (response.status === 404) return "gone";
  if (!response.ok) throw new Error(`status ${response.status}`);
  return response.json();
}

async function startDownload(pending, filename) {
  const name = safeFilename(filename);
  // No fetch, no arrayBuffer, no base64 — Chrome streams this straight to
  // disk, so a two-hour podcast costs the same memory as a three-minute song.
  // The key is in the URL because chrome.downloads cannot send headers.
  const url = `${pending.base}/jobs/${pending.id}/download?key=${encodeURIComponent(pending.downloadKey)}`;
  log("job done, downloading", name);

  let downloadId;
  try {
    downloadId = await chrome.downloads.download({
      url,
      filename: name,
      saveAs: false,
      conflictAction: "uniquify",
    });
  } catch (err) {
    await clearPending();
    await fail("download-failed", "Download failed to start", err.message);
    return;
  }

  log("download queued, id:", downloadId);
  await setPending({ ...pending, downloadId, filename: name });
}

async function finishDownload(pending) {
  const result = await waitForDownloadToSettle(pending.downloadId);
  log("download settled:", result);
  await clearPending();

  if (!result.ok) {
    await fail(
      "download-interrupted",
      "Download didn't finish",
      `Chrome started saving "${pending.filename}" but it was interrupted (${result.error}). Check available disk space and your Downloads folder permissions.`
    );
    return;
  }

  log("done:", pending.filename);
  setBadge(BADGE.OK);
  clearBadgeSoon();
  await clearIssue();
}

// --- Wiring ----------------------------------------------------------------

function guard(promise) {
  promise.catch((err) => {
    setBadge(BADGE.ERROR);
    clearBadgeSoon();
    log("unhandled error:", err);
    recordIssue("unexpected-error", "Something went wrong", err.message || String(err));
  });
}

chrome.action.onClicked.addListener((tab) => guard(handleConvertClick(tab)));

// Every wake-up path leads back to drive(): it reads the pending job from
// storage, so it doesn't care which one revived the worker.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== POLL_ALARM) return;
  log("alarm fired, resuming");
  guard(drive());
});

chrome.runtime.onStartup.addListener(() => guard(drive()));
chrome.runtime.onInstalled.addListener(() => guard(drive()));
