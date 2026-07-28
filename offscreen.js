// Cream offscreen speech recognition script
// Runs Web Speech API inside the extension origin to leverage microphone permissions.
// NOTE: chrome.storage is not available in offscreen documents. Settings and logs are passed via messaging.

let recognition = null;
let running = false;
let isStarting = false;
let currentStatus = "idle";
let consecutiveFailures = 0;
let settings = {
  enabled: true,
  wakeWord: "cream"
};
let restartTimer = null;

// Sticky Wake Window state
let wakeActive = false;
let wakeTimer = null;

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
  
  // Phonetic variations for Speakzy & Cream
  variations.push(
    "speakzy", "speaksy", "speak-zy", "speaks e", "speaks he", "speaks easy",
    "speakeasy", "speak easy", "speak see", "speaks see", "speaks sea",
    "speak z", "speaks z", "spikzy", "speakzi", "speaksi", "speaker",
    "spiffy", "spinzy", "speakzy.", "speakzy,", "speak", "speaks",
    "cream", "scream", "dream", "clean", "green", "queen", "gleam", "grim", 
    "creme", "crème", "crane", "chrome", "chroma", "stream", 
    "cray", "crayola", "kream", "crim", "crimp", "krem", "crem",
    "reem", "ream", "kareem", "karim", "careem", "screen", "claim",
    "crime", "cream.", "cream,", "creamy", "kreamy"
  );

  const cleanTranscript = transcript.toLowerCase();

  for (const v of variations) {
    const pattern = `(?:^|\\b|\\s)${v.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}(?:$|\\b|\\s|[.,!?:;])`;
    const regex = new RegExp(pattern, "i");
    const match = cleanTranscript.match(regex);
    if (match) {
      const matchedStr = match[0].trim();
      const index = cleanTranscript.indexOf(matchedStr);
      return { matched: matchedStr, index: index >= 0 ? index : 0 };
    }
  }
  
  return null;
}

function activateWakeWindow() {
  wakeActive = true;
  clearTimeout(wakeTimer);
  wakeTimer = setTimeout(() => {
    wakeActive = false;
    logDebug("Wake window expired (6s inactive)");
  }, 6000);
}

function resetWakeWindow() {
  wakeActive = false;
  clearTimeout(wakeTimer);
}

let isStartingTimeout = null;

function cleanupRecognition() {
  clearTimeout(isStartingTimeout);
  if (recognition) {
    try {
      recognition.onstart = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition.onresult = null;
      recognition.abort();
    } catch (_) {}
    recognition = null;
  }
}

function initRecognition() {
  logDebug("initRecognition: initializing webkitSpeechRecognition");
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    setStatus("no speech api");
    logDebug("initRecognition: SpeechRecognition API not supported in this environment");
    return null;
  }

  cleanupRecognition();

  const r = new SR();
  r.continuous = true;
  r.interimResults = true;
  r.lang = "en-US";

  r.onstart = () => {
    logDebug("recognition event: onstart (started listening)");
    consecutiveFailures = 0;
    isStarting = false;
    clearTimeout(isStartingTimeout);
    setStatus("listening", true);
  };

  r.onerror = (e) => {
    logDebug(`recognition event: onerror: error=${e.error}`);
    setStatus(`err: ${e.error}`);
    running = false;
    isStarting = false;
    clearTimeout(isStartingTimeout);
    consecutiveFailures++;
    
    // auto-retry unless permission denied
    if (e.error !== "not-allowed" && e.error !== "service-not-allowed") {
      scheduleRestart(e.error);
    }
  };

  r.onend = () => {
    logDebug("recognition event: onend");
    running = false;
    isStarting = false;
    clearTimeout(isStartingTimeout);
    if (settings.enabled) {
      scheduleRestart("onend");
    } else {
      setStatus("stopped");
    }
  };

  r.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const res = event.results[i];
      const transcript = res[0].transcript.toLowerCase().trim();
      logDebug(`recognition event: onresult: transcript="${transcript}" (isFinal=${res.isFinal})`);
      
      const targetWake = settings.wakeWord || "speakzy";
      const wakeMatch = matchWakeWord(transcript, targetWake);
      
      if (wakeMatch) {
        activateWakeWindow();
        const after = transcript.slice(wakeMatch.index + wakeMatch.matched.length).trim();
        
        chrome.runtime.sendMessage({
          type: "SPEECH_RESULT_UPDATE",
          transcript: after,
          isFinal: res.isFinal
        }).catch(() => {});

        if (res.isFinal && after) {
          resetWakeWindow();
        }
      } else if (wakeActive) {
        // Wake word was recently spoken in previous chunk! Treat this as command.
        logDebug(`onresult: processing via active wake window: "${transcript}"`);
        
        chrome.runtime.sendMessage({
          type: "SPEECH_RESULT_UPDATE",
          transcript: transcript,
          isFinal: res.isFinal
        }).catch(() => {});

        if (res.isFinal) {
          resetWakeWindow();
        }
      }
    }
  };

  return r;
}

function scheduleRestart(reason = "general") {
  clearTimeout(restartTimer);
  let delay = 600;
  if (consecutiveFailures > 0) {
    delay = Math.min(10000, 700 * Math.pow(1.6, consecutiveFailures));
  }
  if (reason === "network" || reason === "audio-capture") {
    delay = Math.max(delay, 2000);
  }
  logDebug(`scheduleRestart [${reason}]: scheduling restart in ${Math.round(delay)}ms (failures=${consecutiveFailures})`);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    start();
  }, delay);
}

function start() {
  logDebug(`start: enabled=${settings.enabled}, running=${running}, isStarting=${isStarting}`);
  if (!settings.enabled) return;
  if (running || isStarting) {
    logDebug("start: already running or starting, skipping start request");
    return;
  }
  
  recognition = initRecognition();
  if (!recognition) return;

  try {
    isStarting = true;
    clearTimeout(isStartingTimeout);
    isStartingTimeout = setTimeout(() => {
      if (isStarting && !running) {
        logDebug("start timeout: onstart did not fire within 3s. Resetting state and retrying.");
        isStarting = false;
        cleanupRecognition();
        scheduleRestart("start_timeout");
      }
    }, 3000);

    logDebug("start: calling recognition.start()");
    recognition.start();
  } catch (e) {
    isStarting = false;
    clearTimeout(isStartingTimeout);
    consecutiveFailures++;
    logDebug(`start: call failed: ${e.message || String(e)}`);
    scheduleRestart("start_catch");
  }
}

function stop() {
  logDebug("stop: stopping speech recognition");
  clearTimeout(restartTimer);
  clearTimeout(isStartingTimeout);
  restartTimer = null;
  resetWakeWindow();
  isStarting = false;
  cleanupRecognition();
  setStatus("stopped");
}

// Keep-alive ping to prevent offscreen document shutdown
setInterval(() => {
  logDebug("Sending KEEP_ALIVE ping to service worker");
  chrome.runtime.sendMessage({ 
    type: "KEEP_ALIVE",
    payload: { running, status: currentStatus }
  }).catch(() => {});
}, 15000);

// Self-healing watchdog to recover from hung/stuck speech engine states
setInterval(() => {
  if (settings.enabled && !running && !isStarting && !restartTimer) {
    logDebug("Watchdog: Speech engine inactive while enabled. Triggering recovery restart.");
    scheduleRestart("watchdog");
  }
}, 4000);

// Boot
function boot() {
  logDebug("Booting offscreen document script");
  loadSettingsFromUrl();
  
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "SETTINGS_UPDATED") {
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
