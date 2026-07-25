const micBtn = document.getElementById("micBtn");
const micStatus = document.getElementById("micStatus");
const openYt = document.getElementById("openYt");
const apiBase = document.getElementById("apiBase");
const saveApi = document.getElementById("saveApi");

async function loadSettings() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  apiBase.value = settings.apiBase || "";
}

micBtn.addEventListener("click", async () => {
  micStatus.innerHTML = '<span class="warn">Requesting…</span>';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    micStatus.innerHTML = '<span class="ok">✓ Microphone granted</span>';
  } catch (e) {
    micStatus.innerHTML = `<span class="warn">✗ ${e.name || "Denied"}. Enable it in browser settings.</span>`;
  }
});

openYt.addEventListener("click", () => {
  chrome.tabs.create({ url: "https://www.youtube.com" });
});

saveApi.addEventListener("click", async () => {
  const { settings = {} } = await chrome.storage.local.get("settings");
  settings.apiBase = apiBase.value.trim();
  await chrome.storage.local.set({ settings });
  saveApi.textContent = "SAVED ✓";
  setTimeout(() => (saveApi.textContent = "SAVE"), 1200);
});

loadSettings();

// Debug logs rendering
const debugLogsEl = document.getElementById("debugLogs");
const clearLogsBtn = document.getElementById("clearLogsBtn");

async function updateDebugLogs() {
  if (!debugLogsEl) return;
  try {
    const { debugLogs = [] } = await chrome.storage.local.get("debugLogs");
    debugLogsEl.textContent = debugLogs.join("\n") || "No logs yet.";
  } catch (_) {}
}

if (clearLogsBtn) {
  clearLogsBtn.addEventListener("click", async () => {
    try {
      await chrome.storage.local.set({ debugLogs: [] });
      updateDebugLogs();
    } catch (_) {}
  });
}

// Keep logs updated
updateDebugLogs();
setInterval(updateDebugLogs, 1000);

// Auto-open onboarding hint
if (new URLSearchParams(location.search).get("onboarding") === "1") {
  document.title = "Welcome to Cream";
}
