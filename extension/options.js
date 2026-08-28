const tokenInput = document.getElementById("token");
const hostInput = document.getElementById("host");
const portInput = document.getElementById("port");
const useHttpsInput = document.getElementById("useHttps");
const saveBtn = document.getElementById("saveBtn");
const testBtn = document.getElementById("testBtn");
const form = document.getElementById("settingsForm");
const formMessage = document.getElementById("formMessage");
const statusBanner = document.getElementById("statusBanner");
const toggleTokenBtn = document.getElementById("toggleToken");

function currentValues() {
  return {
    token: tokenInput.value.trim(),
    host: hostInput.value.trim(),
    port: portInput.value.trim(),
    useHttps: useHttpsInput.checked,
  };
}

function isComplete(values) {
  return Boolean(values.token && values.host && values.port);
}

function updateRequiredBadges(values) {
  document.querySelectorAll(".required").forEach((el) => {
    const field = el.dataset.for;
    el.classList.toggle("is-filled", Boolean(values[field]));
  });
}

function updateBanner(values) {
  if (isComplete(values)) {
    statusBanner.className = "banner banner--ok";
    statusBanner.textContent = "Configured — click the toolbar button on any YouTube video to convert it.";
  } else {
    statusBanner.className = "banner banner--warning";
    statusBanner.textContent = "Token, IP Address, and Port are all required before this extension will work.";
  }
}

function updateSaveState() {
  const values = currentValues();
  updateRequiredBadges(values);
  updateBanner(values);
  saveBtn.disabled = !isComplete(values);
}

function baseUrlFor(values) {
  const scheme = values.useHttps ? "https" : "http";
  return `${scheme}://${values.host}:${values.port}`;
}

function showMessage(text, kind) {
  formMessage.textContent = text;
  formMessage.className = `form-message ${kind || ""}`.trim();
}

const lastErrorSection = document.getElementById("lastErrorSection");
const lastErrorText = document.getElementById("lastErrorText");
const lastErrorTime = document.getElementById("lastErrorTime");
const clearErrorBtn = document.getElementById("clearErrorBtn");

function renderLastError(lastError) {
  if (!lastError) {
    lastErrorSection.hidden = true;
    return;
  }
  lastErrorSection.hidden = false;
  lastErrorText.textContent = `${lastError.title}: ${lastError.message}`;
  lastErrorTime.textContent = new Date(lastError.at).toLocaleString();
}

async function loadLastError() {
  const { lastError } = await chrome.storage.local.get("lastError");
  renderLastError(lastError);
}

clearErrorBtn.addEventListener("click", async () => {
  await chrome.storage.local.remove("lastError");
  renderLastError(null);
});

// Keep this panel live if a conversion runs while the settings tab is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && "lastError" in changes) {
    renderLastError(changes.lastError.newValue);
  }
});

async function loadSettings() {
  const stored = await chrome.storage.local.get(["token", "host", "port", "useHttps"]);
  tokenInput.value = stored.token || "";
  hostInput.value = stored.host || "";
  portInput.value = stored.port || "";
  useHttpsInput.checked = Boolean(stored.useHttps);
  updateSaveState();
}

async function handleSave(event) {
  event.preventDefault();
  const values = currentValues();
  if (!isComplete(values)) {
    showMessage("Please fill in Token, IP Address, and Port.", "error");
    return;
  }

  const portNum = Number(values.port);
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    showMessage("Port must be a number between 1 and 65535.", "error");
    return;
  }

  const origin = `${baseUrlFor(values)}/*`;

  saveBtn.disabled = true;
  showMessage("Requesting permission to contact your server…", "");

  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: [origin] });
  } catch (err) {
    showMessage(`Could not request permission: ${err.message}`, "error");
    saveBtn.disabled = false;
    return;
  }

  if (!granted) {
    showMessage(
      "Permission was not granted, so the extension can't reach your server. Please save again and allow access.",
      "error"
    );
    saveBtn.disabled = false;
    return;
  }

  await chrome.storage.local.set(values);
  showMessage("Saved. You're ready to convert videos.", "success");
  updateSaveState();
}

async function handleTestConnection() {
  const values = currentValues();
  if (!values.host || !values.port) {
    showMessage("Enter IP Address and Port first.", "error");
    return;
  }

  const base = baseUrlFor(values);
  const origin = `${base}/*`;

  const hasPermission = await chrome.permissions.contains({ origins: [origin] });
  if (!hasPermission) {
    showMessage("Save settings first to grant access, then test the connection.", "error");
    return;
  }

  showMessage("Checking server…", "");
  try {
    const response = await fetch(`${base}/health`);
    if (!response.ok) {
      showMessage(`Server responded with status ${response.status}.`, "error");
      return;
    }
    const data = await response.json();
    if (typeof data.queueDepth === "number") {
      showMessage(`Server reachable — queue depth: ${data.queueDepth}.`, "success");
    } else {
      showMessage("Server reachable.", "success");
    }
  } catch (err) {
    showMessage(`Could not reach server: ${err.message}`, "error");
  }
}

toggleTokenBtn.addEventListener("click", () => {
  const showing = tokenInput.type === "text";
  tokenInput.type = showing ? "password" : "text";
  toggleTokenBtn.textContent = showing ? "Show" : "Hide";
});

[tokenInput, hostInput, portInput, useHttpsInput].forEach((el) => {
  el.addEventListener("input", updateSaveState);
});

form.addEventListener("submit", handleSave);
testBtn.addEventListener("click", handleTestConnection);

loadSettings();
loadLastError();
