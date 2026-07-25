// Cream background service worker
// Handles: install onboarding, device id, forwarding command logs to companion API,
// managing offscreen document for speech recognition, and relaying commands to YouTube tabs.

const DEFAULT_SETTINGS = {
  enabled: true,
  wakeWord: "cream",
  seekMultiplier: 1,
  defaultSeekSeconds: 5,
  beepOnDetect: true,
  apiBase: "" // set via options page or dashboard
};

let currentSpeechStatus = { running: false, status: "idle" };
let offscreenCreating = null;

async function writeDebugLog(message) {
  try {
    const { debugLogs = [] } = await chrome.storage.local.get("debugLogs");
    debugLogs.push(`[${new Date().toISOString()}] ${message}`);
    if (debugLogs.length > 50) debugLogs.shift();
    await chrome.storage.local.set({ debugLogs });
  } catch (_) {}
}

async function logDebug(msg) {
  await writeDebugLog(`[SW] ${msg}`);
}

async function ensureDeviceId() {
  const { deviceId } = await chrome.storage.local.get("deviceId");
  if (deviceId) return deviceId;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ deviceId: id });
  return id;
}

async function ensureSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  if (settings) return settings;
  await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  return DEFAULT_SETTINGS;
}

async function setupOffscreenDocument() {
  const settings = await ensureSettings();
  if (!settings.enabled) {
    logDebug("setupOffscreenDocument: extension is disabled in settings");
    return;
  }

  if (offscreenCreating) {
    logDebug("setupOffscreenDocument: offscreen is already being created (waiting)");
    await offscreenCreating;
    return;
  }

  if (!chrome.offscreen) {
    logDebug("setupOffscreenDocument: chrome.offscreen is undefined");
    currentSpeechStatus = { running: false, status: "err: no offscreen API" };
    relayToAllYoutubeTabs({ type: "SPEECH_STATUS_UPDATE", payload: currentSpeechStatus });
    return;
  }

  let contexts = [];
  if (chrome.runtime.getContexts) {
    try {
      contexts = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"]
      });
    } catch (e) {
      logDebug(`setupOffscreenDocument: getContexts error: ${e.message}`);
    }
  }

  if (contexts.length > 0) {
    logDebug("setupOffscreenDocument: offscreen document context already exists");
    return;
  }

  logDebug("setupOffscreenDocument: calling chrome.offscreen.createDocument");
  const query = new URLSearchParams({
    enabled: settings.enabled,
    wakeWord: settings.wakeWord
  }).toString();
  offscreenCreating = chrome.offscreen.createDocument({
    url: chrome.runtime.getURL(`offscreen.html?${query}`),
    reasons: ["USER_MEDIA"],
    justification: "Speech recognition for YouTube playback control"
  });

  try {
    await offscreenCreating;
    logDebug("setupOffscreenDocument: offscreen document created successfully");
  } catch (err) {
    const errMsg = err.message || String(err);
    if (errMsg.includes("Only a single offscreen document") || errMsg.includes("Already exists")) {
      logDebug("setupOffscreenDocument: document already existed (safe ignore)");
    } else {
      logDebug(`setupOffscreenDocument: creation failed: ${errMsg}`);
      console.error("Failed to create offscreen document:", err);
      currentSpeechStatus = { running: false, status: "err: " + errMsg };
      relayToAllYoutubeTabs({ type: "SPEECH_STATUS_UPDATE", payload: currentSpeechStatus });
    }
  } finally {
    offscreenCreating = null;
  }
}

async function closeOffscreenDocument() {
  if (!chrome.offscreen) return;
  
  let contexts = [];
  if (chrome.runtime.getContexts) {
    try {
      contexts = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"]
      });
    } catch (_) {}
  } else {
    logDebug("closeOffscreenDocument: getContexts not supported, forcing close");
    try {
      await chrome.offscreen.closeDocument();
      logDebug("closeOffscreenDocument: closed");
    } catch (_) {}
    return;
  }

  if (contexts.length > 0) {
    logDebug("closeOffscreenDocument: closing offscreen document");
    try {
      await chrome.offscreen.closeDocument();
      logDebug("closeOffscreenDocument: closed");
    } catch (e) {
      logDebug(`closeOffscreenDocument: close error: ${e.message}`);
    }
  }
}

function relayToAllYoutubeTabs(message) {
  chrome.tabs.query({ url: ["https://www.youtube.com/*", "https://m.youtube.com/*"] }, (tabs) => {
    if (chrome.runtime.lastError || !tabs) return;
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    }
  });
}

function relayToActiveYoutubeTab(message) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (chrome.runtime.lastError || !tabs || tabs.length === 0) return;
    const tab = tabs[0];
    if (tab && /youtube\.com/.test(tab.url || "")) {
      chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    }
  });
}

// Lifecycle listeners
chrome.runtime.onInstalled.addListener(async (details) => {
  await ensureDeviceId();
  await ensureSettings();
  await setupOffscreenDocument();
  if (details.reason === "install") {
    // Open the options/onboarding page (asks mic permission through Web Speech API)
    chrome.tabs.create({ url: chrome.runtime.getURL("options.html?onboarding=1") });
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await setupOffscreenDocument();
});

// Settings monitoring
chrome.storage.onChanged.addListener(async (changes) => {
  if (changes.settings) {
    const settings = changes.settings.newValue;
    logDebug(`storage onChanged: settings updated. Broadcasting SETTINGS_UPDATED`);
    chrome.runtime.sendMessage({ type: "SETTINGS_UPDATED", settings }).catch(() => {});
    if (settings.enabled) {
      await setupOffscreenDocument();
    } else {
      await closeOffscreenDocument();
      currentSpeechStatus = { running: false, status: "stopped" };
      relayToAllYoutubeTabs({ type: "SPEECH_STATUS_UPDATE", payload: currentSpeechStatus });
    }
  }
});

// Relay message processing
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "LOG_COMMAND") {
    (async () => {
      const settings = await ensureSettings();
      const deviceId = await ensureDeviceId();
      if (!settings.apiBase) {
        sendResponse({ ok: false, skipped: true });
        return;
      }
      try {
        const res = await fetch(`${settings.apiBase.replace(/\/$/, "")}/api/commands`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...msg.payload, deviceId })
        });
        sendResponse({ ok: res.ok });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true; // async
  }

  if (msg?.type === "GET_SETTINGS") {
    ensureSettings().then((s) => sendResponse(s));
    return true;
  }

  // Offscreen -> Service Worker -> Content Script updates
  if (msg?.type === "SPEECH_STATUS_CHANGED") {
    logDebug(`Message: SPEECH_STATUS_CHANGED: status=${msg.payload.status}, running=${msg.payload.running}`);
    currentSpeechStatus = msg.payload;
    relayToAllYoutubeTabs({ type: "SPEECH_STATUS_UPDATE", payload: currentSpeechStatus });
    return;
  }

  if (msg?.type === "SPEECH_RESULT_UPDATE") {
    if (msg.isFinal) {
      logDebug(`SPEECH_RESULT_UPDATE (final): "${msg.transcript}"`);
    }
    relayToActiveYoutubeTab({
      type: "SHOW_SPEECH_POPUP",
      transcript: msg.transcript,
      isFinal: msg.isFinal
    });
    return;
  }

  // Content Script / Popup -> Service Worker status request
  if (msg?.type === "GET_SPEECH_STATUS") {
    logDebug(`Message: GET_SPEECH_STATUS, responding with running=${currentSpeechStatus.running}, status=${currentSpeechStatus.status}`);
    sendResponse(currentSpeechStatus);
    return;
  }

  if (msg?.type === "TAB_LOADED") {
    logDebug("Message: TAB_LOADED, initiating offscreen document setup");
    setupOffscreenDocument().then(() => {
      // Request offscreen document to report its current status to keep SW in sync
      chrome.runtime.sendMessage({ type: "REQUEST_SPEECH_STATUS" }).catch(() => {});
    });
    return;
  }

  if (msg?.type === "LOG_DEBUG") {
    writeDebugLog(msg.msg);
    return;
  }

  if (msg?.type === "KEEP_ALIVE") {
    if (msg.payload) {
      currentSpeechStatus = msg.payload;
      relayToAllYoutubeTabs({ type: "SPEECH_STATUS_UPDATE", payload: currentSpeechStatus });
    }
    // Silently acknowledge ping to keep SW and communication channel active
    sendResponse({ ack: true });
    return true;
  }

  if (msg?.type === "TOGGLE_WINDOW_FULLSCREEN") {
    chrome.windows.getCurrent((win) => {
      if (chrome.runtime.lastError || !win) return;
      const newState = win.state === "fullscreen" ? "maximized" : "fullscreen";
      chrome.windows.update(win.id, { state: newState });
    });
    return;
  }
});
