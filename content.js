// Cream content script - runs on YouTube pages
// Listens for wake word via Web Speech API and executes YouTube video commands

(function () {
  if (window.__creamInjected) return;
  window.__creamInjected = true;

  const NUMBER_WORDS = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
    seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
    thirteen: 13, fourteen: 14, fifteen: 15, twenty: 20, thirty: 30,
    forty: 40, fifty: 50, sixty: 60
  };

  let settings = {
    enabled: true,
    wakeWord: "cream",
    seekMultiplier: 1,
    defaultSeekSeconds: 5,
    beepOnDetect: true
  };

  let recognition = null;
  let running = false;
  let restartTimer = null;
  let isVirtualFullscreen = false;

  // === UI badge ===
  const badge = document.createElement("div");
  badge.id = "cream-badge";
  badge.setAttribute("data-testid", "cream-badge");
  badge.innerHTML = `
    <div class="spz-dot"></div>
    <div class="spz-text">CREAM</div>
    <div class="spz-status" data-testid="cream-status">idle</div>
  `;
  document.documentElement.appendChild(badge);

  const statusEl = badge.querySelector(".spz-status");
  const dotEl = badge.querySelector(".spz-dot");

  function setStatus(txt, listening = false) {
    if (statusEl) statusEl.textContent = txt;
    badge.classList.toggle("listening", listening);
    if (dotEl) dotEl.classList.toggle("pulse", listening);
  }

  function flashCommand(text) {
    const el = document.createElement("div");
    el.className = "spz-flash";
    el.setAttribute("data-testid", "cream-flash");
    el.textContent = text;
    document.documentElement.appendChild(el);
    setTimeout(() => el.remove(), 1600);
  }

  // === Futuristic HUD Popup ===
  const hudPopup = document.createElement("div");
  hudPopup.id = "cream-hud-popup";
  hudPopup.innerHTML = `
    <div class="hud-header">
      <span>CREAM HUD v1.0</span>
      <div class="hud-header-dot pulse"></div>
    </div>
    <div class="hud-text" id="cream-hud-text"></div>
    <div class="hud-footer">
      <span id="cream-hud-status">SYS.ACTIVE</span>
      <div class="hud-progress-bar">
        <div class="hud-progress-fill" id="cream-hud-progress"></div>
      </div>
    </div>
  `;
  document.documentElement.appendChild(hudPopup);

  const hudText = hudPopup.querySelector("#cream-hud-text");
  const hudStatus = hudPopup.querySelector("#cream-hud-status");
  const hudProgress = hudPopup.querySelector("#cream-hud-progress");
  let hudTimeout = null;
  let hudIdleTimer = null;

  let inContinuousMode = false;
  let scrollDirection = null; // "down" or "up"
  let scrollCounter = 0;

  function resetScrollCounter() {
    scrollDirection = null;
    scrollCounter = 0;
  }

  function showHud(text, isFinal = false) {
    clearTimeout(hudTimeout);
    clearTimeout(hudIdleTimer);
    hudPopup.classList.add("visible");
    
    const trimmed = (text || "").trim();

    if (trimmed) {
      hudText.textContent = trimmed;
      hudText.classList.toggle("final", isFinal);
    } else {
      hudText.textContent = inContinuousMode ? "SCROLL MODE ACTIVE — SAY 'DOWN', 'UP', OR 'STOP'" : "listening for command...";
      hudText.classList.remove("final");
    }

    if (isFinal) {
      if (trimmed) {
        const lowerCmd = trimmed.toLowerCase();
        
        // Instant exit commands
        if (["stop", "done", "close", "cancel", "exit"].includes(lowerCmd)) {
          hideHud();
          return;
        }

        // Instant Scroll commands (Continuous Mode with Counter)
        const isScrollCmd = /(?:scroll|down|up|go down|go up|godown|goup|gold down|gold up|go town|co down|co up|grow down|grow up|going down|going up|page down|page up|slide down|slide up|move down|move up)/i.test(lowerCmd);
        
        if (isScrollCmd || inContinuousMode) {
          const res = executeCommand(trimmed);
          if (res.action === "scroll_down" || res.action === "scroll_up") {
            inContinuousMode = true;
            const dir = res.details.dirLabel || (res.action === "scroll_down" ? "Down" : "Up");
            const cnt = res.details.counter || scrollCounter;
            
            hudText.textContent = `Scrolling ${dir} => +${cnt}`;
            hudText.classList.add("final");
            hudStatus.textContent = "CONTINUOUS SCROLL MODE — SAY 'DOWN', 'UP', OR 'STOP'";
            hudProgress.style.transition = "none";
            hudProgress.style.width = "100%";
            
            // Keep HUD open for 10 seconds of idle scrolling
            hudIdleTimer = setTimeout(() => {
              hideHud();
            }, 10000);
            return;
          } else if (res.action !== "unknown" && res.action !== "empty") {
            // Non-scroll valid command executed -> exit continuous mode
            hideHud();
            return;
          }
        }

        // Instant Skip Ad execution
        if (lowerCmd.includes("skip") || lowerCmd.includes("keep") || lowerCmd.includes("ad")) {
          const res = executeCommand(trimmed);
          if (res.action === "skip_ad") {
            hideHud();
            return;
          }
        }

        hudStatus.textContent = "command received — executing in 2s";
        hudProgress.style.transition = "none";
        hudProgress.style.width = "0%";
        // Trigger reflow
        hudProgress.offsetHeight;
        hudProgress.style.transition = "width 2s linear";
        hudProgress.style.width = "100%";

        // Wait 2 seconds, execute the command, then hide
        hudTimeout = setTimeout(() => {
          executeCommand(trimmed);
          hideHud();
        }, 2000);
      } else {
        // Wake word detected, but no command yet in this chunk!
        hudStatus.textContent = inContinuousMode ? "CONTINUOUS SCROLL MODE ACTIVE" : "CREAM HEARD — SAY YOUR COMMAND NOW";
        hudProgress.style.transition = "none";
        hudProgress.style.width = "0%";
        
        // Auto-hide HUD after 8 seconds if no command is spoken
        hudIdleTimer = setTimeout(() => {
          hideHud();
        }, 8000);
      }
    } else {
      hudStatus.textContent = inContinuousMode ? "LISTENING FOR NEXT SCROLL COMMAND..." : "processing voice input...";
      hudProgress.style.transition = "none";
      hudProgress.style.width = "0%";
    }
  }

  function hideHud() {
    inContinuousMode = false;
    resetScrollCounter();
    hudPopup.classList.remove("visible");
    clearTimeout(hudTimeout);
    clearTimeout(hudIdleTimer);
    setTimeout(() => {
      hudText.textContent = "";
      hudStatus.textContent = "SYS.ACTIVE";
      hudProgress.style.transition = "none";
      hudProgress.style.width = "0%";
    }, 300);
  }

  // === Video helpers ===
  function getVideo() {
    return document.querySelector("video.html5-main-video") || document.querySelector("video");
  }

  function parseSeconds(text) {
    // matches "10", "10 seconds", "ten sec", etc.
    const m = text.match(/(\d+)\s*(?:s|sec|secs|second|seconds|m|min|minute|minutes)?/i);
    if (m) {
      const n = parseInt(m[1], 10);
      if (text.match(/min|minute/i)) return n * 60;
      return n;
    }
    for (const w in NUMBER_WORDS) {
      if (new RegExp(`\\b${w}\\b`, "i").test(text)) {
        let n = NUMBER_WORDS[w];
        if (text.match(/min|minute/i)) n *= 60;
        return n;
      }
    }
    return null;
  }

  function clickSelectors(...selectors) {
    for (const s of selectors) {
      const el = document.querySelector(s);
      if (el) {
        el.click();
        return true;
      }
    }
    return false;
  }

  function toggleFullscreen() {
    const player = document.querySelector("#movie_player") || document.querySelector(".html5-video-player") || document.querySelector("#player-container");
    if (player) {
      isVirtualFullscreen = !isVirtualFullscreen;
      player.classList.toggle("cream-fullscreen-active", isVirtualFullscreen);
      document.documentElement.classList.toggle("cream-fullscreen-html-active", isVirtualFullscreen);
      
      // Request background script to toggle browser window fullscreen state
      chrome.runtime.sendMessage({ type: "TOGGLE_WINDOW_FULLSCREEN" }).catch(() => {});
      
      const handleResize = () => {
        const isOSFullscreen = window.innerHeight === window.screen.height || document.fullscreenElement !== null;
        if (!isOSFullscreen && isVirtualFullscreen) {
          isVirtualFullscreen = false;
          player.classList.remove("cream-fullscreen-active");
          document.documentElement.classList.remove("cream-fullscreen-html-active");
        }
      };
      window.removeEventListener("resize", handleResize);
      window.addEventListener("resize", handleResize);
    } else {
      clickSelectors(".ytp-fullscreen-button");
    }
  }

  function nextVideo() {
    if (!clickSelectors(".ytp-next-button")) {
      // Try skip-ad / end-screen next
      clickSelectors("a.ytp-videowall-still, .ytp-ce-covering-overlay");
    }
  }

  function skipAd() {
    const adContainer = document.querySelector(".video-ads, .html5-video-player, #movie_player, [class*='ytp-ad']");
    if (!adContainer) return false;

    const selectors = [
      ".ytp-ad-skip-button-modern",
      ".ytp-ad-skip-button",
      ".ytp-skip-ad-button",
      ".ytp-ad-skip-button-slot button",
      ".ytp-ad-skip-button-container button",
      "button[class*='skip-ad']",
      "[class*='ytp-ad-skip-button']",
      "button[aria-label*='Skip ad']",
      "button[aria-label*='Skip Ad']",
      "[aria-label*='Skip ad']",
      "[aria-label*='Skip Ad']",
      ".ytp-ad-skip-button-slot",
      ".ytp-ad-skip-button-container",
      "button[id^='skip-button']",
      ".ytp-ad-skip-button-text"
    ];
    
    let clicked = false;

    for (const s of selectors) {
      const elements = adContainer.querySelectorAll(s);
      for (const el of elements) {
        if (el && (el.offsetWidth > 0 || el.offsetHeight > 0)) {
          try {
            el.click();
            const events = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"];
            for (const evType of events) {
              const ev = new MouseEvent(evType, { bubbles: true, cancelable: true, view: window });
              el.dispatchEvent(ev);
            }
            if (el.parentElement) {
              try { el.parentElement.click(); } catch (_) {}
            }
            clicked = true;
          } catch (_) {}
        }
      }
    }
    
    if (!clicked) {
      const elements = adContainer.querySelectorAll("button, div.ytp-ad-text, span.ytp-ad-text");
      for (const el of elements) {
        if (el.textContent && /(?:skip|keep)\s*ad/i.test(el.textContent.trim())) {
          try {
            el.click();
            const ev = new MouseEvent("click", { bubbles: true, cancelable: true, view: window });
            el.dispatchEvent(ev);
            clicked = true;
          } catch (_) {}
        }
      }
    }
    
    return clicked;
  }

  let lastAutoSkipTime = 0;
  let autoSkipThrottleTimer = null;

  function autoSkipAdLoop() {
    const now = Date.now();
    const skipped = skipAd();
    if (skipped && now - lastAutoSkipTime > 3000) {
      lastAutoSkipTime = now;
      flashCommand("▸ auto skipped ad");
    }
  }

  // === Lightweight Auto-Skip Ad MutationObserver & Event Engine ===
  function startAutoSkipObserver() {
    autoSkipAdLoop();

    // Smooth 800ms interval loop
    setInterval(autoSkipAdLoop, 800);

    // Throttled MutationObserver on video player container
    const observer = new MutationObserver(() => {
      if (!autoSkipThrottleTimer) {
        autoSkipThrottleTimer = setTimeout(() => {
          autoSkipThrottleTimer = null;
          autoSkipAdLoop();
        }, 400);
      }
    });

    const target = document.querySelector("#movie_player, .html5-video-player, .video-ads") || document.body;
    if (target) {
      observer.observe(target, { childList: true, subtree: true });
    }

    document.addEventListener("playing", autoSkipAdLoop, true);
  }

  try {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", startAutoSkipObserver);
    } else {
      startAutoSkipObserver();
    }
  } catch (_) {}

  const ORDINAL_MAP = {
    first: 1, "1st": 1, one: 1,
    second: 2, "2nd": 2, two: 2,
    third: 3, "3rd": 3, three: 3,
    fourth: 4, "4th": 4, four: 4,
    fifth: 5, "5th": 5, five: 5,
    sixth: 6, "6th": 6, six: 6,
    seventh: 7, "7th": 7, seven: 7,
    eighth: 8, "8th": 8, eight: 8,
    ninth: 9, "9th": 9, nine: 9,
    tenth: 10, "10th": 10, ten: 10,
    eleventh: 11, "11th": 11,
    twelfth: 12, "12th": 12,
    thirteenth: 13, "13th": 13,
    fourteenth: 14, "14th": 14,
    fifteenth: 15, "15th": 15
  };

  function parseVideoIndex(str) {
    const digitMatch = str.match(/(?:video|number|result|\b)\s*#?(\d+)/i) || str.match(/(\d+)\s*(?:st|nd|rd|th)?\s*(?:video|result)?/i);
    if (digitMatch) {
      const num = parseInt(digitMatch[1], 10);
      if (num >= 1 && num <= 50) return num;
    }
    for (const key in ORDINAL_MAP) {
      if (new RegExp(`\\b${key}\\b`, "i").test(str)) {
        return ORDINAL_MAP[key];
      }
    }
    return null;
  }

  function playNthVideo(n) {
    const cardSelector = [
      "ytd-video-renderer",
      "ytd-grid-video-renderer",
      "ytd-compact-video-renderer",
      "ytd-rich-item-renderer",
      "ytd-playlist-video-renderer"
    ].join(", ");

    const cards = Array.from(document.querySelectorAll(cardSelector));
    const validLinks = [];
    const seenHrefs = new Set();

    if (cards.length > 0) {
      for (const card of cards) {
        const link = card.querySelector("a#video-title, a#video-title-link, a#thumbnail, a.yt-simple-endpoint");
        if (link && link.href && link.href.includes("/watch")) {
          try {
            const urlObj = new URL(link.href, location.origin);
            const videoId = urlObj.searchParams.get("v") || link.href;
            if (!seenHrefs.has(videoId)) {
              seenHrefs.add(videoId);
              validLinks.push(link);
            }
          } catch (_) {}
        }
      }
    }

    // Fallback if cards selector yielded fewer items
    if (validLinks.length === 0) {
      const allLinks = Array.from(document.querySelectorAll("a#video-title, a#video-title-link, a.yt-simple-endpoint")).filter(el => el.href && el.href.includes("/watch"));
      for (const link of allLinks) {
        try {
          const urlObj = new URL(link.href, location.origin);
          const videoId = urlObj.searchParams.get("v") || link.href;
          if (!seenHrefs.has(videoId)) {
            seenHrefs.add(videoId);
            validLinks.push(link);
          }
        } catch (_) {}
      }
    }

    if (validLinks.length > 0) {
      const idx = Math.max(0, Math.min(n - 1, validLinks.length - 1));
      const target = validLinks[idx];
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      target.click();
      return true;
    }
    return false;
  }

  function playVideoByTitle(query) {
    if (!query) return false;
    const cleanQuery = query.toLowerCase().trim();
    const queryWords = cleanQuery.split(/\s+/).filter(w => w.length > 1);
    if (queryWords.length === 0) return false;

    const selector = [
      "ytd-video-renderer a#video-title",
      "ytd-grid-video-renderer a#video-title",
      "ytd-compact-video-renderer a#video-title",
      "ytd-rich-item-renderer a#video-title-link",
      "ytd-rich-item-renderer a#video-title",
      "a#video-title"
    ].join(", ");

    const links = Array.from(document.querySelectorAll(selector)).filter(el => el.href && el.href.includes("/watch"));

    // Check 1: exact/full words match
    for (const link of links) {
      const title = (link.textContent || link.title || "").toLowerCase();
      const matchesAll = queryWords.every(word => title.includes(word));
      if (matchesAll) {
        link.scrollIntoView({ behavior: "smooth", block: "center" });
        link.click();
        return true;
      }
    }

    // Check 2: partial word match if at least 2 words
    if (queryWords.length >= 2) {
      for (const link of links) {
        const title = (link.textContent || link.title || "").toLowerCase();
        const matchCount = queryWords.filter(word => title.includes(word)).length;
        if (matchCount >= Math.ceil(queryWords.length * 0.6)) {
          link.scrollIntoView({ behavior: "smooth", block: "center" });
          link.click();
          return true;
        }
      }
    }

    return false;
  }

  function playFirstResult() {
    return playNthVideo(1);
  }

  function searchAndPlay(query) {
    if (!query) return false;
    const cleanQuery = query.trim();
    
    const searchInput = document.querySelector(
      "input#search, input.ytd-searchbox, input[name='search_query'], input[aria-label='Search']"
    );

    if (searchInput) {
      try {
        searchInput.focus();
        searchInput.value = cleanQuery;
        searchInput.dispatchEvent(new Event("input", { bubbles: true }));
        searchInput.dispatchEvent(new Event("change", { bubbles: true }));

        const searchBtn = document.querySelector(
          "button#search-icon-legacy, button.ytd-searchbox, #search-button button, form#search-form button"
        );
        if (searchBtn) {
          searchBtn.click();
          return true;
        }
        if (searchInput.form) {
          searchInput.form.submit();
          return true;
        }
      } catch (_) {}
    }

    // Direct navigation fallback
    window.location.href = `https://www.youtube.com/results?search_query=${encodeURIComponent(cleanQuery)}`;
    return true;
  }

  function scrollPage(direction = "down", pct = null) {
    const distance = pct ? (window.innerHeight * pct) : (window.innerHeight * 0.7);
    const deltaY = direction === "down" ? distance : -distance;
    
    window.scrollBy({ top: deltaY, behavior: "smooth" });

    // Secondary fallback for YouTube custom container scrolling
    const app = document.querySelector("ytd-app, #content, html, body");
    if (app && app.scrollBy) {
      try {
        app.scrollBy({ top: deltaY, behavior: "smooth" });
      } catch (_) {}
    }
    return Math.round(distance);
  }

  // === Command execution ===
  function executeCommand(commandText) {
    const video = getVideo();
    const cmd = commandText.trim().toLowerCase();
    let action = "unknown";
    let details = {};

    if (!cmd) return { action: "empty" };

    // Define all fuzzy lists of keywords (including phonetic mistakes)
    const playKeywords = ["play", "resume", "start", "continue", "plan", "clay", "place", "player", "played", "plague", "lane", "playing"];
    const pauseKeywords = ["pause", "stop", "halt", "freeze", "pass", "claws", "cause", "boss", "pose", "abort", "pulse", "parts", "baths"];
    const skipAdKeywords = [
      "skip ad", "skip ads", "skip the ad", "skip the ads", "skip advertisement", "remove ad", "close ad", "close ads",
      "keep ad", "keep ads", "keep the ad", "keep the ads", "skipped ad", "skipped ads", "skip add", "skip at",
      "scape ad", "skate ad", "sleep ad", "ship ad", "pass ad", "bypass ad"
    ];
    const muteKeywords = ["mute", "silent", "quiet", "mew", "meat", "shoot", "moat"];
    const unmuteKeywords = ["unmute", "sound", "voice", "un-mute", "on mute"];
    const scrollDownKeywords = ["scroll down", "go down", "godown", "gold down", "go town", "co down", "grow down", "going down", "down", "down page", "page down", "slide down", "scroll-down", "move down", "scrolldown"];
    const scrollUpKeywords = ["scroll up", "go up", "goup", "gold up", "go top", "co up", "grow up", "going up", "up", "up page", "page up", "slide up", "scroll-up", "move up", "scrollup"];
    const volumeUpKeywords = ["volume up", "louder", "increase", "higher", "raise", "increase volume", "volume-up", "out"];
    const volumeDownKeywords = ["volume down", "quieter", "softer", "decrease", "lower", "reduce", "decrease volume", "volume-down", "town"];
    const fullscreenKeywords = ["fullscreen", "full screen", "full-screen", "maximize", "window", "big screen", "scream"];
    const backKeywords = ["back", "rewind", "reverse", "previous", "behind", "return", "left", "go back", "mac", "bag", "pack"];
    const forwardKeywords = ["forward", "ahead", "advance", "right", "go forward", "onward", "skip forward"];
    const nextKeywords = ["next video", "next one", "skip video", "forward video", "skip one", "next-video", "skip-video"];
    const firstResultKeywords = [
      "play first video", "play first result", "open first video", "open first result", 
      "play top video", "play top result", "first video", "first result", "top result"
    ];
    const genericPlayWords = ["", "video", "song", "music", "audio", "it", "this", "again", "on", "now", "player"];

    const containsAny = (str, keywords) => {
      return keywords.some(kw => new RegExp(`\\b${kw.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, "i").test(str) || str.includes(kw));
    };

    const hasNumber = (str) => {
      return /\d+/.test(str) || ["one","two","three","four","five","six","seven","eight","nine","ten","eleven","twelve","thirteen","fourteen","fifteen","twenty","thirty","forty","fifty","sixty"].some(w => new RegExp(`\\b${w}\\b`, "i").test(str));
    };

    const hasTimeIndicator = (str) => {
      return /(second|sec|minute|min)/i.test(str) || hasNumber(str);
    };

    const parsePercentage = (str) => {
      const m = str.match(/(\d+)\s*(?:%|percent|prcent)?/i);
      if (m) {
        const val = parseInt(m[1], 10);
        if (val > 0 && val <= 100) return val / 100;
      }
      const words = {
        ten: 0.1, twenty: 0.2, thirty: 0.3, forty: 0.4, fifty: 0.5,
        sixty: 0.6, seventy: 0.7, eighty: 0.8, ninety: 0.9, hundred: 1.0
      };
      for (const w in words) {
        if (new RegExp(`\\b${w}\\b`, "i").test(str)) {
          return words[w];
        }
      }
      return null;
    };

    // Extract search query strictly if user explicitly spoke "search <query>", "search for <query>", or "find <query>"
    let searchQuery = null;
    const searchMatch = cmd.match(/^(?:search|find|look for)\s+(?:for\s+)?(?:song\s+|video\s+)?(.+)/i);
    if (searchMatch) {
      const potentialQuery = searchMatch[1].trim();
      if (!genericPlayWords.includes(potentialQuery) && potentialQuery.length > 1) {
        searchQuery = potentialQuery;
      }
    }

    // Extract title query if user spoke "play <specific on-page video title>"
    let playTitleQuery = null;
    const playMatch = cmd.match(/^play\s+(?:song\s+|video\s+)?(.+)/i);
    if (playMatch) {
      const potentialQuery = playMatch[1].trim();
      if (!genericPlayWords.includes(potentialQuery) && potentialQuery.length > 1) {
        playTitleQuery = potentialQuery;
      }
    }

    const videoIndexMatch = parseVideoIndex(cmd);

    // Determine action
    if (containsAny(cmd, firstResultKeywords)) {
      const clicked = playFirstResult();
      action = "play_first_result";
      details = { success: clicked };
    } else if (videoIndexMatch && (cmd.includes("video") || cmd.includes("result") || cmd.includes("number") || cmd.includes("play") || cmd.includes("open"))) {
      const clicked = playNthVideo(videoIndexMatch);
      action = "play_nth_video";
      details = { index: videoIndexMatch, success: clicked };
    } else if (searchQuery) {
      searchAndPlay(searchQuery);
      action = "search_play";
      details = { query: searchQuery };
    } else if (playTitleQuery) {
      const matchedOnPage = playVideoByTitle(playTitleQuery);
      if (matchedOnPage) {
        action = "play_matched_title";
        details = { query: playTitleQuery, success: true };
      } else if (video && video.paused) {
        video.play();
        action = "play";
      }
    } else if (containsAny(cmd, volumeUpKeywords) || cmd.includes("volume up") || cmd.includes("increase volume")) {
      const pct = parsePercentage(cmd) ?? 0.2;
      if (video) video.volume = Math.min(1, video.volume + pct);
      action = "volume_up";
      details = { amount: pct * 100 };
    } else if (containsAny(cmd, volumeDownKeywords) || cmd.includes("volume down") || cmd.includes("decrease volume")) {
      const pct = parsePercentage(cmd) ?? 0.2;
      if (video) video.volume = Math.max(0, video.volume - pct);
      action = "volume_down";
      details = { amount: pct * 100 };
    } else if (!cmd.includes("volume") && !cmd.includes("sound") && !cmd.includes("audio") && (containsAny(cmd, scrollDownKeywords) || cmd === "scroll down" || cmd === "down")) {
      if (scrollDirection !== "down") {
        scrollDirection = "down";
        scrollCounter = 1;
      } else {
        scrollCounter++;
      }
      const pct = parsePercentage(cmd);
      const dist = scrollPage("down", pct);
      action = "scroll_down";
      details = { pixels: dist, counter: scrollCounter, dirLabel: "Down" };
    } else if (!cmd.includes("volume") && !cmd.includes("sound") && !cmd.includes("audio") && (containsAny(cmd, scrollUpKeywords) || cmd === "scroll up" || cmd === "up")) {
      if (scrollDirection !== "up") {
        scrollDirection = "up";
        scrollCounter = 1;
      } else {
        scrollCounter++;
      }
      const pct = parsePercentage(cmd);
      const dist = scrollPage("up", pct);
      action = "scroll_up";
      details = { pixels: dist, counter: scrollCounter, dirLabel: "Up" };
    } else if (containsAny(cmd, pauseKeywords)) {
      if (video && !video.paused) video.pause();
      action = "pause";
    } else if (containsAny(cmd, playKeywords)) {
      if (video && video.paused) video.play();
      action = "play";
    } else if (containsAny(cmd, skipAdKeywords)) {
      const skipped = skipAd();
      action = "skip_ad";
      details = { success: skipped };
    } else if (containsAny(cmd, unmuteKeywords)) {
      if (video) video.muted = false;
      action = "unmute";
    } else if (containsAny(cmd, muteKeywords)) {
      if (video) video.muted = true;
      action = "mute";
    } else if (containsAny(cmd, fullscreenKeywords)) {
      toggleFullscreen();
      action = "fullscreen";
    } else if (containsAny(cmd, backKeywords)) {
      const parsed = parseSeconds(cmd);
      const base = parsed ?? settings.defaultSeekSeconds;
      const seconds = base * (settings.seekMultiplier || 1);
      if (video) video.currentTime = Math.max(0, video.currentTime - seconds);
      action = "seek_back";
      details = { seconds };
    } else if (containsAny(cmd, forwardKeywords) || ((cmd.includes("skip") || cmd.includes("next")) && hasTimeIndicator(cmd))) {
      const parsed = parseSeconds(cmd);
      const base = parsed ?? settings.defaultSeekSeconds;
      const seconds = base * (settings.seekMultiplier || 1);
      if (video) video.currentTime = Math.min(video.duration || Infinity, video.currentTime + seconds);
      action = "seek_forward";
      details = { seconds };
    } else if (containsAny(cmd, nextKeywords) || cmd === "next" || cmd === "skip" || ((cmd.includes("skip") || cmd.includes("next")) && !hasTimeIndicator(cmd))) {
      nextVideo();
      action = "next_video";
    }

    flashCommand(`▸ ${action.replace(/_/g, " ")}${details.seconds ? " " + details.seconds + "s" : ""}`);

    // Log diagnostics
    try {
      chrome.runtime.sendMessage({
        type: "LOG_DEBUG",
        msg: `[Content] executeCommand: parsed raw "${commandText}" to action "${action}"`
      }).catch(() => {});
    } catch (_) {}

    // Log to companion API via background
    try {
      chrome.runtime.sendMessage({
        type: "LOG_COMMAND",
        payload: {
          transcript: commandText,
          action,
          details,
          url: location.href,
          videoTitle: document.title,
          timestamp: new Date().toISOString()
        }
      });
    } catch (_) {}

    return { action, details };
  }

  // === Message and settings handling ===
  async function loadSettings() {
    try {
      const { settings: s } = await chrome.storage.local.get("settings");
      if (s) settings = { ...settings, ...s };
    } catch (_) {}
  }

  chrome.storage?.onChanged?.addListener((changes) => {
    if (changes.settings) {
      settings = { ...settings, ...changes.settings.newValue };
    }
  });

  // Listen to messages from background service worker
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === "PING_STATUS") {
      sendResponse({ running, enabled: settings.enabled, url: location.href });
    } else if (msg?.type === "SPEECH_STATUS_UPDATE") {
      running = msg.payload.running;
      setStatus(msg.payload.status, msg.payload.running);
    } else if (msg?.type === "SHOW_SPEECH_POPUP") {
      showHud(msg.transcript, msg.isFinal);
    }
  });

  // Boot
  loadSettings().then(() => {
    if (settings.enabled) {
      chrome.runtime.sendMessage({ type: "TAB_LOADED" }).catch(() => {});
      chrome.runtime.sendMessage({ type: "GET_SPEECH_STATUS" }, (resp) => {
        if (resp) {
          running = resp.running;
          setStatus(resp.status, resp.running);
        }
      });
    } else {
      setStatus("disabled");
    }
  });
})();
