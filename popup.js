const els = {
  enabled: document.getElementById("enabledToggle"),
  wake: document.getElementById("wakeWord"),
  seek: document.getElementById("defaultSeek"),
  mult: document.getElementById("multiplier"),
  api: document.getElementById("apiBase"),
  save: document.getElementById("saveBtn"),
  pill: document.getElementById("statusPill"),
  tabInfo: document.getElementById("tabInfo"),
  openDash: document.getElementById("openDash"),
  openOptions: document.getElementById("openOptions")
};

async function load() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  els.enabled.checked = settings.enabled ?? true;
  els.wake.value = settings.wakeWord ?? "cream";
  els.seek.value = settings.defaultSeekSeconds ?? 5;
  els.mult.value = settings.seekMultiplier ?? 1;
  els.api.value = settings.apiBase ?? "";
  updatePill(settings.enabled ?? true);

  // Check current tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && /youtube\.com/.test(tab.url || "")) {
    els.tabInfo.textContent = "YouTube tab detected";
    try {
      const resp = await chrome.tabs.sendMessage(tab.id, { type: "PING_STATUS" });
      if (resp) els.tabInfo.textContent = resp.running ? "Listening on this tab" : "Ready (open a video)";
    } catch (_) {}
  }
}

function updatePill(on) {
  els.pill.textContent = on ? "on" : "off";
  els.pill.classList.toggle("on", on);
}

els.save.addEventListener("click", async () => {
  const settings = {
    enabled: els.enabled.checked,
    wakeWord: (els.wake.value || "cream").trim().toLowerCase(),
    defaultSeekSeconds: Math.max(1, parseInt(els.seek.value || "5", 10)),
    seekMultiplier: Math.max(1, parseInt(els.mult.value || "1", 10)),
    apiBase: els.api.value.trim(),
    beepOnDetect: true
  };
  await chrome.storage.local.set({ settings });
  updatePill(settings.enabled);
  els.save.textContent = "SAVED ✓";
  setTimeout(() => (els.save.textContent = "SAVE"), 1200);
});

els.enabled.addEventListener("change", () => updatePill(els.enabled.checked));

els.openDash.addEventListener("click", async (e) => {
  e.preventDefault();
  const { settings = {} } = await chrome.storage.local.get("settings");
  const url = settings.apiBase || "https://speech-video-player.preview.emergentagent.com";
  chrome.tabs.create({ url });
});

els.openOptions.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

load();
