// background.js — MV3 service worker
// Handles: reading settings, validating the active tab is a YouTube page,
// calling the personal yt2mp3 server, and saving the returned MP3 to Downloads.

const YT_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);

const BADGE = {
  WORKING: { text: "\u2022\u2022\u2022", color: "#0b2e1e" }, // dark green (matches settings-page theme)
  OK: { text: "\u2713", color: "#1e8e5a" },
  ERROR: { text: "!", color: "#b3261e" },
  BUSY: { text: "\u23f3", color: "#a15c00" },
};

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

function parseFilename(contentDisposition) {
  if (!contentDisposition) return null;
  // handles filename="foo.mp3" and filename=foo.mp3
  const match = contentDisposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

// Encodes in 32KB chunks — passing a huge byte array straight to
// String.fromCharCode(...bytes) can blow the call stack for larger files.
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// Resolves once the download reaches a terminal state, instead of trusting
// the downloadId alone (which only means "queued", not "finished").
function waitForDownloadToSettle(downloadId, timeoutMs = 5 * 60 * 1000) {
  return new Promise((resolve) => {
    let settled = false;
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

    // Covers the case where it already settled before the listener attached.
    chrome.downloads.search({ id: downloadId }, (results) => {
      const item = results && results[0];
      if (!item) return;
      if (item.state === "complete") finish({ ok: true });
      else if (item.state === "interrupted") finish({ ok: false, error: item.error || "unknown reason" });
    });

    const timer = setTimeout(() => finish({ ok: false, error: "timed out waiting for the download to finish" }), timeoutMs);
  });
}

async function handleConvertClick(tab) {
  log("toolbar clicked, tab url:", tab && tab.url);

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
  log("POST", `${base}/convert`, "body:", { url: tabUrl });

  let response;
  try {
    response = await fetch(`${base}/convert`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Auth-Token": settings.token,
      },
      body: JSON.stringify({ url: tabUrl }),
    });
    log("server responded with status", response.status);
  } catch (err) {
    setBadge(BADGE.ERROR);
    clearBadgeSoon();
    log("fetch threw:", err.message);
    await recordIssue(
      "network-error",
      "Could not reach your server",
      `Check the IP address/port and that this device is on Tailscale. (${err.message})`
    );
    return;
  }

  if (response.status === 401) {
    setBadge(BADGE.ERROR);
    clearBadgeSoon();
    log("rejected: 401 from server");
    await recordIssue("auth-failed", "Authentication failed", "The server rejected the token. Check it in settings.");
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
    setBadge(BADGE.ERROR);
    clearBadgeSoon();
    let detail = "";
    try {
      detail = (await response.text()).slice(0, 180);
    } catch {
      /* ignore */
    }
    log("rejected: unexpected status", response.status, detail);
    await recordIssue("convert-failed", "Conversion failed", `Server returned ${response.status}. ${detail}`);
    return;
  }

  const filename = parseFilename(response.headers.get("Content-Disposition")) || `youtube-audio-${Date.now()}.mp3`;
  const contentType = response.headers.get("Content-Type") || "audio/mpeg";
  log("filename:", filename, "content-type:", contentType);

  let dataUrl;
  try {
    const arrayBuffer = await response.arrayBuffer();
    log("read", arrayBuffer.byteLength, "bytes, encoding as data URL");
    dataUrl = `data:${contentType};base64,${arrayBufferToBase64(arrayBuffer)}`;
  } catch (err) {
    setBadge(BADGE.ERROR);
    clearBadgeSoon();
    await recordIssue("read-failed", "Could not read the response", err.message);
    return;
  }

  let downloadId;
  try {
    downloadId = await chrome.downloads.download({
      url: dataUrl,
      filename,
      saveAs: false,
      conflictAction: "uniquify",
    });
    log("download queued, id:", downloadId);
  } catch (err) {
    setBadge(BADGE.ERROR);
    clearBadgeSoon();
    await recordIssue("download-failed", "Download failed to start", err.message);
    return;
  }

  // A downloadId only means the download was *queued* — wait for Chrome to
  // actually confirm it finished writing to disk before calling this a
  // success. This is what used to get reported as "done" even when the file
  // never showed up.
  const result = await waitForDownloadToSettle(downloadId);
  log("download settled:", result);
  if (!result.ok) {
    setBadge(BADGE.ERROR);
    clearBadgeSoon();
    await recordIssue(
      "download-interrupted",
      "Download didn't finish",
      `Chrome started saving "${filename}" but it was interrupted (${result.error}). Check available disk space and your Downloads folder permissions.`
    );
    return;
  }

  log("done:", filename);
  setBadge(BADGE.OK);
  clearBadgeSoon();
  await clearIssue();
}

chrome.action.onClicked.addListener((tab) => {
  handleConvertClick(tab).catch((err) => {
    setBadge(BADGE.ERROR);
    clearBadgeSoon();
    log("unhandled error:", err);
    recordIssue("unexpected-error", "Something went wrong", err.message || String(err));
  });
});
