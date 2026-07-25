// Cream offscreen speech recognition script
// Runs Web Speech API inside the extension origin to leverage microphone permissions.
// NOTE: chrome.storage is not available in offscreen documents. Settings and logs are passed via messaging.

let recognition = null;
let running = false;
let currentStatus = "idle";
let settings = {
  enabled: true,
  wakeWord: "cream"
};
let restartTimer = null;

function logDebug(msg) {
  chrome.runtime.sendMessage({
    type: "LOG_DEBUG",
    msg: `[Offscreen] ${msg}`
  }).catch(() => {});
}

function loadSettingsFromUrl() {
  try {
    const params = new URLSearchParams(location.search);
    if (params.has("enabled")) {
      settings.enabled = params.get("enabled") === "true";
    }
    if (params.has("wakeWord")) {
      settings.wakeWord = params.get("wakeWord") || "cream";
    }
    logDebug(`loadSettingsFromUrl: loaded wakeWord="${settings.wakeWord}", enabled=${settings.enabled}`);
  } catch (err) {
    logDebug(`loadSettingsFromUrl failed: ${err.message || String(err)}`);
  }
}

function setStatus(status, isListening = false) {
  running = isListening;
  currentStatus = status;
  logDebug(`setStatus: status="${status}", running=${isListening}`);
  chrome.runtime.sendMessage({
    type: "SPEECH_STATUS_CHANGED",
    payload: { running, status }
  }).catch(() => {});
}

function matchWakeWord(transcript, targetWake) {
  const wake = targetWake.toLowerCase().trim();
  const variations = [wake];
  
  if (wake === "cream") {
    variations.push(
      "scream", "dream", "clean", "green", "queen", "gleam", "grim", 
      "creme", "crème", "crane", "chrome", "chroma", "stream", 
      "cray", "crayola", "kream", "crim", "crimp"
    );
  }
  
  variations.push("speakzy", "speaksy", "speak-zy", "speaks e", "speaks he", "speaks easy");

  for (const v of variations) {
    const regex = new RegExp(`\\b${v.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, "i");
    const match = transcript.match(regex);
    if (match) {
      return { matched: match[0], index: transcript.indexOf(match[0]) };
    }
  }
  
  return null;
}

function initRecognition() {
  logDebug("initRecognition: initializing webkitSpeechRecognition");
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    setStatus("no speech api");
    logDebug("initRecognition: SpeechRecognition API not supported in this environment");
    return null;
  }
  const r = new SR();
  r.continuous = true;
  r.interimResults = true;
  r.lang = "en-US";

  r.onstart = () => {
    logDebug("recognition event: onstart (started listening)");
    setStatus("listening", true);
  };

  r.onerror = (e) => {
    logDebug(`recognition event: onerror: error=${e.error}`);
    setStatus(`err: ${e.error}`);
    running = false;
    // auto-retry unless permission denied
    if (e.error !== "not-allowed" && e.error !== "service-not-allowed") {
      scheduleRestart();
    }
  };

  r.onend = () => {
    logDebug("recognition event: onend");
    running = false;
    if (settings.enabled) {
      scheduleRestart();
    } else {
      setStatus("stopped");
    }
  };

  r.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const res = event.results[i];
      const transcript = res[0].transcript.toLowerCase().trim();
      logDebug(`recognition event: onresult: transcript="${transcript}" (isFinal=${res.isFinal})`);
      
      const targetWake = settings.wakeWord || "cream";
      const wakeMatch = matchWakeWord(transcript, targetWake);
      if (!wakeMatch) {
        continue;
      }
      
      const after = transcript.slice(wakeMatch.index + wakeMatch.matched.length).trim();
      
      chrome.runtime.sendMessage({
        type: "SPEECH_RESULT_UPDATE",
        transcript: after,
        isFinal: res.isFinal
      }).catch(() => {});
    }
  };

  return r;
}

function scheduleRestart() {
  logDebug("scheduleRestart: scheduling restart in 600ms");
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => start(), 600);
}

function start() {
  logDebug(`start: enabled=${settings.enabled}, running=${running}`);
  if (!settings.enabled) return;
  if (running) {
    logDebug("start: already running, skipping start request");
    return;
  }
  
  // Recreate recognition instance on every start to prevent browser-side state corruption
  recognition = initRecognition();
  if (!recognition) return;

  try {
    logDebug("start: calling recognition.start()");
    recognition.start();
  } catch (e) {
    logDebug(`start: call failed: ${e.message || String(e)}`);
    scheduleRestart(); // Retry on synchronous start failures
  }
}

function stop() {
  logDebug("stop: stopping speech recognition");
  if (recognition && running) {
    try {
      recognition.stop();
    } catch (_) {}
  }
  recognition = null;
  setStatus("stopped");
}

// Keep-alive ping to prevent the offscreen document from being closed due to inactivity
setInterval(() => {
  logDebug("Sending KEEP_ALIVE ping to service worker");
  chrome.runtime.sendMessage({ 
    type: "KEEP_ALIVE",
    payload: { running, status: currentStatus }
  }).catch(() => {});
}, 15000); // Ping every 15 seconds

// Boot
function boot() {
  logDebug("Booting offscreen document script");
  loadSettingsFromUrl();
  
  // Listen for real-time updates from background script
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "SETTINGS_UPDATED") {
      const oldEnabled = settings.enabled;
      settings = { ...settings, ...msg.settings };
      logDebug(`SETTINGS_UPDATED received: wakeWord="${settings.wakeWord}", enabled=${settings.enabled}`);
      if (settings.enabled) {
        start();
      } else {
        stop();
      }
    }
    
    if (msg?.type === "REQUEST_SPEECH_STATUS") {
      logDebug("REQUEST_SPEECH_STATUS received, responding with current status");
      setStatus(currentStatus, running);
    }
  });

  if (settings.enabled) {
    start();
  } else {
    setStatus("disabled");
  }
}

boot();
