/* =========================================================
   Spin — guess the song from your own Spotify top tracks
   ========================================================= */

const DIFFICULTY = {
  easy:   { label: "Easy",   timeRange: "short_term",  poolSize: 20, guesses: 6, snippetsMs: [3000, 5000, 8000, 12000, 16000, 20000] },
  medium: { label: "Medium", timeRange: "medium_term", poolSize: 35, guesses: 6, snippetsMs: [1000, 2000, 4000, 7000, 11000, 16000] },
  hard:   { label: "Hard",   timeRange: "long_term",   poolSize: 50, guesses: 4, snippetsMs: [1000, 2000, 4000, 7000] },
};

const state = {
  diff: "easy",
  pool: [],          // top-tracks pool for chosen difficulty
  answer: null,       // the track to guess
  guessIndex: 0,       // number of guesses made so far
  guessedTrackIds: [],
  finished: false,
  won: false,
  mode: "random",      // "random" | "daily"
  deviceId: null,
  player: null,
  snippetTimer: null,
  playing: false,
};

const el = (id) => document.getElementById(id);
const screens = {
  login: el("screen-login"),
  setup: el("screen-setup"),
  game: el("screen-game"),
  result: el("screen-result"),
};

function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.add("hidden"));
  screens[name].classList.remove("hidden");
}

function toast(msg, ms = 2600) {
  const t = el("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), ms);
}

/* ---------------- PKCE auth ---------------- */

function randomString(length) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const values = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(values, (v) => chars[v % chars.length]).join("");
}

async function sha256(plain) {
  const data = new TextEncoder().encode(plain);
  return crypto.subtle.digest("SHA-256", data);
}

function base64url(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function loginWithSpotify() {
  if (!CONFIG.CLIENT_ID || CONFIG.CLIENT_ID.startsWith("YOUR_")) {
    toast("Add your Spotify Client ID to config.js first — see README.md");
    return;
  }
  const verifier = randomString(64);
  sessionStorage.setItem("spin_pkce_verifier", verifier);
  const challenge = base64url(await sha256(verifier));

  const params = new URLSearchParams({
    client_id: CONFIG.CLIENT_ID,
    response_type: "code",
    redirect_uri: CONFIG.REDIRECT_URI,
    scope: CONFIG.SCOPES,
    code_challenge_method: "S256",
    code_challenge: challenge,
  });
  window.location.href = `https://accounts.spotify.com/authorize?${params.toString()}`;
}

function saveTokens(data) {
  const expiresAt = Date.now() + data.expires_in * 1000 - 30000; // 30s safety margin
  localStorage.setItem("spin_access_token", data.access_token);
  if (data.refresh_token) localStorage.setItem("spin_refresh_token", data.refresh_token);
  localStorage.setItem("spin_expires_at", String(expiresAt));
}

async function exchangeCodeForToken(code) {
  const verifier = sessionStorage.getItem("spin_pkce_verifier");
  const body = new URLSearchParams({
    client_id: CONFIG.CLIENT_ID,
    grant_type: "authorization_code",
    code,
    redirect_uri: CONFIG.REDIRECT_URI,
    code_verifier: verifier,
  });
  const resp = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error_description || "Token exchange failed");
  saveTokens(data);
}

async function refreshToken() {
  const refresh = localStorage.getItem("spin_refresh_token");
  if (!refresh) throw new Error("No refresh token");
  const body = new URLSearchParams({
    client_id: CONFIG.CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: refresh,
  });
  const resp = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error_description || "Refresh failed");
  saveTokens(data);
}

async function getValidToken() {
  const expiresAt = Number(localStorage.getItem("spin_expires_at") || 0);
  if (Date.now() > expiresAt) await refreshToken();
  return localStorage.getItem("spin_access_token");
}

function isLoggedIn() {
  return Boolean(localStorage.getItem("spin_access_token"));
}

function logoutClear() {
  ["spin_access_token", "spin_refresh_token", "spin_expires_at"].forEach((k) => localStorage.removeItem(k));
}

/* ---------------- Spotify Web API helpers ---------------- */

async function api(path, opts = {}) {
  const token = await getValidToken();
  const resp = await fetch(`https://api.spotify.com/v1${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (resp.status === 204) return null;
  const data = await resp.json().catch(() => null);
  if (!resp.ok) throw new Error(data?.error?.message || `API error ${resp.status}`);
  return data;
}

async function fetchMe() {
  return api("/me");
}

async function fetchTopTracks(timeRange, limit) {
  const data = await api(`/me/top/tracks?time_range=${timeRange}&limit=${limit}`);
  return (data.items || []).filter((t) => t && t.uri && t.duration_ms > 15000);
}

/* ---------------- Web Playback SDK ---------------- */

function loadSpotifySdk() {
  return new Promise((resolve) => {
    if (window.Spotify) return resolve();
    window.onSpotifyWebPlaybackSDKReady = resolve;
    const script = document.createElement("script");
    script.src = "https://sdk.scdn.co/spotify-player.js";
    document.body.appendChild(script);
  });
}

async function initPlayer() {
  await loadSpotifySdk();
  return new Promise((resolve, reject) => {
    const player = new Spotify.Player({
      name: "Spin — song guesser",
      getOAuthToken: (cb) => getValidToken().then(cb),
      volume: 0.75,
    });
    player.addListener("ready", ({ device_id }) => {
      state.deviceId = device_id;
      state.player = player;
      resolve(player);
    });
    player.addListener("initialization_error", ({ message }) => reject(new Error(message)));
    player.addListener("authentication_error", ({ message }) => reject(new Error(message)));
    player.addListener("account_error", ({ message }) => reject(new Error("Spotify Premium is required for playback: " + message)));
    player.connect();
  });
}

async function playSnippet(track, durationMs) {
  const token = await getValidToken();
  await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${state.deviceId}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ uris: [track.uri], position_ms: 0 }),
  });
  setPlayingUi(true);
  clearTimeout(state.snippetTimer);
  state.snippetTimer = setTimeout(() => {
    state.player?.pause();
    setPlayingUi(false);
  }, durationMs);
}

function setPlayingUi(playing) {
  state.playing = playing;
  el("icon-play").classList.toggle("hidden", playing);
  el("icon-pause").classList.toggle("hidden", !playing);
  el("disc").classList.toggle("spinning", playing);
  el("tonearm").classList.toggle("playing", playing);
}

/* ---------------- Daily seed (deterministic pick) ---------------- */

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return h;
}

function pickAnswer(pool, mode, diffKey) {
  if (mode === "daily") {
    const today = new Date().toISOString().slice(0, 10);
    const rand = mulberry32(hashString(today + diffKey));
    return pool[Math.floor(rand() * pool.length)];
  }
  return pool[Math.floor(Math.random() * pool.length)];
}

/* ---------------- Game flow ---------------- */

async function startGame(mode) {
  state.mode = mode;
  const cfg = DIFFICULTY[state.diff];
  showScreen("game");
  el("game-mode-label").textContent = `${cfg.label} · ${mode === "daily" ? "Today's challenge" : "Random"}`;
  resetGameUi();

  try {
    if (!state.pool.length || state.poolDiff !== state.diff) {
      toast("Loading your top tracks…");
      state.pool = await fetchTopTracks(cfg.timeRange, cfg.poolSize);
      state.poolDiff = state.diff;
    }
    if (state.pool.length < 4) {
      toast("Not enough listening history for this difficulty yet — try Easy.");
      return;
    }
    state.answer = pickAnswer(state.pool, mode, state.diff);
    state.guessIndex = 0;
    state.guessedTrackIds = [];
    state.finished = false;
    state.won = false;

    el("art").src = state.answer.album?.images?.[0]?.url || "";
    buildGrooveRing(cfg.guesses);
    updateSnippetLabel();

    if (!state.player) {
      toast("Connecting playback device…");
      await initPlayer();
    }
  } catch (err) {
    console.error(err);
    toast(err.message || "Something went wrong loading the game.");
  }
}

function resetGameUi() {
  el("guess-history").innerHTML = "";
  el("guess-input").value = "";
  el("guess-dropdown").classList.add("hidden");
  el("art").style.filter = "";
  el("art").style.filter = "blur(20px) saturate(0.7)";
  setPlayingUi(false);
  el("btn-play").disabled = false;
  el("btn-guess").disabled = false;
  el("btn-skip").disabled = false;
}

function buildGrooveRing(totalGuesses) {
  const svg = el("groove-svg");
  svg.innerHTML = "";
  const total = totalGuesses;
  const gap = 6; // degrees of gap between segments
  const segLen = 360 / total - gap;
  const r = 118;
  const cx = 120, cy = 120;

  for (let i = 0; i < total; i++) {
    const startAngle = i * (360 / total);
    const path = describeArc(cx, cy, r, startAngle, startAngle + segLen);
    const el2 = document.createElementNS("http://www.w3.org/2000/svg", "path");
    el2.setAttribute("d", path);
    el2.setAttribute("class", "groove-segment");
    el2.setAttribute("id", `groove-seg-${i}`);
    svg.appendChild(el2);
  }
}

function polarToCartesian(cx, cy, r, angleDeg) {
  const a = (angleDeg * Math.PI) / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}
function describeArc(cx, cy, r, startAngle, endAngle) {
  const start = polarToCartesian(cx, cy, r, startAngle);
  const end = polarToCartesian(cx, cy, r, endAngle);
  const largeArc = endAngle - startAngle <= 180 ? 0 : 1;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y}`;
}

function updateSnippetLabel() {
  const cfg = DIFFICULTY[state.diff];
  const idx = Math.min(state.guessIndex, cfg.snippetsMs.length - 1);
  const ms = cfg.snippetsMs[idx];
  el("snippet-label").textContent = `${(ms / 1000).toFixed(0)}s unlocked`;
}

async function onPlayClick() {
  if (!state.answer || state.finished) return;
  if (state.playing) {
    clearTimeout(state.snippetTimer);
    await state.player.pause();
    setPlayingUi(false);
    return;
  }
  const cfg = DIFFICULTY[state.diff];
  const idx = Math.min(state.guessIndex, cfg.snippetsMs.length - 1);
  playSnippet(state.answer, cfg.snippetsMs[idx]);
}

function normalize(s) {
  return s.toLowerCase().replace(/\(feat[^)]*\)/g, "").replace(/[^a-z0-9]/g, "").trim();
}

function renderDropdown(query) {
  const dd = el("guess-dropdown");
  if (!query) { dd.classList.add("hidden"); dd.innerHTML = ""; return; }
  const q = query.toLowerCase();
  const matches = state.pool
    .filter((t) => !state.guessedTrackIds.includes(t.id))
    .filter((t) => t.name.toLowerCase().includes(q) || t.artists.some((a) => a.name.toLowerCase().includes(q)))
    .slice(0, 8);
  if (!matches.length) { dd.classList.add("hidden"); dd.innerHTML = ""; return; }
  dd.innerHTML = matches
    .map((t) => `<div class="guess-option" data-id="${t.id}"><span>${escapeHtml(t.name)}</span><span class="go-artist">${escapeHtml(t.artists.map((a) => a.name).join(", "))}</span></div>`)
    .join("");
  dd.classList.remove("hidden");
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

let selectedGuess = null;

function submitGuess() {
  if (state.finished) return;
  const input = el("guess-input").value.trim();
  if (!input) return;

  let guessTrack = selectedGuess;
  if (!guessTrack || normalize(`${guessTrack.name} ${guessTrack.artists.map((a) => a.name).join(" ")}`).indexOf(normalize(input)) === -1) {
    guessTrack = state.pool.find((t) => normalize(t.name) === normalize(input)) || null;
  }

  const cfg = DIFFICULTY[state.diff];
  const isCorrect = guessTrack && guessTrack.id === state.answer.id;

  addHistoryRow(guessTrack ? `${guessTrack.name} — ${guessTrack.artists[0].name}` : input, isCorrect ? "correct" : "wrong", isCorrect ? "✓" : "✗");

  if (guessTrack) state.guessedTrackIds.push(guessTrack.id);
  markGrooveSegment(state.guessIndex, isCorrect ? "filled" : "wrong");
  state.guessIndex += 1;

  el("guess-input").value = "";
  selectedGuess = null;
  el("guess-dropdown").classList.add("hidden");

  const blurAmount = Math.max(20 - state.guessIndex * (20 / cfg.guesses), 0);
  el("art").style.filter = `blur(${blurAmount}px) saturate(0.7)`;

  if (isCorrect) {
    endGame(true);
    return;
  }
  if (state.guessIndex >= cfg.guesses) {
    endGame(false);
    return;
  }
  updateSnippetLabel();
}

function skipGuess() {
  if (state.finished) return;
  addHistoryRow("Skipped", "skip", "—");
  state.guessIndex += 1;
  markGrooveSegment(state.guessIndex - 1, "wrong");
  const cfg = DIFFICULTY[state.diff];
  if (state.guessIndex >= cfg.guesses) {
    endGame(false);
    return;
  }
  updateSnippetLabel();
}

function markGrooveSegment(index, cls) {
  const seg = el(`groove-seg-${index}`);
  if (seg) seg.classList.add(cls);
}

function addHistoryRow(text, cls, verdict) {
  const li = document.createElement("li");
  li.className = cls;
  li.innerHTML = `<span class="gh-num">${state.guessIndex + 1}</span><span class="gh-name">${escapeHtml(text)}</span><span class="gh-verdict">${verdict}</span>`;
  el("guess-history").prepend(li);
}

function endGame(won) {
  state.finished = true;
  state.won = won;
  clearTimeout(state.snippetTimer);
  state.player?.pause();
  setPlayingUi(false);
  el("btn-play").disabled = true;
  el("btn-guess").disabled = true;
  el("btn-skip").disabled = true;
  el("art").style.filter = "none";

  recordStats(won);
  showResult(won);
}

function showResult(won) {
  const track = state.answer;
  showScreen("result");
  el("result-art").src = track.album?.images?.[0]?.url || "";
  el("result-status").textContent = won ? "Nailed it" : "So close";
  el("result-title").textContent = track.name;
  el("result-artist").textContent = track.artists.map((a) => a.name).join(", ");
  const cfg = DIFFICULTY[state.diff];
  el("result-summary").textContent = won
    ? `Guessed in ${state.guessIndex} of ${cfg.guesses} tries.`
    : `The answer was hiding in your ${cfg.label.toLowerCase()} top tracks.`;

  const rows = Array.from(el("guess-history").children).reverse();
  const grid = rows.map((li) => (li.classList.contains("correct") ? "🟩" : li.classList.contains("skip") ? "⬛" : "🟥")).join("");
  el("result-grid").textContent = grid;

  el("btn-share")._payload = `Spin (${cfg.label}) ${state.mode === "daily" ? "· Daily" : ""}\n${grid}\n${won ? state.guessIndex : "X"}/${cfg.guesses}`;
}

/* ---------------- stats / streak ---------------- */

function recordStats(won) {
  const played = Number(localStorage.getItem("spin_played") || 0) + 1;
  localStorage.setItem("spin_played", String(played));

  if (state.mode === "daily") {
    const today = new Date().toISOString().slice(0, 10);
    const lastPlayed = localStorage.getItem("spin_last_daily");
    let streak = Number(localStorage.getItem("spin_streak") || 0);
    if (won && lastPlayed !== today) {
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      streak = lastPlayed === yesterday ? streak + 1 : 1;
    } else if (!won) {
      streak = 0;
    }
    localStorage.setItem("spin_streak", String(streak));
    localStorage.setItem("spin_last_daily", today);
  }
  updateSetupStats();
}

function updateSetupStats() {
  el("streak-count").textContent = localStorage.getItem("spin_streak") || 0;
  el("played-count").textContent = localStorage.getItem("spin_played") || 0;
}

/* ---------------- wiring ---------------- */

function selectDifficulty(diff) {
  state.diff = diff;
  document.querySelectorAll(".diff-key").forEach((btn) => {
    btn.setAttribute("aria-selected", String(btn.dataset.diff === diff));
  });
}

function wireEvents() {
  el("btn-login").addEventListener("click", loginWithSpotify);

  document.querySelectorAll(".diff-key").forEach((btn) => {
    btn.addEventListener("click", () => selectDifficulty(btn.dataset.diff));
  });

  el("btn-daily").addEventListener("click", () => startGame("daily"));
  el("btn-random").addEventListener("click", () => startGame("random"));
  el("btn-back").addEventListener("click", () => {
    clearTimeout(state.snippetTimer);
    state.player?.pause();
    setPlayingUi(false);
    showScreen("setup");
  });

  el("btn-play").addEventListener("click", onPlayClick);

  el("guess-input").addEventListener("input", (e) => {
    selectedGuess = null;
    renderDropdown(e.target.value);
  });
  el("guess-dropdown").addEventListener("click", (e) => {
    const opt = e.target.closest(".guess-option");
    if (!opt) return;
    const track = state.pool.find((t) => t.id === opt.dataset.id);
    if (track) {
      selectedGuess = track;
      el("guess-input").value = track.name;
    }
    el("guess-dropdown").classList.add("hidden");
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".guess-input-wrap")) el("guess-dropdown").classList.add("hidden");
  });

  el("guess-form").addEventListener("submit", (e) => {
    e.preventDefault();
    submitGuess();
  });
  el("btn-skip").addEventListener("click", skipGuess);

  el("btn-again").addEventListener("click", () => showScreen("setup"));
  el("btn-play-full").addEventListener("click", async () => {
    if (!state.answer) return;
    await playSnippet(state.answer, state.answer.duration_ms);
  });
  el("btn-share").addEventListener("click", () => {
    const text = el("btn-share")._payload || "";
    navigator.clipboard?.writeText(text).then(() => toast("Copied to clipboard"));
  });
}

/* ---------------- boot ---------------- */

async function boot() {
  wireEvents();

  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  if (code) {
    try {
      await exchangeCodeForToken(code);
    } catch (err) {
      console.error(err);
      toast("Login failed: " + err.message);
    }
    window.history.replaceState({}, document.title, CONFIG.REDIRECT_URI);
  }

  if (isLoggedIn()) {
    try {
      const me = await fetchMe();
      el("user-name").textContent = me.display_name || me.id;
      updateSetupStats();
      showScreen("setup");
    } catch (err) {
      console.error(err);
      logoutClear();
      showScreen("login");
    }
  } else {
    showScreen("login");
  }
}

boot();
