// ===================================================================
//  THOCK
//  capture, analyze, and compare mechanical keyswitches.
//
//  Architecture
//    audio engine   capture-worklet.js → handleBatch() per ~5 ms
//    ring buffer    4 s of raw mono PCM (Float32Array)
//    envelope       per-bucket peak, scrolling, ~3 s on screen
//    segmentation   threshold(noise·4) trigger with auto-learned
//                   tail/gap from calibration; preroll 30 ms
//    samples        WAVs written via FileSystem Access API to the user-
//                   chosen folder. Directory handle persists in IndexedDB.
//    fingerprint    avg of per-sample FFT (Hann, 8192) over the
//                   switch's loudest 170 ms, 1/12-octave smoothed
//    typist         AudioContext-scheduled playback with hot-swap
//                   pool, live envelope sparkline per keystroke
// ===================================================================


// ============== helpers ============================================

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const linToDb = (v) => 20 * Math.log10(Math.max(v, 1e-6));

function sizeCanvas(c) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.floor(c.clientWidth * dpr));
  const h = Math.max(1, Math.floor(c.clientHeight * dpr));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  return dpr;
}

function clearCanvas(id) {
  const c = $(id); const g = c.getContext("2d");
  g.clearRect(0, 0, c.width, c.height);
}


// ============== storage ============================================
//
// Samples live in a user-chosen folder on the user's machine. We use the
// File System Access API to write WAVs and list directories, and we
// stash the FileSystemDirectoryHandle in IndexedDB so it survives across
// sessions. The site itself is purely static — fine to host anywhere
// (Vercel, GitHub Pages, a local static server, anything).
//
// Browser support: Chromium-based browsers (Chrome / Edge / Brave / Arc /
// Opera) and recent Safari. Firefox does not yet expose this API.

const IDB_NAME = "thock";
const IDB_STORE = "kv";

function idbOpen() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
async function idbSet(key, value) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const r = tx.objectStore(IDB_STORE).get(key);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

// Two storage backends — both speak FileSystemDirectoryHandle, so every
// list/save/read/delete below is backend-agnostic.
//
//   picker → window.showDirectoryPicker(): real folder on disk, files
//            visible to other tools. Best when supported.
//   opfs   → navigator.storage.getDirectory(): a private filesystem the
//            browser manages; not visible in the OS but works everywhere.
//
// Brave on NixOS and some other Chromium builds disable showDirectoryPicker,
// so OPFS keeps the app usable without changing any other code.

function pickerSupported() { return typeof window.showDirectoryPicker === "function"; }
function opfsSupported()   { return !!(navigator.storage && navigator.storage.getDirectory); }
function fsSupported()     { return pickerSupported() || opfsSupported(); }

async function pickStorage() {
  if (!pickerSupported()) throw new Error("folder picker unavailable in this browser");
  const handle = await window.showDirectoryPicker({ mode: "readwrite", id: "thock-storage" });
  await idbSet("storageMode", "picker");
  await idbSet("storageHandle", handle);
  state.storageHandle = handle;
  state.storageName = handle.name;
  hideStorageGate();
  setStatus(`storage · ${handle.name}`);
}

async function useOpfsStorage() {
  if (!opfsSupported()) throw new Error("OPFS unavailable in this browser");
  const root = await navigator.storage.getDirectory();
  await idbSet("storageMode", "opfs");
  await idbSet("storageHandle", null);
  state.storageHandle = root;
  state.storageName = "browser storage";
  hideStorageGate();
  setStatus("storage · browser (private)");
}

async function tryResumeStorage() {
  let mode;
  try { mode = await idbGet("storageMode"); } catch (_) { /* ignore */ }

  if (mode === "opfs" && opfsSupported()) {
    try {
      const root = await navigator.storage.getDirectory();
      state.storageHandle = root;
      state.storageName = "browser storage";
      return true;
    } catch (_) { /* fall through */ }
  }

  if (mode === "picker" && pickerSupported()) {
    let handle;
    try { handle = await idbGet("storageHandle"); } catch (_) { /* ignore */ }
    if (handle) {
      const perm = await handle.queryPermission({ mode: "readwrite" });
      if (perm === "granted") {
        state.storageHandle = handle;
        state.storageName = handle.name;
        return true;
      }
      return { needsGesture: true, handle };
    }
  }
  return false;
}

async function requestStoragePermission(handle) {
  const perm = await handle.requestPermission({ mode: "readwrite" });
  if (perm !== "granted") throw new Error("permission denied");
  state.storageHandle = handle;
  state.storageName = handle.name;
  hideStorageGate();
  setStatus(`storage · ${handle.name}`);
}

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

async function fsListSwitches() {
  const root = state.storageHandle;
  if (!root) return [];
  const out = [];
  for await (const [name, entry] of root.entries()) {
    if (entry.kind !== "directory") continue;
    if (!SAFE_NAME.test(name)) continue;
    const samples = [];
    for await (const [fn, fe] of entry.entries()) {
      if (fe.kind === "file" && fn.endsWith(".wav")) samples.push(fn);
    }
    samples.sort();
    out.push({ name, samples, count: samples.length });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function newSampleFilename(prefix) {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
                `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-` +
                `${p(d.getMilliseconds(), 3)}`;
  // Prefix groups samples by phase when sorted alphabetically. Numeric
  // index in front keeps the four guided phases in capture order.
  return (prefix ? prefix + "__" : "") + stamp + ".wav";
}

async function fsSaveSample(switchName, ab, prefix) {
  const root = state.storageHandle;
  if (!root) throw new Error("storage not set up");
  const dir = await root.getDirectoryHandle(switchName, { create: true });
  const fname = newSampleFilename(prefix);
  const fh = await dir.getFileHandle(fname, { create: true });
  const w = await fh.createWritable();
  await w.write(ab);
  await w.close();
  return fname;
}

async function fsReadSample(switchName, file) {
  const root = state.storageHandle;
  const dir = await root.getDirectoryHandle(switchName);
  const fh = await dir.getFileHandle(file);
  const f = await fh.getFile();
  return await f.arrayBuffer();
}

async function fsDeleteSample(switchName, file) {
  const root = state.storageHandle;
  const dir = await root.getDirectoryHandle(switchName);
  await dir.removeEntry(file);
  // if the directory is now empty, drop it too — keeps the folder tidy
  let empty = true;
  for await (const _ of dir.entries()) { empty = false; break; }
  if (empty) await root.removeEntry(switchName);
}

async function fsDeleteSwitch(switchName) {
  const root = state.storageHandle;
  let removed = 0;
  try {
    const dir = await root.getDirectoryHandle(switchName);
    for await (const [fn, fe] of dir.entries()) {
      if (fe.kind === "file") { await dir.removeEntry(fn); removed++; }
    }
  } catch (_) { /* not there is fine */ }
  try { await root.removeEntry(switchName); } catch (_) { /* may be missing */ }
  return removed;
}

function sampleKey(switchName, file) { return `${switchName}::${file}`; }


// ============== state ==============================================

const state = {
  // --- storage ---
  storageHandle: null, storageName: null,

  // --- audio ---
  audioCtx: null, stream: null, workletNode: null, sampleRate: 48000,

  // --- ring buffer ---
  ring: null, ringLen: 0, ringWrite: 0, absIdx: 0,

  // --- live envelope (scrolling) ---
  env: null, envEvents: null, envWrite: 0,
  envAccum: 0, envCount: 0, envBucketSamples: 0,

  // --- levels & noise tracking ---
  // floorEMA tracks the noise floor *in the high-passed signal* — room
  // rumble (HVAC, traffic, fan) is filtered out before we measure, so
  // bass drone can't inflate the trigger threshold and suppress real
  // presses. autoThreshold is then 4× that band-limited floor.
  level: 0,
  floorEMA: 0.005,
  autoThreshold: 0.02,
  hpAlpha: 0,    // 1-pole high-pass coeff, computed once sample rate is known
  hpPrevX: 0,
  hpPrevY: 0,

  // --- segmentation parameters ---
  //
  // The model: each above-threshold burst is one WAVEFRONT (a down-press
  // OR an up-release — both produce a sharp transient). A press CYCLE is
  // a pair of wavefronts separated by the user's dwell time. After a
  // wavefront closes, we buffer it for dwellWindowMs to see if a partner
  // arrives; if so, the pair is saved as one WAV spanning both. If not,
  // the lone wavefront is saved (which is the natural outcome during
  // rolling typing, where releases blur with subsequent presses).
  //
  //   wavefrontTailMs  quiet time required to close a single wavefront.
  //                    Much tighter than the old "press blob" tail — we
  //                    just need to see the transient finish.
  //   dwellWindowMs    how long after a wavefront ends we wait for its
  //                    partner. 250 ms covers all but the most leisurely
  //                    holds; calibrated per switch by guided session.
  //   gapMs            minimum quiet time between consecutive wavefronts
  //                    before the trigger will fire again — small enough
  //                    that a release ~50 ms after a press still gets
  //                    captured as a separate wavefront (and then paired).
  //   prerollMs        pre-trigger audio spliced in so the leading
  //                    transient (which crosses threshold mid-batch) is
  //                    not clipped.
  wavefrontTailMs: 35,
  dwellWindowMs: 350,
  gapMs: 25,
  prerollMs: 50,

  // backing buffer for the pair-coalescer — when set, a wavefront has
  // closed and we are waiting up to dwellWindowMs for its partner.
  pendingWavefront: null,    // { startAbs, endAbs, emittedAtMs }
  pendingFlushTimer: null,

  // --- arm/segmentation runtime (the trigger that writes WAVs as you press) ---
  armed: false,
  armCountdown: 0,
  inEvent: false, eventStartAbs: 0, belowSinceAbs: -1, lastEventEndAbs: -1,
  sessionCount: 0,

  // --- switches & samples ---
  switches: [], currentSwitch: null,
  switchSamples: [], samplesCache: new Map(),
  activeSample: null,
  switchProfiles: new Map(),
  switchColors: new Map(),
  colorPopover: null,
  // calibrated dwell-window (ms) per switch, learned from guided session
  // slow phases. Falls back to state.dwellWindowMs when unset. Persisted
  // in localStorage so a switch keeps its calibration across sessions.
  switchDwells: new Map(),
  // per-switch keypress template learned from the guided session —
  // counts + median metrics for DOWN and UP wavefronts + dwell medians.
  // Persisted in localStorage so the switch's "identity" survives across
  // sessions and a returning user sees it without re-running guided.
  switchTemplates: new Map(),

  // --- typist ---
  typingActive: false, typingStop: null, typingSwitch: null,
  typingPulses: [],
  typedChars: [],
  // recent sample indices — keeps the same WAV from repeating back to
  // back, which is the most obvious "fake" tell when listening
  typingRecentIdx: [],

  // --- calibration ---
  calibrating: null,

  // --- guided recording session ---
  //   null when off. When active: { phaseIdx, capturedInPhase, totals }
  //   The four-phase structure (5 light-slow, 5 hard-slow, 3 light-fast,
  //   3 hard-fast) gives 16 labeled samples spanning velocity × tempo —
  //   enough to derive an honest "average keypress" shape without the
  //   guesswork of free-form capture, and labeled so the fingerprint can
  //   later weight or filter by intent.
  guided: null,

  // --- fingerprint settings (persisted; defaults read on first load) ---
  fft: { window: "flat-top", scale: "linear" },
};

function loadFftSettings() {
  try {
    const raw = localStorage.getItem("thock.fft");
    if (raw) Object.assign(state.fft, JSON.parse(raw));
  } catch (_) { /* ignore */ }
}
function saveFftSettings() {
  try { localStorage.setItem("thock.fft", JSON.stringify(state.fft)); }
  catch (_) { /* ignore */ }
}

// palette tuned for dark backgrounds; distinguishable for typical
// red-green colourblindness via differing lightness as well as hue.
const COLOR_PALETTE = [
  "#f5a623", // amber  (default accent)
  "#ff6b6b", // coral
  "#5ba8ff", // sky
  "#7dd87d", // mint
  "#b18cff", // violet
  "#2dd4bf", // teal
  "#ec4899", // pink
  "#d4e642", // lime
  "#e8e6e0", // ivory
];

function colorForSwitch(name) {
  if (state.switchColors.has(name)) return state.switchColors.get(name);
  let h = 0;
  for (let i = 0; i < name.length; i++) h = ((h * 31) + name.charCodeAt(i)) | 0;
  return COLOR_PALETTE[Math.abs(h) % COLOR_PALETTE.length];
}

function setSwitchColor(name, color) {
  state.switchColors.set(name, color);
  try {
    localStorage.setItem("thock.colors", JSON.stringify([...state.switchColors]));
  } catch (_) { /* private mode etc */ }
  renderSwitchRow();
  updateTypingButtons();
  if (state.currentSwitch === name) {
    drawFingerprint(state.switchProfiles.get(name) || null);
  }
}

function loadSwitchColors() {
  try {
    const raw = localStorage.getItem("thock.colors");
    if (raw) state.switchColors = new Map(JSON.parse(raw));
  } catch (_) { /* malformed → start fresh */ }
}

function setSwitchDwell(name, ms) {
  state.switchDwells.set(name, ms);
  try {
    localStorage.setItem("thock.dwells", JSON.stringify([...state.switchDwells]));
  } catch (_) { /* private mode etc */ }
}

function loadSwitchDwells() {
  try {
    const raw = localStorage.getItem("thock.dwells");
    if (!raw) return;
    state.switchDwells = new Map(JSON.parse(raw));
    // Migration: an earlier calibration formula measured the silent
    // gap (release.startAbs - press.endAbs) which biased dwells
    // ~50–90 ms low and pinned them at the old 80 ms clamp floor.
    // Bring any value below 200 up to the current default so existing
    // switches recover without forcing the user to re-calibrate.
    let migrated = false;
    for (const [k, v] of state.switchDwells) {
      if (v < 200) { state.switchDwells.set(k, 200); migrated = true; }
    }
    if (migrated) {
      localStorage.setItem("thock.dwells", JSON.stringify([...state.switchDwells]));
    }
  } catch (_) { /* malformed → start fresh */ }
}

function setSwitchTemplate(name, tpl) {
  state.switchTemplates.set(name, tpl);
  try {
    localStorage.setItem("thock.templates", JSON.stringify([...state.switchTemplates]));
  } catch (_) { /* private mode etc */ }
}

function loadSwitchTemplates() {
  try {
    const raw = localStorage.getItem("thock.templates");
    if (raw) state.switchTemplates = new Map(JSON.parse(raw));
  } catch (_) { /* malformed → start fresh */ }
}

function withAlpha(hex, alpha) {
  // accepts #rrggbb
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}


// ============== constants ==========================================

const ENV_PIXELS         = 800;
const ENV_SECONDS        = 3;
const ONSET_AT           = 0.15;
const PRE_MARGIN_MS      = 8;
const POST_MARGIN_MS     = 15;
const MIN_WINDOW_MS      = 60;
const FFT_N              = 8192;
const VIZ_WINDOW_MS      = 5000;
const VIZ_PULSE_SPAN_PX  = 30;

// Instrument palette — seeded with the dark defaults, then overwritten
// from the CSS custom properties at boot and on every theme toggle, so
// the canvases track the same light/dark tokens as the page chrome.
let COL_BG       = "#0a0a0c";
let COL_BG2      = "#0d0d11";   // recessed screen ground (fingerprint, label backdrops)
let COL_GRID     = "#1a1a22";
let COL_GRID_2   = "#22222c";
let COL_INK      = "#e8e6e0";
let COL_INK_DIM  = "#94929e";
let COL_INK_MUTE = "#54545e";
let COL_ACCENT   = "#f5a623";

// Read the live values of the chrome tokens off :root. getComputedStyle
// returns custom properties as authored (#rrggbb), which withAlpha() parses.
function syncPalette() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => {
    const x = cs.getPropertyValue(name).trim();
    return /^#[0-9a-fA-F]{6}$/.test(x) ? x : fallback;
  };
  COL_BG       = v("--bg", COL_BG);
  COL_BG2      = v("--bg-2", COL_BG2);
  COL_GRID     = v("--line", COL_GRID);
  COL_GRID_2   = v("--line-2", COL_GRID_2);
  COL_INK      = v("--ink", COL_INK);
  COL_INK_DIM  = v("--ink-dim", COL_INK_DIM);
  COL_INK_MUTE = v("--ink-mute", COL_INK_MUTE);
  COL_ACCENT   = v("--accent", COL_ACCENT);
}

// Re-sync the palette and repaint the static canvases. The scope and
// typist canvases redraw every animation frame, so they pick up the new
// colours on their own; only the on-demand views need an explicit nudge.
function redrawTheme() {
  syncPalette();
  if (state.currentSwitch) {
    drawFingerprint(state.switchProfiles.get(state.currentSwitch) || null);
  } else {
    drawFingerprint(null);
  }
  if (state.activeSample && state.activeSample.meta) {
    drawDetailWave(state.activeSample);
    drawDetailFFT(state.activeSample);
    drawDetailSpectrogram(state.activeSample);
  }
  renderTiles();
}
window.thockApplyTheme = redrawTheme;


// ============== audio engine =======================================

async function ensureAudioCtx() {
  if (state.audioCtx) return state.audioCtx;
  const ctx = new (window.AudioContext || window.webkitAudioContext)({
    latencyHint: "interactive",
  });
  state.audioCtx = ctx;
  state.sampleRate = ctx.sampleRate;
  return ctx;
}

async function enableMic() {
  if (state.stream) return;
  setStatus("requesting microphone…");
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
  } catch (e) {
    setStatus("microphone denied");
    throw e;
  }
  const ctx = await ensureAudioCtx();
  if (ctx.state === "suspended") await ctx.resume();
  state.stream = stream;
  state.sampleRate = ctx.sampleRate;
  // 1-pole high-pass at ~200 Hz. Removes room rumble / HVAC / traffic
  // drone from the signal we use to estimate the noise floor and to
  // trigger. y[n] = α (y[n-1] + x[n] - x[n-1]),  α = exp(-2π·fc/sr).
  state.hpAlpha = Math.exp(-2 * Math.PI * 200 / ctx.sampleRate);
  state.hpPrevX = 0;
  state.hpPrevY = 0;

  await ctx.audioWorklet.addModule("/capture-worklet.js");

  state.ring = new Float32Array(Math.floor(ctx.sampleRate * 4));
  state.ringLen = state.ring.length;
  state.ringWrite = 0;
  state.absIdx = 0;

  state.env = new Float32Array(ENV_PIXELS);
  state.envEvents = new Int8Array(ENV_PIXELS);
  state.envWrite = 0;
  state.envAccum = 0;
  state.envCount = 0;
  state.envBucketSamples = Math.max(
    1, Math.floor((ENV_SECONDS * ctx.sampleRate) / ENV_PIXELS)
  );

  const node = new AudioWorkletNode(ctx, "capture", {
    numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1,
  });
  node.port.onmessage = (e) => handleBatch(e.data);
  state.workletNode = node;
  ctx.createMediaStreamSource(stream).connect(node);

  setStatus(`mic on · ${ctx.sampleRate} Hz`);
  $("capture-status").textContent = "disarmed";
  refreshPrimary();
  if (state.currentSwitch) await loadSwitchSamples(state.currentSwitch);
}

// Audio render thread → main thread. Hot path: ring copy, envelope
// bucket peak, high-passed envelope, sample-level trigger.
//
// Two envelopes are tracked. The raw envelope (batchPeak) drives the
// on-screen scope and the level meter — that's what the eye expects to
// see. The high-passed envelope (hpBatchPeak) drives the noise-floor
// EMA, the trigger, and the tail-close gate. Filtering out content
// below ~200 Hz before we measure "is the room noisy?" or "is this
// loud enough to be a press?" means HVAC drone and traffic rumble
// can't inflate the threshold and can't be mistaken for a press —
// they sit far below the floor in the band where keyswitch transients
// actually live.
function handleBatch(inp) {
  const ring = state.ring;
  if (!ring) return;
  const L = state.ringLen;
  const sr = state.sampleRate;
  let w = state.ringWrite;
  let envWrite = state.envWrite;
  let envAccum = state.envAccum;
  let envCount = state.envCount;
  const env = state.env;
  const events = state.envEvents;
  const bucketSize = state.envBucketSamples;
  const wasInEvent = state.inEvent;

  const hpAlpha = state.hpAlpha || 0.974;  // safe default if rate unknown
  let hpPrevX = state.hpPrevX;
  let hpPrevY = state.hpPrevY;

  let batchPeak = 0;
  let hpBatchPeak = 0;
  for (let i = 0; i < inp.length; i++) {
    const s = inp[i];
    ring[w] = s;
    w++; if (w >= L) w = 0;
    const a = s < 0 ? -s : s;
    if (a > envAccum) envAccum = a;
    if (a > batchPeak) batchPeak = a;

    // 1-pole HP: y[n] = α (y[n-1] + x[n] - x[n-1])
    const hp = hpAlpha * (hpPrevY + s - hpPrevX);
    hpPrevX = s; hpPrevY = hp;
    const ha = hp < 0 ? -hp : hp;
    if (ha > hpBatchPeak) hpBatchPeak = ha;

    envCount++;
    if (envCount >= bucketSize) {
      env[envWrite] = envAccum;
      events[envWrite] = wasInEvent ? 1 : 0;
      envWrite = (envWrite + 1) % env.length;
      envAccum = 0;
      envCount = 0;
    }
  }
  state.ringWrite = w;
  state.envWrite = envWrite;
  state.envAccum = envAccum;
  state.envCount = envCount;
  state.hpPrevX = hpPrevX;
  state.hpPrevY = hpPrevY;
  state.level = state.level * 0.65 + batchPeak * 0.35;

  // noise floor: slow EMA of high-passed peak while not in a press.
  if (!state.inEvent) {
    state.floorEMA = state.floorEMA * 0.99 + hpBatchPeak * 0.01;
  }
  state.autoThreshold = clamp(state.floorEMA * 4, 0.008, 0.5);

  const blockStartAbs = state.absIdx;
  state.absIdx += inp.length;
  const blockEndAbs = state.absIdx;

  if (!state.armed) return;

  // Wavefront segmentation. Each above-threshold burst becomes ONE
  // wavefront (could be a down or an up). Trigger opens on hpBatchPeak >
  // 4× HP-floor, honoring `gapMs` since the last wavefront closed. The
  // wavefront closes after `wavefrontTailMs` (~35 ms) of hpBatchPeak
  // below half the trigger — just enough to see the transient finish.
  // Pairing into press cycles happens downstream in emitWavefront.
  const thr = state.autoThreshold;
  const tailThr = thr * 0.5;
  const gapSamp = Math.floor((state.gapMs / 1000) * sr);
  const tailSamp = Math.floor((state.wavefrontTailMs / 1000) * sr);
  const prerollSamp = Math.floor((state.prerollMs / 1000) * sr);

  if (!state.inEvent) {
    if (hpBatchPeak > thr &&
        (state.lastEventEndAbs < 0 ||
         blockStartAbs - state.lastEventEndAbs > gapSamp)) {
      state.inEvent = true;
      state.eventStartAbs = Math.max(0, blockStartAbs - prerollSamp);
      state.belowSinceAbs = -1;
    }
  } else {
    if (hpBatchPeak > tailThr) {
      state.belowSinceAbs = -1;
    } else {
      if (state.belowSinceAbs < 0) state.belowSinceAbs = blockStartAbs;
      if (blockEndAbs - state.belowSinceAbs >= tailSamp) {
        const startA = state.eventStartAbs;
        const endA   = state.belowSinceAbs + tailSamp;
        state.inEvent = false;
        state.lastEventEndAbs = endA;
        emitWavefront(startA, endA);
      }
    }
  }
}

function readRingRange(startAbs, endAbs) {
  const L = state.ringLen;
  const ring = state.ring;
  const w = state.ringWrite;
  const absIdx = state.absIdx;
  if (absIdx - startAbs > L) startAbs = absIdx - L;
  const length = Math.max(0, endAbs - startAbs);
  const out = new Float32Array(length);
  let rIdx = (w - (absIdx - startAbs)) % L;
  if (rIdx < 0) rIdx += L;
  for (let i = 0; i < length; i++) {
    out[i] = ring[rIdx];
    rIdx++; if (rIdx >= L) rIdx = 0;
  }
  return out;
}


// ============== segmentation: save event as WAV ====================

// 32-bit IEEE float WAV (format code 3). Chosen over 16-bit PCM because
// the quiet end of the housing ring-out sits well below the −90 dB floor
// where Int16 quantizes to zero — keeping the tail intact matters for a
// faithful fingerprint. Modern browsers, Audacity, sox, ffmpeg, and most
// DAWs read this format directly. Mono, 1 channel.
function encodeWav(float32, sampleRate) {
  const n = float32.length;
  const dataSize = n * 4;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const writeStr = (p, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(p + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);            // fmt chunk size
  view.setUint16(20, 3, true);             // format code 3 = IEEE float
  view.setUint16(22, 1, true);             // channels
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true); // byteRate
  view.setUint16(32, 4, true);             // blockAlign
  view.setUint16(34, 32, true);            // bitsPerSample
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);
  let p = 44;
  for (let i = 0; i < n; i++) {
    view.setFloat32(p, float32[i], true);
    p += 4;
  }
  return buf;
}


// ============== arm / disarm ======================================
//
// The capture model: once armed, every above-threshold burst becomes
// one wavefront. Two wavefronts within `dwellWindowMs` get coalesced
// into one press-cycle WAV (down + dwell + up). A wavefront left
// alone past the dwell window is saved as a lone wavefront — that's
// what happens during rolling typing, where releases overlap with
// the next press. See emitWavefront for the full pair-coalescer.

async function arm() {
  if (!state.audioCtx || !state.stream) { alert("enable the mic first"); return; }
  if (!state.currentSwitch) { alert("create or select a switch first"); return; }
  if (!state.storageHandle) {
    showStorageGate(state.storageName);
    return;
  }
  state.armed = true;
  state.sessionCount = 0;
  state.inEvent = false;
  state.belowSinceAbs = -1;
  state.lastEventEndAbs = -1;
  $("session-count").textContent = "0";
  refreshPrimary();
  $("capture-status").classList.add("armed");

  // Guided mode manages its own per-phase countdown via state.guided —
  // don't run a second one here.
  if (state.guided) {
    state.armCountdown = 0;
    $("capture-status").textContent = "armed";
    setStatus(`armed · ${state.currentSwitch}`);
    return;
  }

  // Free-form arm: 3-2-1 countdown so the click that hit "▶ start"
  // can't be wavefront #1.
  state.armCountdown = 3;
  $("capture-status").textContent = `ready in ${state.armCountdown}…`;
  setStatus(`ready in ${state.armCountdown}…`);
  const tick = () => {
    if (!state.armed) return;
    state.armCountdown--;
    if (state.armCountdown > 0) {
      $("capture-status").textContent = `ready in ${state.armCountdown}…`;
      setStatus(`ready in ${state.armCountdown}…`);
      setTimeout(tick, 1000);
    } else {
      state.armCountdown = 0;
      _clearPendingFlush();
      $("capture-status").textContent = "armed";
      setStatus(`armed · ${state.currentSwitch}`);
    }
  };
  setTimeout(tick, 1000);
}

function disarm() {
  if (!state.armed) return;
  state.armed = false;
  state.inEvent = false;
  // any wavefront still buffered for pairing gets saved alone now —
  // don't leave a press cycle floating in memory.
  flushPendingWavefront();
  refreshPrimary();
  $("capture-status").textContent = "ready";
  $("capture-status").classList.remove("armed");
  setStatus(`saved ${state.sessionCount} sample${state.sessionCount === 1 ? "" : "s"}`);
}


// ============== guided recording ===================================
//
// A structured capture session that walks the user through four phases
// of presses (light-slow, hard-slow, light-fast, hard-fast). Each phase
// has a target count; samples land on disk prefixed with the phase id so
// they cluster by phase when sorted. The system trusts that audio events
// inside a phase's listening window are presses (skipping the non-unit
// rejection), and shows live "X of N" feedback so the user can see
// captures happening as they go.

// Each phase asks the user to repeat a press cycle `cycles` times. Each
// cycle produces wavefronts; `captures` maps wavefront-position-in-cycle
// to a role label (or null = discard). The labels become the saved
// filename prefix, so DOWN and UP samples are cleanly separated on disk
// for later averaging into per-role spectra.
//
// Phases 1-2 isolate DOWN and UP individually (one role kept per cycle).
// Phases 3-4 capture both wavefronts with known dwell times — long-hold
// gives us a clean dwell baseline, natural-speed gives us the typing
// dwell. Together they teach the system "what one keypress on this
// switch looks like, and how that varies with speed."
const GUIDED_PHASES = [
  {
    id: "down-iso",
    label: "isolated DOWN",
    hint: "press the key and HOLD a beat, then release. you'll do this 3 times — we only listen for the press.",
    cycles: 3,
    captures: ["down-iso", null],
  },
  {
    id: "up-iso",
    label: "isolated UP",
    hint: "press, HOLD for about a second, then RELEASE. 3 times — we only listen for the release.",
    cycles: 3,
    captures: [null, "up-iso"],
  },
  {
    id: "long-hold",
    label: "1-second holds",
    hint: "press, hold for about 1 second, release. 3 cycles — we capture both press and release.",
    cycles: 3,
    captures: ["down-1s", "up-1s"],
  },
  {
    id: "natural",
    label: "natural typing speed",
    hint: "type at a comfortable speed. 5 presses — both wavefronts of each.",
    cycles: 5,
    captures: ["down-nat", "up-nat"],
  },
];

async function startGuided() {
  if (state.guided) return;
  if (!state.audioCtx || !state.stream) {
    try { await enableMic(); }
    catch (e) { setStatus("mic error: " + e.message); return; }
  }
  if (!state.currentSwitch) {
    alert("create or select a switch first");
    return;
  }
  if (!state.storageHandle) {
    showStorageGate(state.storageName);
    return;
  }
  state.guided = {
    phaseIdx: 0,
    // cycle progression within the current phase
    cyclesInPhase: 0,
    wavefrontInCycle: 0,
    cycleCooldownUntil: 0,
    totalCaptured: 0,
    // per-wavefront observations across the whole session — fed by the
    // guided handler. Each entry: { phase, label, peak, attackMs,
    // durationMs }. The dwell sweep also accumulates inter-wavefront
    // gaps in observedDwells for calibration.
    observations: [],
    observedDwells: [],
    // listening = false during the per-phase ready countdown so the
    // mouseclick that started the session (and the hand-to-keyboard
    // movement) doesn't get recorded as wavefront #1.
    listening: false,
    countdown: 0,
  };
  // hide any "learned" insight from a previous session
  const learnedEl = $("guided-learned");
  if (learnedEl) { learnedEl.classList.add("hidden"); learnedEl.innerHTML = ""; }
  $("guided-modal").classList.remove("hidden");
  updateGuidedUI();
  // arm() handles inEvent / belowSince / lastEventEnd resets so events
  // captured before guided mode don't leak into the new session.
  if (!state.armed) await arm();
  beginPhaseCountdown();
}

function beginPhaseCountdown() {
  if (!state.guided) return;
  state.guided.listening = false;
  state.guided.countdown = 3;
  setStageCountdown(3);
  updateGuidedUI();
  const tick = () => {
    if (!state.guided) return;
    state.guided.countdown--;
    if (state.guided.countdown > 0) {
      setStageCountdown(state.guided.countdown);
      updateGuidedUI();
      setTimeout(tick, 1000);
    } else {
      _clearPendingFlush();
      state.guided.listening = true;
      const phase = GUIDED_PHASES[state.guided.phaseIdx];
      setStageForSlot(phase, 0);
      updateGuidedUI();
      setStatus(`guided · ${phase.label}`);
    }
  };
  setTimeout(tick, 1000);
}

// ----- visual stage helpers ----------------------------------------
//
// The big action panel inside the guided modal. setStageForSlot picks
// the icon + label + color based on what the user should do RIGHT NOW
// for the current phase × slot-in-cycle. setStageCaptured flashes a
// green checkmark; setStageCooldown shows a quiet "wait" between
// cycles; setStageCountdown shows the 3-2-1 ready beat.

function setStageForSlot(phase, slotIdx) {
  const el = $("guided-stage");
  const icon = $("guided-stage-icon");
  const lbl = $("guided-stage-label");
  const sub = $("guided-stage-sub");
  if (!el) return;
  if (phase.id === "down-iso" && slotIdx === 0) {
    el.dataset.step = "press"; icon.textContent = "▼";
    lbl.textContent = "PRESS"; sub.textContent = "we only listen for the press";
  } else if (phase.id === "down-iso" && slotIdx === 1) {
    el.dataset.step = "ready"; icon.textContent = "·";
    lbl.textContent = "release whenever"; sub.textContent = "we'll ignore the release sound";
  } else if (phase.id === "up-iso" && slotIdx === 0) {
    el.dataset.step = "hold"; icon.textContent = "▼";
    lbl.textContent = "PRESS & HOLD"; sub.textContent = "we're waiting for the release";
  } else if (phase.id === "up-iso" && slotIdx === 1) {
    el.dataset.step = "release"; icon.textContent = "▲";
    lbl.textContent = "RELEASE NOW"; sub.textContent = "the release is what we want";
  } else if (phase.id === "long-hold" && slotIdx === 0) {
    el.dataset.step = "press"; icon.textContent = "▼";
    lbl.textContent = "PRESS & HOLD"; sub.textContent = "hold for about 1 second";
  } else if (phase.id === "long-hold" && slotIdx === 1) {
    el.dataset.step = "release"; icon.textContent = "▲";
    lbl.textContent = "RELEASE"; sub.textContent = "";
  } else if (phase.id === "natural" && slotIdx === 0) {
    el.dataset.step = "press"; icon.textContent = "▼";
    lbl.textContent = "PRESS"; sub.textContent = "";
  } else if (phase.id === "natural" && slotIdx === 1) {
    el.dataset.step = "release"; icon.textContent = "▲";
    lbl.textContent = "RELEASE"; sub.textContent = "";
  } else {
    el.dataset.step = "ready"; icon.textContent = "⋯";
    lbl.textContent = "…"; sub.textContent = "";
  }
}

function setStageCaptured() {
  const el = $("guided-stage");
  if (!el) return;
  el.dataset.step = "got";
  $("guided-stage-icon").textContent = "✓";
  $("guided-stage-label").textContent = "GOT IT";
  $("guided-stage-sub").textContent = "";
}

function setStageCooldown() {
  const el = $("guided-stage");
  if (!el) return;
  el.dataset.step = "ready";
  $("guided-stage-icon").textContent = "⋯";
  $("guided-stage-label").textContent = "WAIT…";
  $("guided-stage-sub").textContent = "";
}

function setStageCountdown(n) {
  const el = $("guided-stage");
  if (!el) return;
  el.dataset.step = "ready";
  $("guided-stage-icon").textContent = String(n);
  $("guided-stage-label").textContent = "GET READY";
  $("guided-stage-sub").textContent = "";
}

function advanceGuidedPhase() {
  if (!state.guided) return;
  // Surface what we just learned from the phase we're leaving so the
  // user sees the system's understanding grow as they go.
  displayLearnedSoFar();
  state.guided.phaseIdx++;
  state.guided.cyclesInPhase = 0;
  state.guided.wavefrontInCycle = 0;
  state.guided.cycleCooldownUntil = 0;
  state.guided.lastPressStartAbs = null;
  if (state.guided.phaseIdx >= GUIDED_PHASES.length) {
    finishGuided(false);
    return;
  }
  updateGuidedUI();
  beginPhaseCountdown();
}

// Render the cumulative learning insight into the popup. Called between
// phases so the user watches the template build up: after phase 1 you
// see DOWN's metrics; after phase 2, UP is added; after the paired
// phases, dwell measurements appear.
function displayLearnedSoFar() {
  const el = $("guided-learned");
  if (!el || !state.guided) return;
  const obs = state.guided.observations;
  const lines = [];

  const downObs = obs.filter((o) => o.label.startsWith("down-"));
  if (downObs.length) lines.push(formatRoleLine("DOWN", downObs));

  const upObs = obs.filter((o) => o.label.startsWith("up-"));
  if (upObs.length) lines.push(formatRoleLine("UP", upObs));

  const longDwells = state.guided.observedDwells
    .filter((d) => d.phase === "long-hold").map((d) => d.gapMs);
  const natDwells = state.guided.observedDwells
    .filter((d) => d.phase === "natural").map((d) => d.gapMs);
  if (longDwells.length) {
    longDwells.sort((a, b) => a - b);
    lines.push(`hold dwell ~<strong>${Math.round(longDwells[Math.floor(longDwells.length / 2)])} ms</strong>`);
  }
  if (natDwells.length) {
    natDwells.sort((a, b) => a - b);
    lines.push(`natural dwell ~<strong>${Math.round(natDwells[Math.floor(natDwells.length / 2)])} ms</strong>`);
  }

  if (!lines.length) {
    el.classList.add("hidden");
    el.innerHTML = "";
  } else {
    el.innerHTML = lines.join("<br>");
    el.classList.remove("hidden");
  }
}

function formatRoleLine(label, obs) {
  const peaks = obs.map((o) => o.peak).sort((a, b) => a - b);
  const attacks = obs.map((o) => o.attackMs).sort((a, b) => a - b);
  const mp = peaks[Math.floor(peaks.length / 2)];
  const ma = attacks[Math.floor(attacks.length / 2)];
  return `<strong>${label}</strong> · ${obs.length} sample${obs.length === 1 ? "" : "s"} · peak ${mp.toFixed(2)} · attack ${ma.toFixed(0)} ms`;
}

function skipGuidedPhase() {
  if (!state.guided) return;
  advanceGuidedPhase();
}

function cancelGuided() {
  if (!state.guided) return;
  finishGuided(true);
}

async function finishGuided(cancelled) {
  const g = state.guided;
  const total = g ? g.totalCaptured : 0;
  const sw = state.currentSwitch;
  let calibratedMsg = "";

  if (g && !cancelled && sw) {
    // Dwell calibration from the natural-speed phase — that's the dwell
    // we want the pair coalescer to use in free-form capture. Median +
    // 50 ms safety margin, clamped to a sane keyboard range.
    const naturalGaps = g.observedDwells
      .filter((d) => d.phase === "natural")
      .map((d) => d.gapMs)
      .sort((a, b) => a - b);
    if (naturalGaps.length >= 2) {
      const median = naturalGaps[Math.floor(naturalGaps.length / 2)];
      const calibrated = clamp(Math.round((median + 50) / 10) * 10, 200, 500);
      setSwitchDwell(sw, calibrated);
      calibratedMsg = ` · dwell ${calibrated} ms`;
    }

    // Build the full template — counts, median metrics per role, and
    // top spectral resonances of the average DOWN / UP spectrum. Stored
    // in localStorage as the switch's persistent identity. We need the
    // saved samples loaded into samplesCache first, so wait for the
    // most recent loadSwitchSamples to complete.
    try { await loadSwitchSamples(sw); } catch (_) { /* best-effort */ }

    const downObs = g.observations.filter((o) => o.label.startsWith("down-"));
    const upObs   = g.observations.filter((o) => o.label.startsWith("up-"));
    const downProfile = computeRoleProfile(sw, "down");
    const upProfile   = computeRoleProfile(sw, "up");
    const longDwells  = g.observedDwells.filter((d) => d.phase === "long-hold").map((d) => d.gapMs).sort((a, b) => a - b);
    const natDwells   = g.observedDwells.filter((d) => d.phase === "natural").map((d) => d.gapMs).sort((a, b) => a - b);

    const tpl = {
      down: rolledUp(downObs, downProfile),
      up:   rolledUp(upObs,   upProfile),
      longDwellMs: longDwells.length ? Math.round(longDwells[Math.floor(longDwells.length / 2)]) : null,
      naturalDwellMs: natDwells.length ? Math.round(natDwells[Math.floor(natDwells.length / 2)]) : null,
      learnedAt: Date.now(),
    };
    if (tpl.down || tpl.up) setSwitchTemplate(sw, tpl);
  }

  state.guided = null;
  $("guided-modal").classList.add("hidden");
  if (state.armed) disarm();
  // template may have just been written — flip primary button to "▶ start"
  refreshPrimary();
  if (cancelled) {
    setStatus(`guided cancelled · ${total} sample${total === 1 ? "" : "s"} kept`);
  } else {
    setStatus(`guided complete · ${total} samples${calibratedMsg}`);
    if (sw === state.currentSwitch) loadSwitchSamples(sw).catch(() => {});
  }
}

// Roll an array of observations + an averaged profile into the per-role
// summary stored on the switch template. Keeps only what we'd want to
// see at a glance later — counts, medians, top resonant frequencies.
function rolledUp(obs, profile) {
  if (!obs.length) return null;
  const peaks = obs.map((o) => o.peak).sort((a, b) => a - b);
  const attacks = obs.map((o) => o.attackMs).sort((a, b) => a - b);
  return {
    count: obs.length,
    medianPeak: peaks[Math.floor(peaks.length / 2)],
    medianAttackMs: attacks[Math.floor(attacks.length / 2)],
    topResonancesHz: profile && profile.peaks
      ? profile.peaks.slice(0, 3).map((p) => Math.round(p.freq))
      : null,
  };
}

function updateGuidedUI() {
  if (!state.guided) return;
  const idx = state.guided.phaseIdx;
  const phase = GUIDED_PHASES[idx];
  if (!phase) return;
  $("guided-card-switch").textContent = state.currentSwitch || "—";
  $("guided-phase-num").textContent =
    `phase ${idx + 1} of ${GUIDED_PHASES.length}`;
  $("guided-label").textContent = phase.label;
  $("guided-hint").textContent = phase.hint;
  if (state.guided.countdown > 0) {
    $("guided-counter").textContent = String(state.guided.countdown);
    $("guided-status").textContent = "ready…";
  } else {
    const got = state.guided.cyclesInPhase;
    const need = phase.cycles;
    const dots = "●".repeat(got) + "○".repeat(Math.max(0, need - got));
    $("guided-counter").textContent = dots;
    $("guided-status").textContent =
      `${got} of ${need} cycle${need === 1 ? "" : "s"}`;
  }
}

// ============== wavefront pair-coalescer ===========================
//
// handleBatch hands each wavefront to emitWavefront once it closes
// (~35 ms after the transient finishes). Per-wavefront non-unit
// rejection happens here so a chair-creak can't accidentally pair
// with a real press wavefront. If the wavefront looks press-like,
// we either:
//
//   (a) pair it with state.pendingWavefront and save the combined
//       press cycle from pending.startAbs → this.endAbs, OR
//   (b) flush the pending wavefront alone (gap too big to pair) and
//       buffer this one as the new pending, OR
//   (c) buffer this one if nothing was pending.
//
// A timer ensures any wavefront left buffered past dwellWindowMs is
// flushed as a lone wavefront — that's the natural outcome during
// rolling typing, where each release blurs with the next press.

function dwellWindowForCurrent() {
  // Switch-specific calibrated dwell takes priority over the global
  // default — once a switch's slow phase has taught us its natural
  // press cycle length, the coalescer uses that.
  const cal = state.currentSwitch && state.switchDwells.get(state.currentSwitch);
  return cal || state.dwellWindowMs;
}

function emitWavefront(startAbs, endAbs) {
  if (!state.currentSwitch || !state.storageHandle) return;
  // During a guided phase's "ready" countdown, ignore everything — the
  // mouseclick that started the session shouldn't get recorded.
  if (state.guided && !state.guided.listening) return;
  // Same for the free-form arm 3-2-1 countdown.
  if (!state.guided && state.armCountdown > 0) return;
  const sr = state.sampleRate;
  if (endAbs - startAbs < sr * 0.012) return;  // <12 ms = debounce

  // Compute wavefront metrics from the ring buffer slice.
  const pcm = readRingRange(startAbs, endAbs);
  let peak = 0, peakIdx = 0, sumSq = 0;
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i] < 0 ? -pcm[i] : pcm[i];
    if (v > peak) { peak = v; peakIdx = i; }
    sumSq += pcm[i] * pcm[i];
  }
  const rms = Math.sqrt(sumSq / pcm.length);
  const crest = peak / Math.max(rms, 1e-9);
  const onsetThr = peak * 0.20;
  let onsetIdx = 0;
  for (let i = 0; i < pcm.length; i++) {
    if ((pcm[i] < 0 ? -pcm[i] : pcm[i]) >= onsetThr) { onsetIdx = i; break; }
  }
  const attackMs = ((peakIdx - onsetIdx) / sr) * 1000;
  const durationMs = ((endAbs - startAbs) / sr) * 1000;

  // Guided sessions get a dedicated handler — each wavefront is saved
  // immediately with its role label baked into the filename; the pair
  // coalescer is bypassed so labels stay clean.
  if (state.guided) {
    handleGuidedWavefront(startAbs, endAbs, peak, attackMs, durationMs);
    return;
  }

  // Free-form capture: non-unit rejection then pair coalescing.
  const rejectReason =
    (attackMs > 25)              ? `slow attack (${attackMs.toFixed(0)} ms)` :
    (crest < 2.2 && peak < 0.15) ? `low crest (${crest.toFixed(1)})` :
    null;
  if (rejectReason) {
    setStatus(`wavefront rejected — ${rejectReason}`);
    return;
  }

  const dwellWindow = dwellWindowForCurrent();
  if (state.pendingWavefront) {
    // Cycle length measured start-to-start. The endAbs of the pending
    // wavefront already includes the 35 ms wavefront-tail, so using
    // pendingW.endAbs would understate the actual press-to-release
    // cycle by ~50–90 ms — and that's the bug that was producing
    // single-wavefront WAVs even when paired captures were intended.
    const cycleSamples = startAbs - state.pendingWavefront.startAbs;
    const cycleMs = (cycleSamples / sr) * 1000;
    if (cycleMs <= dwellWindow) {
      const pendingW = state.pendingWavefront;
      _clearPendingFlush();
      saveCycle(pendingW.startAbs, endAbs, "pair");
      return;
    }
    flushPendingWavefront();
  }
  state.pendingWavefront = {
    startAbs, endAbs, peak, attackMs, durationMs,
  };
  state.pendingFlushTimer = setTimeout(
    flushPendingWavefront, dwellWindow + 30
  );
}

function flushPendingWavefront() {
  const p = state.pendingWavefront;
  _clearPendingFlush();
  if (!p) return;
  saveCycle(p.startAbs, p.endAbs, "lone");
}

// Guided sessions: each wavefront's role is dictated by the current
// phase + its position-in-cycle. Wavefronts that fall on a "null" slot
// (the discarded half of an iso phase) get logged as the cycle's other
// wavefront and ignored — they're real audio but not what we're after
// in this phase. Per-cycle cooldown prevents the discarded wavefront
// from accidentally being counted as the next cycle's start.
function handleGuidedWavefront(startAbs, endAbs, peak, attackMs, durationMs) {
  const g = state.guided;
  if (!g) return;

  // Inter-cycle cooldown — between press cycles we ignore wavefronts so
  // the user has a beat to reset and we don't double-count.
  const now = performance.now();
  if (g.cycleCooldownUntil && now < g.cycleCooldownUntil) {
    return;
  }

  const phase = GUIDED_PHASES[g.phaseIdx];
  const slotIdx = g.wavefrontInCycle;
  const label = phase.captures[slotIdx];
  const isPress = slotIdx === 0;

  // Record the dwell when we see the release of a cycle whose press
  // we just registered. Measured start-to-start: that's the full
  // press-to-release cycle the user perceives. Measuring end-to-start
  // would lose the wavefront-tail time and produce dwells biased
  // ~50 ms low — exactly the bug that made the natural-speed calibration
  // hit the clamp floor and silently break free-form pairing.
  if (!isPress && g.lastPressStartAbs != null) {
    const cycleMs = ((startAbs - g.lastPressStartAbs) / state.sampleRate) * 1000;
    g.observedDwells.push({ phase: phase.id, gapMs: cycleMs });
  }
  if (isPress) g.lastPressStartAbs = startAbs;

  if (label) {
    g.observations.push({ phase: phase.id, label, peak, attackMs, durationMs });
    saveGuidedWavefront(startAbs, endAbs, g.phaseIdx, label);
  } else {
    // discarded wavefront — log it for the status line so the user knows
    // we saw something
    setStatus(`guided · ${phase.label} · (skipped ${isPress ? "press" : "release"})`);
  }

  // brief "✓ GOT IT" flash on captured slots; quieter on discarded ones
  if (label) {
    setStageCaptured();
  } else {
    const el = $("guided-stage");
    if (el) {
      el.dataset.step = "ready";
      $("guided-stage-icon").textContent = "·";
      $("guided-stage-label").textContent = "ok";
      $("guided-stage-sub").textContent = "";
    }
  }

  g.wavefrontInCycle++;
  if (g.wavefrontInCycle >= phase.captures.length) {
    g.wavefrontInCycle = 0;
    g.cyclesInPhase++;
    g.lastPressStartAbs = null;
    g.cycleCooldownUntil = now + 800;
    updateGuidedUI();
    if (g.cyclesInPhase >= phase.cycles) {
      // phase advance handler takes over the stage
      advanceGuidedPhase();
    } else {
      // after the cooldown flash, prompt the next cycle's first slot
      setTimeout(() => {
        if (!state.guided || state.guided.phaseIdx !== g.phaseIdx) return;
        setStageCooldown();
        setTimeout(() => {
          if (!state.guided || state.guided.phaseIdx !== g.phaseIdx) return;
          setStageForSlot(phase, 0);
          updateGuidedUI();
        }, 350);
      }, 250);
    }
  } else {
    // mid-cycle — show the next slot's prompt after a brief beat
    setTimeout(() => {
      if (!state.guided) return;
      const p = GUIDED_PHASES[state.guided.phaseIdx];
      if (p !== phase) return;
      setStageForSlot(p, g.wavefrontInCycle);
      updateGuidedUI();
    }, 250);
    updateGuidedUI();
  }
}

async function saveGuidedWavefront(startAbs, endAbs, phaseIdx, label) {
  const sw = state.currentSwitch;
  if (!sw || !state.storageHandle) return;
  const sr = state.sampleRate;
  const pcm = readRingRange(startAbs, endAbs);
  if (pcm.length < sr * 0.012) return;
  const phaseNum = String(phaseIdx + 1).padStart(2, "0");
  const prefix = `${phaseNum}-${label}`;
  const wav = encodeWav(pcm, sr);
  try {
    await fsSaveSample(sw, wav, prefix);
    state.sessionCount++;
    if (state.guided) state.guided.totalCaptured++;
    $("session-count").textContent = String(state.sessionCount);
    await refreshSwitches();
    if (sw === state.currentSwitch) await loadSwitchSamples(sw);
  } catch (e) {
    console.error("guided save failed", e);
    setStatus("save failed: " + e.message);
  }
}

function _clearPendingFlush() {
  if (state.pendingFlushTimer) {
    clearTimeout(state.pendingFlushTimer);
    state.pendingFlushTimer = null;
  }
  state.pendingWavefront = null;
}

async function saveCycle(startAbs, endAbs, kind) {
  const sw = state.currentSwitch;
  if (!sw || !state.storageHandle) return;
  const pcm = readRingRange(startAbs, endAbs);
  const sr = state.sampleRate;
  if (pcm.length < sr * 0.012) return;

  // Filename prefix when in a guided session — phase id sorts samples
  // by phase when the directory is listed alphabetically.
  let prefix = null;
  if (state.guided) {
    const phase = GUIDED_PHASES[state.guided.phaseIdx];
    const phaseNum = String(state.guided.phaseIdx + 1).padStart(2, "0");
    prefix = `${phaseNum}-${phase.id}`;
  }

  const wav = encodeWav(pcm, sr);
  try {
    await fsSaveSample(sw, wav, prefix);
    state.sessionCount++;
    $("session-count").textContent = String(state.sessionCount);
    if (state.guided) {
      state.guided.capturedInPhase++;
      state.guided.totalCaptured++;
      updateGuidedUI();
      const target = GUIDED_PHASES[state.guided.phaseIdx].count;
      if (state.guided.capturedInPhase >= target) {
        advanceGuidedPhase();
      }
    }
    await refreshSwitches();
    if (sw === state.currentSwitch) await loadSwitchSamples(sw);
  } catch (e) {
    console.error("save failed", e);
    setStatus("save failed: " + e.message);
  }
}



// ============== samples: list, decode, fingerprint =================

async function refreshSwitches() {
  let fromDisk = [];
  if (state.storageHandle) {
    try { fromDisk = await fsListSwitches(); }
    catch (e) { console.warn("list switches failed", e); }
  }
  // keep locally-created empty switches around so they survive a refresh
  const localOnly = state.switches.filter(
    (s) => s.count === 0 && !fromDisk.find((x) => x.name === s.name)
  );
  state.switches = fromDisk.concat(localOnly);
  state.switches.sort((a, b) => a.name.localeCompare(b.name));
  if (state.currentSwitch && !state.switches.find((s) => s.name === state.currentSwitch)) {
    state.currentSwitch = null;
  }
  if (!state.currentSwitch && state.switches.length) {
    state.currentSwitch = state.switches[0].name;
    state.typingSwitch = state.currentSwitch;
  }
  renderSwitchRow();
  updateTypingButtons();
}

async function selectSwitch(name) {
  state.currentSwitch = name;
  // bidirectional sync: the typist pane mirrors the active switch so the
  // two panels are always coherent. Changing one changes the other.
  state.typingSwitch = name;
  renderSwitchRow();
  updateTypingButtons();
  // primary button reflects "calibrated yet?" — flip to calibrate-or-arm
  refreshPrimary();
  if ($("meta-switch")) $("meta-switch").textContent = name;
  setStatus(`switch · ${name}`);
  await loadSwitchSamples(name);
}

async function loadSwitchSamples(name) {
  const sw = state.switches.find((s) => s.name === name);
  $("fp-name").textContent = name || "—";
  if (!sw) {
    state.switchSamples = [];
    renderTiles();
    drawFingerprint(null);
    $("fp-meta").textContent = "";
    return;
  }
  const tiles = sw.samples.map((f) => ({
    switch: name, file: f,
    key: sampleKey(name, f),
  }));
  state.switchSamples = tiles;
  renderTiles();
  drawFingerprint(state.switchProfiles.get(name) || null);
  $("fp-meta").textContent =
    sw.count + " samples" + dwellSuffix(name) + templateSuffix(name);

  // batched decode; partial results render progressively
  let loaded = 0, failed = 0;
  const batch = 12;
  for (let i = 0; i < tiles.length; i += batch) {
    const slice = tiles.slice(i, i + batch);
    const results = await Promise.allSettled(slice.map((t) => ensureSampleMeta(t)));
    for (const r of results) (r.status === "fulfilled" ? loaded++ : failed++);
    setStatus(`loading ${name} · ${loaded}/${tiles.length}${failed ? " · " + failed + " failed" : ""}`);
    renderTiles();
  }
  setStatus(`${name} · ${loaded} sample${loaded === 1 ? "" : "s"} loaded`);

  // compute & draw fingerprint from whatever loaded successfully
  const profile = computeSwitchProfile(name);
  state.switchProfiles.set(name, profile);
  drawFingerprint(profile);
  const dw = dwellSuffix(name);
  const tp = templateSuffix(name);
  $("fp-meta").textContent = profile
    ? `${profile.count} samples · ${(profile.sr / 1000).toFixed(1)} kHz${dw}${tp}`
    : `${sw.count} samples${dw}${tp}`;
}

function dwellSuffix(name) {
  const ms = state.switchDwells.get(name);
  return ms ? ` · dwell ${ms} ms` : "";
}

function templateSuffix(name) {
  const tpl = state.switchTemplates.get(name);
  if (!tpl) return "";
  const parts = [];
  if (tpl.down && tpl.down.topResonancesHz && tpl.down.topResonancesHz[0]) {
    parts.push(`DOWN ${formatHz(tpl.down.topResonancesHz[0])}`);
  }
  if (tpl.up && tpl.up.topResonancesHz && tpl.up.topResonancesHz[0]) {
    parts.push(`UP ${formatHz(tpl.up.topResonancesHz[0])}`);
  }
  return parts.length ? ` · ${parts.join(" · ")}` : "";
}

function formatHz(hz) {
  if (hz >= 1000) return (hz / 1000).toFixed(1) + " kHz";
  return hz + " Hz";
}

async function ensureSampleMeta(t) {
  if (state.samplesCache.has(t.key)) { t.meta = state.samplesCache.get(t.key); return; }
  await ensureAudioCtx();
  const ab = await fsReadSample(t.switch, t.file);
  const buf = await state.audioCtx.decodeAudioData(ab.slice(0));
  const ch = buf.getChannelData(0);

  let peak = 0, peakIdx = 0, rmsSum = 0;
  for (let i = 0; i < ch.length; i++) {
    const v = ch[i] < 0 ? -ch[i] : ch[i];
    if (v > peak) { peak = v; peakIdx = i; }
    rmsSum += ch[i] * ch[i];
  }
  const rms = Math.sqrt(rmsSum / Math.max(1, ch.length));

  // onset = first sample ≥ 25 % of peak; signalEnd = last ≥ 4 %
  const onsetThr = peak * 0.25;
  let onset = peakIdx;
  for (let i = 0; i < ch.length; i++) {
    if (Math.abs(ch[i]) >= onsetThr) { onset = i; break; }
  }
  const tailThr = peak * 0.04;
  let signalEnd = onset + 1;
  for (let i = ch.length - 1; i > onset; i--) {
    if (Math.abs(ch[i]) >= tailThr) { signalEnd = i + 1; break; }
  }

  // 24-bucket peak sparkline for the typist viz
  const VB = 24;
  const mini = new Float32Array(VB);
  const span = Math.max(1, signalEnd - onset);
  const per = Math.max(1, Math.floor(span / VB));
  for (let b = 0; b < VB; b++) {
    let p = 0;
    const s0 = onset + b * per;
    const s1 = Math.min(onset + span, s0 + per);
    for (let i = s0; i < s1 && i < ch.length; i++) {
      const v = Math.abs(ch[i]); if (v > p) p = v;
    }
    mini[b] = p / Math.max(peak, 1e-6);
  }

  // sub-event detection — for clicky switches, separates the down-click
  // from the up-click so both can be labeled in the display.
  const subs = detectSubEventsInSample(ch, peak, buf.sampleRate);

  const meta = { buf, peak, rms, onset, signalEnd, mini, subs };
  state.samplesCache.set(t.key, meta);
  t.meta = meta;
}

// Same logic the run loop uses, but applied offline to a saved sample.
// Picks transient bursts that rise above `peak·0.2` and are separated by
// >= ~12 ms of quieter audio. For a silent linear switch you get one entry;
// for a clicky switch you get two (down + up).
function detectSubEventsInSample(ch, peak, sr) {
  if (peak < 0.02) return [];
  const thr = peak * 0.20;
  const closeSamples = Math.floor(sr * 0.012);
  const subs = [];
  let cur = null, quiet = 0;
  for (let i = 0; i < ch.length; i++) {
    const v = Math.abs(ch[i]);
    if (v > thr) {
      if (!cur) cur = { start: i, end: i, peak: v };
      else { cur.end = i; if (v > cur.peak) cur.peak = v; }
      quiet = 0;
    } else if (cur) {
      quiet++;
      if (quiet >= closeSamples) { subs.push(cur); cur = null; quiet = 0; }
    }
  }
  if (cur) subs.push(cur);
  return subs;
}

// The fingerprint: averaged FFT (magnitude) of an 8192-sample window
// centered on each sample's loudest point, then smoothed in 1/48 octave
// bands. Using a 4-term Blackman-Harris window pushes sidelobes down to
// ~-92 dB (vs Hann's ~-32 dB) so resonant peaks stand out against a
// genuinely quiet floor instead of getting buried under window leakage.
function computeSwitchProfile(name) {
  const all = state.switchSamples.filter(
    (t) => t.meta && t.switch === name
  );
  if (!all.length) return null;

  // Outlier rejection. Measurements omitted ≠ measurements nonexistent:
  // each sample's peak amplitude is retained in meta, so we can verify
  // concept-membership before averaging into the fingerprint. Reject
  // samples whose peak is far from the median — those are likely false
  // triggers, contaminated recordings, or accidental double-strikes.
  // Keep the band [median/4, median·4] which spans the natural range
  // of soft → hard taps on the same switch (well over 12 dB).
  const peaks = all.map((t) => t.meta.peak).sort((a, b) => a - b);
  const median = peaks[Math.floor(peaks.length / 2)];
  const samples = all.filter(
    (t) => t.meta.peak >= median / 4 && t.meta.peak <= median * 4
  );
  const rejected = all.length - samples.length;
  if (!samples.length) return null;
  const prof = computeProfileFromSamples(samples);
  if (prof) prof.rejected = rejected;
  return prof;
}

// Average-spectrum profile for a subset of samples. Shared between the
// whole-switch fingerprint and the per-role (DOWN / UP) profiles that
// the guided session produces.
function computeProfileFromSamples(samples) {
  if (!samples || !samples.length) return null;
  const N = FFT_N;
  const re = new Float64Array(N), im = new Float64Array(N);
  const sumMag = new Float64Array(N / 2);
  const sr = samples[0].meta.buf.sampleRate;
  const win = getWindow(state.fft.window, N);
  for (const t of samples) {
    const ch = t.meta.buf.getChannelData(0);
    let centerIdx = 0, p = 0;
    for (let i = 0; i < ch.length; i++) {
      const v = ch[i] < 0 ? -ch[i] : ch[i];
      if (v > p) { p = v; centerIdx = i; }
    }
    let start = Math.max(0, centerIdx - N / 2);
    if (start + N > ch.length) start = Math.max(0, ch.length - N);
    re.fill(0); im.fill(0);
    for (let i = 0; i < N; i++) {
      const x = (start + i) < ch.length ? ch[start + i] : 0;
      re[i] = x * win[i];
    }
    fft(re, im);
    for (let i = 0; i < sumMag.length; i++) {
      sumMag[i] += Math.sqrt(re[i] * re[i] + im[i] * im[i]);
    }
  }
  for (let i = 0; i < sumMag.length; i++) sumMag[i] /= samples.length;
  const smoothed = smoothLogFreq(sumMag, sr, 1 / 48);
  const spectralPeaks = findSpectralPeaks(smoothed, sr, 6);
  return { spectrum: smoothed, sr, count: samples.length, peaks: spectralPeaks };
}

// Per-role profile: filenames produced by the guided session start with
// "NN-down-…" or "NN-up-…", so we filter by that prefix and average
// over the matching samples. Returns null if nothing is labeled.
function computeRoleProfile(switchName, role) {
  const re = new RegExp(`^\\d+-${role}-`);
  const samples = state.switchSamples.filter(
    (t) => t.meta && t.switch === switchName && re.test(t.file)
  );
  return computeProfileFromSamples(samples);
}

// FFT windows. Cached by (name, N).
//
//   Hann            (-32 dB sidelobes)   balanced; the textbook default
//   Hamming         (-43 dB)             slightly cleaner first sidelobe
//   Blackman-Harris (-92 dB)             best for resolving close peaks
//   Flat-top        (-93 dB, wide main)  accurate peak amplitude readout
//
// Flat-top has a deliberately broad mainlobe so the peak of any tone sits
// at the same height regardless of how it lines up with FFT bins —
// fantastic for reading the amplitude of resonant peaks, less good for
// resolving two peaks that are close together.
const _winCache = new Map();
function getWindow(name, N) {
  const key = name + ":" + N;
  const cached = _winCache.get(key);
  if (cached) return cached;
  const w = new Float64Array(N);
  const TAU = 2 * Math.PI / (N - 1);
  if (name === "hann") {
    for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos(i * TAU);
  } else if (name === "hamming") {
    for (let i = 0; i < N; i++) w[i] = 0.54 - 0.46 * Math.cos(i * TAU);
  } else if (name === "flat-top") {
    const a0 = 0.21557895, a1 = 0.41663158, a2 = 0.277263158, a3 = 0.083578947, a4 = 0.006947368;
    for (let i = 0; i < N; i++) {
      const x = i * TAU;
      w[i] = a0 - a1*Math.cos(x) + a2*Math.cos(2*x) - a3*Math.cos(3*x) + a4*Math.cos(4*x);
    }
  } else { // blackman-harris (default)
    const a0 = 0.35875, a1 = 0.48829, a2 = 0.14128, a3 = 0.01168;
    for (let i = 0; i < N; i++) {
      const x = i * TAU;
      w[i] = a0 - a1*Math.cos(x) + a2*Math.cos(2*x) - a3*Math.cos(3*x);
    }
  }
  _winCache.set(key, w);
  return w;
}

// Locate prominent local maxima in a magnitude spectrum. Prominence is
// measured against the loudest competing point inside +/- 1/6 octave,
// in dB. Returns up to `maxN` peaks sorted by absolute magnitude.
function findSpectralPeaks(mag, sr, maxN) {
  const half = mag.length;
  const N = half * 2;
  const factor = Math.pow(2, 1 / 6);
  const peaks = [];
  for (let i = 4; i < half - 4; i++) {
    const f = (i / N) * sr;
    if (f < 80 || f > sr / 2 - 200) continue;
    const iLow = Math.max(1, Math.round(i / factor));
    const iHigh = Math.min(half - 1, Math.round(i * factor));
    let isPeak = true, localMax = 0;
    for (let j = iLow; j <= iHigh; j++) {
      if (j !== i && mag[j] > mag[i]) { isPeak = false; break; }
      if (j !== i && mag[j] > localMax) localMax = mag[j];
    }
    if (!isPeak) continue;
    const promDb = 20 * Math.log10(mag[i] / Math.max(localMax, 1e-12));
    if (promDb < 2) continue;     // require ≥ 2 dB prominence
    peaks.push({ freq: f, mag: mag[i], promDb });
  }
  peaks.sort((a, b) => b.mag - a.mag);
  // dedupe near-duplicates that survived (within 1/6 octave of a louder peak)
  const out = [];
  for (const p of peaks) {
    if (out.some((q) => Math.abs(Math.log2(q.freq / p.freq)) < 1 / 6)) continue;
    out.push(p);
    if (out.length >= maxN) break;
  }
  // return sorted by frequency for left-to-right rendering
  out.sort((a, b) => a.freq - b.freq);
  return out;
}

function smoothLogFreq(mag, sr, octWidth) {
  const N = mag.length * 2;
  const out = new Float64Array(mag.length);
  const factor = Math.pow(2, octWidth / 2);
  for (let i = 1; i < mag.length; i++) {
    const f = (i / N) * sr;
    const fLow = f / factor, fHigh = f * factor;
    const iLow = Math.max(1, Math.round((fLow * N) / sr));
    const iHigh = Math.min(mag.length - 1, Math.round((fHigh * N) / sr));
    let sum = 0, n = 0;
    for (let j = iLow; j <= iHigh; j++) { sum += mag[j]; n++; }
    out[i] = n > 0 ? sum / n : mag[i];
  }
  return out;
}

// in-place Cooley-Tukey radix-2 FFT (N must be a power of 2)
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wpr = Math.cos(ang), wpi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wr = 1, wi = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const tr = wr * re[b] - wi * im[b];
        const ti = wr * im[b] + wi * re[b];
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] = re[a] + tr; im[a] = im[a] + ti;
        const nwr = wr * wpr - wi * wpi;
        wi = wr * wpi + wi * wpr;
        wr = nwr;
      }
    }
  }
}


// ============== drawing ============================================

function autoWindow(t) {
  const sr = t.meta.buf.sampleRate;
  const preMargin = Math.floor((PRE_MARGIN_MS / 1000) * sr);
  const postMargin = Math.floor((POST_MARGIN_MS / 1000) * sr);
  const minWindow = Math.floor((MIN_WINDOW_MS / 1000) * sr);
  const signalLen = Math.max(0, t.meta.signalEnd - t.meta.onset);
  const post = signalLen + postMargin;
  const windowSamples = Math.max(minWindow, Math.ceil(post / (1 - ONSET_AT)));
  const pre = Math.min(preMargin, Math.floor(windowSamples * ONSET_AT));
  let start = t.meta.onset - pre;
  if (start < 0) start = 0;
  return { start, length: windowSamples, sr };
}

function drawMini(c, t) {
  const dpr = sizeCanvas(c);
  const g = c.getContext("2d");
  const W = c.width, H = c.height, half = H / 2;
  g.clearRect(0, 0, W, H);
  const ch = t.meta.buf.getChannelData(0);
  const { start, length } = autoWindow(t);
  const spp = length / W;
  g.strokeStyle = COL_INK;
  g.lineWidth = 1 * dpr;
  g.beginPath();
  let any = false;
  for (let x = 0; x < W; x++) {
    const s0 = Math.floor(start + x * spp);
    const s1 = Math.min(start + length, s0 + Math.max(1, Math.ceil(spp)));
    let p = 0, has = false;
    for (let i = s0; i < s1 && i < ch.length; i++) {
      const v = Math.abs(ch[i]); if (v > p) p = v; has = true;
    }
    if (!has) continue;
    any = true;
    g.moveTo(x, half - p * half);
    g.lineTo(x, half + p * half);
  }
  if (any) g.stroke();
  const onsetX = Math.floor(W * ONSET_AT);
  g.strokeStyle = withAlpha(COL_ACCENT, 0.5);
  g.beginPath(); g.moveTo(onsetX, 0); g.lineTo(onsetX, H); g.stroke();
}

function drawDetailWave(t) {
  const c = $("detail-wave");
  const dpr = sizeCanvas(c);
  const g = c.getContext("2d");
  g.fillStyle = COL_BG; g.fillRect(0, 0, c.width, c.height);
  const ch = t.meta.buf.getChannelData(0);
  const { start, length, sr } = autoWindow(t);
  const W = c.width, H = c.height, half = H / 2;
  const spp = length / W;
  const norm = 0.95 / Math.max(t.meta.peak, 1e-6);

  if (spp < 2) {
    g.beginPath();
    let started = false;
    for (let x = 0; x < W; x++) {
      const i = Math.floor(start + x * spp);
      if (i < 0 || i >= ch.length) { started = false; continue; }
      const y = half - ch[i] * norm * half;
      if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y);
    }
    g.strokeStyle = COL_INK; g.lineWidth = 1 * dpr; g.stroke();
  } else {
    const tops = new Float32Array(W), bots = new Float32Array(W);
    const valid = new Uint8Array(W);
    for (let x = 0; x < W; x++) {
      const s0 = Math.floor(start + x * spp);
      const s1 = Math.min(start + length, s0 + Math.max(1, Math.ceil(spp)));
      let mn = 0, mx = 0, has = 0;
      for (let i = s0; i < s1 && i < ch.length; i++) {
        const v = ch[i];
        if (!has) { mn = v; mx = v; has = 1; }
        else { if (v < mn) mn = v; if (v > mx) mx = v; }
      }
      if (has) {
        tops[x] = half - mx * norm * half;
        bots[x] = half - mn * norm * half;
        valid[x] = 1;
      }
    }
    // filled envelope
    g.beginPath();
    let inRun = false;
    for (let x = 0; x < W; x++) {
      if (valid[x]) {
        if (!inRun) { g.moveTo(x, tops[x]); inRun = true; }
        else g.lineTo(x, tops[x]);
      } else if (inRun) {
        for (let bx = x - 1; bx >= 0 && valid[bx]; bx--) g.lineTo(bx, bots[bx]);
        g.closePath();
        inRun = false;
      }
    }
    if (inRun) {
      for (let bx = W - 1; bx >= 0 && valid[bx]; bx--) g.lineTo(bx, bots[bx]);
      g.closePath();
    }
    g.fillStyle = withAlpha(COL_INK, 0.14); g.fill();
    g.strokeStyle = COL_INK; g.lineWidth = 1 * dpr;
    g.beginPath();
    let s = false;
    for (let x = 0; x < W; x++) {
      if (!valid[x]) { s = false; continue; }
      if (!s) { g.moveTo(x, tops[x]); s = true; } else g.lineTo(x, tops[x]);
    }
    g.stroke();
    g.beginPath(); s = false;
    for (let x = 0; x < W; x++) {
      if (!valid[x]) { s = false; continue; }
      if (!s) { g.moveTo(x, bots[x]); s = true; } else g.lineTo(x, bots[x]);
    }
    g.stroke();
  }

  // zero line + onset marker
  g.strokeStyle = COL_GRID_2;
  g.beginPath(); g.moveTo(0, half); g.lineTo(W, half); g.stroke();
  const onsetX = Math.floor(W * ONSET_AT);
  g.strokeStyle = withAlpha(COL_ACCENT, 0.55);
  g.beginPath(); g.moveTo(onsetX, 0); g.lineTo(onsetX, H); g.stroke();

  // time-from-onset axis. Pick the *largest* tick spacing from a 1-2-5 series
  // that still yields ~6-10 labels across the window — keeps numbers from
  // crashing into each other on short samples.
  const windowMs = (length / sr) * 1000;
  const preMs = ((t.meta.onset - start) / sr) * 1000;
  const candidates = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500];
  const targetLabels = 8;
  let tickMs = candidates[0];
  for (const v of candidates) {
    if (windowMs / v >= targetLabels) tickMs = v;       // largest that fits
  }
  // minor ticks at half spacing — unlabeled — give finer reading
  const minorMs = tickMs / (tickMs % 2 === 0 ? 2 : 1);
  const pxPerMs = W / windowMs;
  g.fillStyle = COL_INK_MUTE;
  g.font = `${10 * dpr}px "IBM Plex Mono", monospace`;
  for (let ms = -Math.ceil(preMs / minorMs) * minorMs; ms <= windowMs - preMs; ms += minorMs) {
    const x = onsetX + ms * pxPerMs;
    if (x < 0 || x > W) continue;
    const isMajor = Math.abs(ms % tickMs) < 0.001;
    g.fillRect(x, H - (isMajor ? 5 : 3) * dpr, 1 * dpr, (isMajor ? 5 : 3) * dpr);
    if (isMajor) {
      g.fillText((ms === 0 ? "0" : ms) + " ms", x + 3 * dpr, H - 8 * dpr);
    }
  }

  // label the onset line — DOWN for clicky switches (two+ sub-events),
  // plain ONSET for silent linears.
  const subs = t.meta.subs || [];
  const clicky = subs.length >= 2;
  g.fillStyle = withAlpha(COL_ACCENT, 0.95);
  g.font = `${9 * dpr}px "IBM Plex Mono", monospace`;
  g.fillText(clicky ? "DOWN" : "ONSET", onsetX + 4 * dpr, 12 * dpr);

  // additional sub-events (UP click, and any further bounces). Each gets
  // a dashed marker at its start with a label.
  if (clicky) {
    for (let i = 1; i < subs.length; i++) {
      const sx = ((subs[i].start - start) / length) * W;
      if (sx < 0 || sx > W) continue;
      g.strokeStyle = withAlpha(COL_ACCENT, 0.55);
      g.lineWidth = 1 * dpr;
      g.setLineDash([4 * dpr, 4 * dpr]);
      g.beginPath(); g.moveTo(sx, 16 * dpr); g.lineTo(sx, H - 18 * dpr); g.stroke();
      g.setLineDash([]);
      g.fillStyle = withAlpha(COL_ACCENT, 0.95);
      const label = i === 1 ? "UP" : `+${i}`;
      g.fillText(label, sx + 4 * dpr, 12 * dpr);
    }
    // show down→up timing in the info bar would be nice, but the inspect
    // info row is already populated; render it as a faint annotation here.
    if (subs.length >= 2) {
      const gapSamp = subs[1].start - subs[0].start;
      const gapMs = (gapSamp / sr) * 1000;
      g.fillStyle = COL_INK_MUTE;
      g.fillText(`down→up · ${gapMs.toFixed(1)} ms`,
                 onsetX + 4 * dpr, H - 22 * dpr);
    }
  }
}

// 5-stop approximation of the magma colormap. t ∈ [0,1].
// Used for the spectrogram heatmap so amplitude → perceptually graded
// brightness, the way bioacoustics spectrograms render whalesong calls.
function colormapMagma(t) {
  // stops at 0.00, 0.25, 0.50, 0.75, 1.00
  const stops = [
    [  0,   0,   4],
    [ 60,  19,  91],
    [171,  53, 112],
    [245, 130,  88],
    [252, 253, 191],
  ];
  if (t <= 0) return stops[0];
  if (t >= 1) return stops[4];
  const seg = t * 4;
  const i = Math.floor(seg);
  const k = seg - i;
  const a = stops[i], b = stops[i + 1];
  return [
    a[0] + (b[0] - a[0]) * k,
    a[1] + (b[1] - a[1]) * k,
    a[2] + (b[2] - a[2]) * k,
  ];
}

// Short-Time Fourier Transform spectrogram. Time on x (aligned to the
// waveform window above), linear frequency on y (0 → Nyquist). Magnitude
// shown as log-dB on a -70 → 0 dB scale, painted via the magma ramp so
// the down-click reads as a vertical broadband flash, the resonant decay
// as horizontal stripes, and the up-click as a second flash farther right.
function drawDetailSpectrogram(t) {
  const c = $("detail-spec");
  if (!c) return;
  const dpr = sizeCanvas(c);
  const g = c.getContext("2d");
  g.fillStyle = "#000004"; g.fillRect(0, 0, c.width, c.height);

  const ch = t.meta.buf.getChannelData(0);
  const sr = t.meta.buf.sampleRate;
  const { start, length } = autoWindow(t);
  const W = c.width, H = c.height;

  const N = 512;
  const hop = 128;                     // 75 % overlap
  const win = getWindow("hann", N);    // Hann is the workhorse for spectrograms
  const numFrames = Math.max(1, Math.floor((length - N) / hop) + 1);
  const halfN = N / 2;

  const re = new Float64Array(N), im = new Float64Array(N);
  // magnitude buffer: numFrames × halfN. Stored as Float32 so the whole
  // thing fits easily even for long samples.
  const mag = new Float32Array(numFrames * halfN);
  let maxMag = 1e-12;
  for (let f = 0; f < numFrames; f++) {
    const offset = start + f * hop;
    re.fill(0); im.fill(0);
    for (let i = 0; i < N; i++) {
      const x = (offset + i) < ch.length && (offset + i) >= 0 ? ch[offset + i] : 0;
      re[i] = x * win[i];
    }
    fft(re, im);
    for (let i = 0; i < halfN; i++) {
      const m = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
      mag[f * halfN + i] = m;
      if (m > maxMag) maxMag = m;
    }
  }

  // paint pixel by pixel into ImageData. Each x maps to a frame, each y
  // to a frequency bin (top = high freq). Magnitude → dB → magma RGB.
  const img = g.createImageData(W, H);
  const data = img.data;
  const DB_FLOOR = -70;
  const invDb = 1 / -DB_FLOOR;
  const invMax = 1 / maxMag;
  for (let x = 0; x < W; x++) {
    const fIdx = Math.min(numFrames - 1, Math.floor((x / W) * numFrames));
    const fOff = fIdx * halfN;
    for (let y = 0; y < H; y++) {
      // y=0 at top → high frequency
      const bIdx = Math.min(halfN - 1, Math.floor(((H - 1 - y) / H) * halfN));
      const m = mag[fOff + bIdx];
      let db = 20 * Math.log10(m * invMax + 1e-12);
      if (db < DB_FLOOR) db = DB_FLOOR;
      const intensity = (db - DB_FLOOR) * invDb;            // 0..1
      const rgb = colormapMagma(intensity);
      const p = (y * W + x) * 4;
      data[p]   = rgb[0];
      data[p+1] = rgb[1];
      data[p+2] = rgb[2];
      data[p+3] = 255;
    }
  }
  g.putImageData(img, 0, 0);

  // axes — frequency on left, time on bottom, aligned to the waveform
  g.fillStyle = "rgba(232,230,224,0.9)";
  g.font = `${10 * dpr}px "IBM Plex Mono", monospace`;
  const nyquist = sr / 2;
  // freq labels
  [1000, 5000, 10000, 15000, 20000].forEach((f) => {
    if (f > nyquist) return;
    const y = H - (f / nyquist) * H;
    g.fillStyle = "rgba(232,230,224,0.55)";
    g.fillRect(0, y, 4 * dpr, 1);
    g.fillStyle = "rgba(232,230,224,0.85)";
    const label = f >= 1000 ? (f / 1000) + " kHz" : f + " Hz";
    g.fillText(label, 6 * dpr, y - 2 * dpr);
  });

  // onset line (matches the waveform's orange marker)
  const onsetX = Math.floor(W * ONSET_AT);
  g.strokeStyle = withAlpha(COL_ACCENT, 0.7);
  g.lineWidth = 1 * dpr;
  g.beginPath(); g.moveTo(onsetX, 0); g.lineTo(onsetX, H); g.stroke();

  // window length annotation
  const windowMs = (length / sr) * 1000;
  g.fillStyle = "rgba(232,230,224,0.6)";
  g.fillText(`${windowMs.toFixed(0)} ms · ${N}-pt Hann · ${(hop/sr*1000).toFixed(1)} ms hop`,
             6 * dpr, H - 6 * dpr);
}

function drawDetailFFT(t) {
  const c = $("detail-fft");
  const dpr = sizeCanvas(c);
  const g = c.getContext("2d");
  g.fillStyle = COL_BG; g.fillRect(0, 0, c.width, c.height);

  const ch = t.meta.buf.getChannelData(0);
  const sr = t.meta.buf.sampleRate;
  const N = FFT_N;
  let centerIdx = 0, peak = 0;
  for (let i = 0; i < ch.length; i++) {
    const v = ch[i] < 0 ? -ch[i] : ch[i];
    if (v > peak) { peak = v; centerIdx = i; }
  }
  let start = Math.max(0, centerIdx - N / 2);
  if (start + N > ch.length) start = Math.max(0, ch.length - N);
  const re = new Float64Array(N), im = new Float64Array(N);
  const win = getWindow(state.fft.window, N);
  for (let i = 0; i < N; i++) {
    const x = (start + i) < ch.length ? ch[start + i] : 0;
    re[i] = x * win[i];
  }
  fft(re, im);
  const half = N / 2;
  const mags = new Float64Array(half);
  let maxMag = 0;
  for (let i = 0; i < half; i++) {
    const m = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
    mags[i] = m;
    if (m > maxMag) maxMag = m;
  }

  drawFFTAxes(g, c, sr);

  g.beginPath();
  let started = false;
  const W = c.width, H = c.height;
  const fMin = fftFreqMin(sr), fMax = fftFreqMax(sr);
  for (let i = 1; i < half; i++) {
    const freq = (i / N) * sr;
    if (freq < fMin || freq > fMax) continue;
    const x = freqToX(freq, sr, W);
    const db = 20 * Math.log10(mags[i] / (maxMag || 1) + 1e-9);
    const y = H - clamp((db + 80) / 80, 0, 1) * H;
    if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y);
  }
  g.strokeStyle = COL_ACCENT; g.lineWidth = 1 * dpr; g.stroke();
}

// X mapping that respects the current frequency-scale setting. Linear is
// useful when the interesting structure lives in the mid/high band —
// keyswitch resonances usually do — because log compresses everything
// above ~5 kHz into the right edge.
function freqToX(f, sr, W) {
  const scale = state.fft.scale;
  const fMax = sr / 2;
  if (scale === "linear") return clamp((f / fMax) * W, 0, W);
  const fMin = 30;
  const lMin = Math.log10(fMin), lMax = Math.log10(fMax);
  return clamp(((Math.log10(Math.max(f, fMin)) - lMin) / (lMax - lMin)) * W, 0, W);
}

function fftFreqMin(sr) { return state.fft.scale === "linear" ? 0 : 30; }
function fftFreqMax(sr) { return sr / 2; }

function drawFFTAxes(g, c, sr) {
  const W = c.width, H = c.height;
  const dpr = window.devicePixelRatio || 1;
  const scale = state.fft.scale;
  const grid = scale === "linear"
    ? [2000, 4000, 6000, 8000, 10000, 12000, 14000, 16000, 18000, 20000, 22000]
    : [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
  const labels = scale === "linear"
    ? [2000, 4000, 8000, 12000, 16000, 20000]
    : [100, 500, 1000, 5000, 10000, 20000];

  g.strokeStyle = COL_GRID; g.lineWidth = 1;
  grid.forEach((f) => {
    if (f > sr / 2) return;
    const x = freqToX(f, sr, W);
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
  });
  for (let db = -60; db <= 0; db += 20) {
    const y = H - ((db + 80) / 80) * H;
    g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
  }
  g.fillStyle = COL_INK_MUTE;
  g.font = `${10 * dpr}px "IBM Plex Mono", monospace`;
  labels.forEach((f) => {
    if (f > sr / 2) return;
    const x = freqToX(f, sr, W);
    const label = f >= 1000 ? (f / 1000) + " kHz" : f + " Hz";
    g.fillText(label, x + 3 * dpr, H - 6 * dpr);
  });
  for (let db = -60; db <= 0; db += 20) {
    const y = H - ((db + 80) / 80) * H;
    g.fillText(db + " dB", 4 * dpr, y - 2 * dpr);
  }
}

function drawFingerprint(profile) {
  const c = $("fingerprint");
  if (c.clientWidth === 0) {
    requestAnimationFrame(() => drawFingerprint(profile));
    return;
  }
  const dpr = sizeCanvas(c);
  const g = c.getContext("2d");
  g.fillStyle = COL_BG2; g.fillRect(0, 0, c.width, c.height);

  const color = state.currentSwitch ? colorForSwitch(state.currentSwitch) : COL_ACCENT;
  $("fp-name").style.color = color;

  if (!profile || !profile.spectrum) {
    g.fillStyle = COL_INK_MUTE;
    g.font = `${12 * dpr}px "IBM Plex Mono", monospace`;
    g.fillText("no samples yet", 16 * dpr, c.height / 2);
    return;
  }

  drawFFTAxes(g, c, profile.sr);

  const mag = profile.spectrum;
  const sr = profile.sr;
  const N = mag.length * 2;
  const W = c.width, H = c.height;
  const fMin = fftFreqMin(sr), fMax = fftFreqMax(sr);
  let maxMag = 0;
  for (let i = 0; i < mag.length; i++) if (mag[i] > maxMag) maxMag = mag[i];

  const x4f  = (f) => freqToX(f, sr, W);
  const y4db = (db) => H - clamp((db + 80) / 80, 0, 1) * H;

  const pts = [];
  for (let i = 1; i < mag.length; i++) {
    const f = (i / N) * sr;
    if (f < fMin || f > fMax) continue;
    const db = 20 * Math.log10(mag[i] / (maxMag || 1) + 1e-9);
    pts.push([x4f(f), y4db(db)]);
  }

  // gradient fill under the curve
  g.beginPath();
  pts.forEach(([x, y], i) => { if (i === 0) g.moveTo(x, y); else g.lineTo(x, y); });
  if (pts.length) { g.lineTo(pts[pts.length - 1][0], H); g.lineTo(pts[0][0], H); g.closePath(); }
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, withAlpha(color, 0.55));
  grad.addColorStop(1, withAlpha(color, 0.02));
  g.fillStyle = grad; g.fill();

  // curve
  g.beginPath();
  pts.forEach(([x, y], i) => { if (i === 0) g.moveTo(x, y); else g.lineTo(x, y); });
  g.strokeStyle = color; g.lineWidth = 1.6 * dpr; g.stroke();

  // halo
  g.shadowColor = color; g.shadowBlur = 8 * dpr;
  g.strokeStyle = withAlpha(color, 0.4);
  g.beginPath();
  pts.forEach(([x, y], i) => { if (i === 0) g.moveTo(x, y); else g.lineTo(x, y); });
  g.stroke();
  g.shadowBlur = 0;

  // resonant peaks — these are the distinguishing marks of the switch
  if (profile.peaks && profile.peaks.length) {
    g.font = `${10 * dpr}px "IBM Plex Mono", monospace`;
    g.textBaseline = "alphabetic";
    for (const p of profile.peaks) {
      const px = x4f(p.freq);
      const py = y4db(20 * Math.log10(p.mag / (maxMag || 1) + 1e-9));
      // marker — small ringed dot
      g.fillStyle = COL_BG2;
      g.beginPath(); g.arc(px, py, 4 * dpr, 0, 2 * Math.PI); g.fill();
      g.strokeStyle = color; g.lineWidth = 1.5 * dpr;
      g.beginPath(); g.arc(px, py, 4 * dpr, 0, 2 * Math.PI); g.stroke();
      g.fillStyle = color;
      g.beginPath(); g.arc(px, py, 1.6 * dpr, 0, 2 * Math.PI); g.fill();
      // dashed vertical down to the axis
      g.strokeStyle = withAlpha(color, 0.35);
      g.lineWidth = 1 * dpr;
      g.setLineDash([3 * dpr, 4 * dpr]);
      g.beginPath();
      g.moveTo(px, py + 6 * dpr); g.lineTo(px, H - 12 * dpr);
      g.stroke();
      g.setLineDash([]);
      // frequency label above
      const label = p.freq < 1000
        ? `${p.freq.toFixed(0)} Hz`
        : `${(p.freq / 1000).toFixed(p.freq < 10000 ? 2 : 1)} kHz`;
      g.fillStyle = COL_INK;
      const labelY = Math.max(14 * dpr, py - 8 * dpr);
      const tw = g.measureText(label).width;
      // small backdrop for legibility
      g.fillStyle = withAlpha(COL_BG2, 0.85);
      g.fillRect(px - tw / 2 - 3 * dpr, labelY - 11 * dpr, tw + 6 * dpr, 13 * dpr);
      g.fillStyle = color;
      g.fillText(label, px - tw / 2, labelY - 1 * dpr);
    }
  }
}


// ============== typist =============================================

async function startTyping() {
  if (state.typingActive) return;
  await ensureAudioCtx();
  if (state.audioCtx.state === "suspended") await state.audioCtx.resume();
  if (!state.typingSwitch) {
    const first = state.switches.find((s) => s.count > 0);
    if (!first) { alert("record some samples first"); return; }
    state.typingSwitch = first.name;
  }
  state.typingActive = true;
  $("type-start").classList.add("busy");
  $("typist-status").classList.add("typing");
  $("typist-status").textContent = "typing · " + state.typingSwitch;
  updateTypingButtons();

  let stop = false;
  state.typingStop = () => { stop = true; };

  let pool = [], poolName = null;
  let nextTime = state.audioCtx.currentTime + 0.05;
  let prevCh = null;
  // Amplitude target drifts as a slow random walk in [0..1], biased by
  // rhythm: rolls go softer, spaces / pauses go heavier. The amp target
  // drives BOTH the sample-percentile pick (force represented by which
  // recording we play) AND the playback gain (force represented by how
  // loudly we play it). That double-coupling is what makes the dynamics
  // read as "a person typing" instead of "samples firing."
  let ampTarget = 0.5;
  state.typingRecentIdx.length = 0;
  const mode = ($("typist-mode") && $("typist-mode").value) || "passages";
  const stream = makeTextStream(mode);

  try {
    while (!stop) {
      if (state.typingSwitch !== poolName) {
        poolName = state.typingSwitch;
        $("typist-status").textContent = "typing · " + poolName;
        pool = await loadPoolForSwitch(poolName);
        state.typingRecentIdx.length = 0;
      }
      if (!pool.length) { await sleep(150); continue; }

      const ch = stream.next();
      const N = pool.length;

      // Pick by amplitude percentile, then walk away from any of the last
      // few choices so the same WAV doesn't repeat back-to-back — the
      // single most audible "fake" cue if left alone.
      const jitter = (Math.random() - 0.5) * 0.18;
      let idx = clamp(Math.floor((ampTarget + jitter) * N), 0, N - 1);
      if (N > 2) {
        const recent = state.typingRecentIdx;
        for (let off = 0; off < N; off++) {
          const candidates = off === 0 ? [idx] : [idx + off, idx - off];
          let picked = null;
          for (const c of candidates) {
            if (c >= 0 && c < N && !recent.includes(c)) { picked = c; break; }
          }
          if (picked != null) { idx = picked; break; }
        }
        recent.push(idx);
        const memory = Math.min(3, Math.floor(N / 2));
        while (recent.length > memory) recent.shift();
      }
      const t = pool[idx];

      if (nextTime < state.audioCtx.currentTime) {
        nextTime = state.audioCtx.currentTime + 0.005;
      }

      // Per-stroke audio graph: source → gain (velocity) → pan (spatial)
      // → destination. The graph is rebuilt every keystroke; modern Web
      // Audio handles thousands of these per second without GC stutter
      // because each node is released as soon as its source ends.
      const src = state.audioCtx.createBufferSource();
      src.buffer = t.meta.buf;
      // Pitch micro-jitter: ±0.6 % ≈ ±10 cents. Real switches vary press
      // to press because the slider sits slightly differently in the
      // housing each time. Without this, even with sample rotation the
      // ear can hear a "perfectly in tune" repetition.
      src.playbackRate.value = 1 + (Math.random() - 0.5) * 0.012;

      // Velocity gain. Soft strokes ride at ~0.55, hard at ~1.05. Space
      // gets a small boost — spacebars are physically larger and
      // perceptually louder.
      const gain = state.audioCtx.createGain();
      let velGain = 0.55 + ampTarget * 0.5;
      if (ch === " ") velGain *= 1.15;
      gain.gain.value = velGain;

      // Stereo pan from a rough QWERTY position model: left half of the
      // keyboard pans left, right half pans right. The cue is subtle
      // (max ±0.6) but it's a strong subconscious signal that lifts
      // realism a lot — typing on a real board is never a point source.
      const pan = state.audioCtx.createStereoPanner();
      pan.pan.value = panForChar(ch);

      src.connect(gain).connect(pan).connect(state.audioCtx.destination);
      src.start(nextTime);

      schedulePulse(nextTime, poolName, t.meta.mini, ch);

      const wpm = clamp(parseInt($("wpm").value, 10) || 100, 20, 240);
      const mean = 60 / (wpm * 5);
      // Wider gaussian + digraph rolls give the typist the burst-and-pause
      // rhythm of a real touch typist.
      const sigma = mean * 0.5;
      let dt = mean + sigma * gaussianStd();
      dt = clamp(dt, mean * 0.35, mean * 3.2);

      const pair = (prevCh != null && ch != null) ? (prevCh + ch).toLowerCase() : "";
      if (FAST_PAIRS.has(pair))      { dt *= 0.7;  ampTarget -= 0.04; }   // roll → flow, softer
      else if (SLOW_PAIRS.has(pair)) { dt *= 1.35; ampTarget += 0.03; }   // awkward → stretch, slightly harder
      if (ch === " ")      { dt *= 1.4; ampTarget += 0.05; }              // breath + reset force
      else if (ch === "·") { dt *= 1.8; ampTarget += 0.07; }              // longer pause + heavier reentry
      // every ~30 keystrokes, simulate a glance / micro-think (and a hard reset on force)
      if (Math.random() < 0.035) { dt *= 1.8 + Math.random() * 1.4; ampTarget = 0.4 + Math.random() * 0.4; }

      // slow random walk for the rest of the time
      ampTarget += (Math.random() - 0.5) * 0.025;
      if (ampTarget < 0.15) ampTarget = 0.15;
      if (ampTarget > 0.85) ampTarget = 0.85;

      nextTime += dt;
      prevCh = ch;

      const waitMs = (nextTime - state.audioCtx.currentTime) * 1000 - 25;
      if (waitMs > 0) await sleep(waitMs);
    }
  } finally {
    state.typingActive = false;
    state.typingStop = null;
    $("type-start").classList.remove("busy");
    $("typist-status").classList.remove("typing");
    $("typist-status").textContent = "idle";
    updateTypingButtons();
  }
}

function stopTyping() { if (state.typingStop) state.typingStop(); }

function setTypingSwitch(name) {
  state.typingSwitch = name;
  if (state.typingActive) $("typist-status").textContent = "typing · " + name;
  // sync the switch pane so fingerprint / samples / inspection follow
  if (state.currentSwitch !== name) selectSwitch(name);
  else updateTypingButtons();
}

async function loadPoolForSwitch(name) {
  const sw = state.switches.find((s) => s.name === name);
  if (!sw) return [];
  const pool = sw.samples.map((f) => ({
    switch: sw.name, file: f, key: sampleKey(sw.name, f),
  }));
  await Promise.allSettled(pool.map((t) => ensureSampleMeta(t)));
  // Sort by peak amplitude so the typist can pick by force percentile.
  return pool.filter((t) => t.meta).sort((a, b) => a.meta.peak - b.meta.peak);
}

function gaussianStd() {
  const u1 = Math.random() || 1e-9;
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// Rough QWERTY pan model. Letters on the left hand pan left, right hand
// right; space pans near center. The mapping doesn't have to be physically
// accurate — a soft, consistent left/right bias is enough for the brain
// to register "this is happening across a keyboard, not a single point."
const _PAN_LEFT  = "qwertasdfgzxcvb12345";
const _PAN_RIGHT = "yuiophjklnm67890";
function panForChar(ch) {
  if (ch == null) return (Math.random() - 0.5) * 0.4;
  const c = ch.toLowerCase();
  if (c === " ") return (Math.random() - 0.5) * 0.15;
  const li = _PAN_LEFT.indexOf(c);
  if (li >= 0) return clamp(-0.6 + (li / _PAN_LEFT.length) * 0.4 + (Math.random() - 0.5) * 0.1, -0.7, 0.7);
  const ri = _PAN_RIGHT.indexOf(c);
  if (ri >= 0) return clamp( 0.2 + (ri / _PAN_RIGHT.length) * 0.4 + (Math.random() - 0.5) * 0.1, -0.7, 0.7);
  return (Math.random() - 0.5) * 0.5;
}

// Top English digraphs that roll fast on QWERTY because of finger
// alternation or natural sequencing. Hitting one drops the next
// inter-keystroke interval to ~70 % of the gaussian mean — the same
// burst you get when a real typist hits "the" or "and".
const FAST_PAIRS = new Set([
  "th", "he", "in", "er", "an", "re", "nd", "ed", "ou", "ha",
  "to", "or", "ne", "es", "is", "at", "on", "ti", "st", "en",
  "of", "it", "ar", "te", "se", "nt", "le", "ng", "me", "as",
  "hi", "wa", "ee", "ld", "ve", "co", "wi", "yo", "ro", "ti",
]);
// Awkward (often same-finger or cross-hand reach) digraphs that slow
// real typists down — the interval stretches ~30 %.
const SLOW_PAIRS = new Set([
  "rb", "ux", "py", "kt", "mp", "lp", "mb", "ml", "fk", "qy",
  "wq", "xz", "zx", "jh", "vc", "cv", "gb", "bg",
]);

// monkeytype-ish corpora and a character stream that the typist iterates.
const TOP_WORDS = (
  "the of to and a in is it you that he was for on are with as i his they " +
  "be at one have this from or had by not word but what some we can out other were all " +
  "there when up use your how said an each she which do their time if will way about many then " +
  "them write would like so these her long make thing see him two has look more day could go come " +
  "did number sound no most people my over know water than call first who may down side been now find"
).split(" ");

const PANGRAMS = [
  "the quick brown fox jumps over the lazy dog",
  "pack my box with five dozen liquor jugs",
  "how vexingly quick daft zebras jump",
  "sphinx of black quartz judge my vow",
  "the five boxing wizards jump quickly",
  "jackdaws love my big sphinx of quartz",
  "amazingly few discotheques provide jukeboxes",
];

const QUOTES = [
  "the only way to do great work is to love what you do",
  "imagination is more important than knowledge",
  "in the middle of difficulty lies opportunity",
  "simplicity is the ultimate sophistication",
  "stay hungry stay foolish",
  "do not go where the path may lead",
  "the future depends on what you do today",
  "what we know is a drop what we dont know is an ocean",
];

// Famous opening passages — the default typist material. Long enough that
// at 100 wpm each passage is one to three minutes of typing (giving you
// time to actually listen to the switch), recognizable enough that you
// know what you're hearing, and varied enough in vocabulary that the
// digraph distribution covers most of the keyboard. All lowercase, ASCII
// punctuation only — what the typist will literally type, key by key.
const PASSAGES = [
  // Jane Austen, Pride and Prejudice
  "it is a truth universally acknowledged, that a single man in possession " +
  "of a good fortune, must be in want of a wife. however little known the " +
  "feelings or views of such a man may be on his first entering a " +
  "neighbourhood, this truth is so well fixed in the minds of the " +
  "surrounding families, that he is considered the rightful property of " +
  "some one or other of their daughters.",

  // Charles Dickens, A Tale of Two Cities
  "it was the best of times, it was the worst of times, it was the age of " +
  "wisdom, it was the age of foolishness, it was the epoch of belief, it " +
  "was the epoch of incredulity, it was the season of light, it was the " +
  "season of darkness, it was the spring of hope, it was the winter of " +
  "despair, we had everything before us, we had nothing before us.",

  // Herman Melville, Moby-Dick
  "call me ishmael. some years ago, never mind how long precisely, having " +
  "little or no money in my purse, and nothing particular to interest me " +
  "on shore, i thought i would sail about a little and see the watery " +
  "part of the world. it is a way i have of driving off the spleen and " +
  "regulating the circulation.",

  // George Orwell, 1984
  "it was a bright cold day in april, and the clocks were striking " +
  "thirteen. winston smith, his chin nuzzled into his breast in an effort " +
  "to escape the vile wind, slipped quickly through the glass doors of " +
  "victory mansions, though not quickly enough to prevent a swirl of " +
  "gritty dust from entering along with him.",

  // F. Scott Fitzgerald, The Great Gatsby
  "in my younger and more vulnerable years my father gave me some advice " +
  "that i have been turning over in my mind ever since. whenever you feel " +
  "like criticizing anyone, he told me, just remember that all the people " +
  "in this world have not had the advantages that you have had.",

  // Abraham Lincoln, Gettysburg Address
  "four score and seven years ago our fathers brought forth on this " +
  "continent, a new nation, conceived in liberty, and dedicated to the " +
  "proposition that all men are created equal. now we are engaged in a " +
  "great civil war, testing whether that nation, or any nation so " +
  "conceived and so dedicated, can long endure.",

  // William Shakespeare, Hamlet
  "to be, or not to be, that is the question: whether tis nobler in the " +
  "mind to suffer the slings and arrows of outrageous fortune, or to take " +
  "arms against a sea of troubles, and by opposing end them. to die, to " +
  "sleep, no more; and by a sleep, to say we end the heart-ache and the " +
  "thousand natural shocks that flesh is heir to.",

  // Leo Tolstoy, Anna Karenina
  "happy families are all alike; every unhappy family is unhappy in its " +
  "own way. everything was in confusion in the oblonskys house. the wife " +
  "had discovered that the husband was carrying on an intrigue with the " +
  "french girl who had been a governess in their family, and she had " +
  "announced that she could not go on living in the same house with him.",

  // Marcus Aurelius, Meditations
  "you have power over your mind, not outside events. realize this, and " +
  "you will find strength. waste no more time arguing about what a good " +
  "man should be. be one. when you arise in the morning, think of what a " +
  "precious privilege it is to be alive, to breathe, to think, to enjoy, " +
  "to love.",

  // Robert Frost, The Road Not Taken
  "two roads diverged in a yellow wood, and sorry i could not travel both " +
  "and be one traveler, long i stood and looked down one as far as i " +
  "could to where it bent in the undergrowth. then took the other, as " +
  "just as fair, and having perhaps the better claim, because it was " +
  "grassy and wanted wear.",
];

// returns { next() → char | null } — `null` means random (no char to type)
function makeTextStream(mode) {
  if (mode === "random") return { next: () => null };
  let pending = "";
  let cycleIdx = 0;
  function refill() {
    if (mode === "passages") {
      pending += PASSAGES[cycleIdx++ % PASSAGES.length] + "  ·  ";
    } else if (mode === "words") {
      const n = 4 + Math.floor(Math.random() * 5);
      const w = [];
      for (let i = 0; i < n; i++) {
        w.push(TOP_WORDS[Math.floor(Math.random() * TOP_WORDS.length)]);
      }
      pending += w.join(" ") + " ";
    } else if (mode === "pangrams") {
      pending += PANGRAMS[cycleIdx++ % PANGRAMS.length] + "  ·  ";
    } else if (mode === "quotes") {
      pending += QUOTES[cycleIdx++ % QUOTES.length] + "  ·  ";
    } else {
      pending += " ";
    }
  }
  refill();
  return {
    next() {
      if (!pending) refill();
      const c = pending[0];
      pending = pending.slice(1);
      return c;
    },
  };
}

function appendTypedChar(c) {
  if (c == null) return;
  state.typedChars.push({ c, t: performance.now() });
  if (state.typedChars.length > 300) state.typedChars.shift();
}

// Letters live on their own canvas with the *same* width and time-to-x
// mapping as the keystroke waveform canvas below — so every letter sits
// directly above its waveform spike, 1:1. Letters expire after the same
// VIZ_WINDOW_MS as the spikes, so stopping the typist makes both drift
// off the left edge together.
function drawTypingText() {
  const c = $("typist-text");
  if (!c) return;
  const g = c.getContext("2d");
  function frame() {
    const dpr = sizeCanvas(c);
    const W = c.width, H = c.height;
    g.fillStyle = COL_BG; g.fillRect(0, 0, W, H);
    // matching second markers — same divisions as the viz below
    g.strokeStyle = COL_GRID; g.lineWidth = 1;
    for (let s = 0; s <= 5; s++) {
      const x = W - (s / 5) * W;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
    }
    const now = performance.now();
    state.typedChars = state.typedChars.filter((ch) => (now - ch.t) < VIZ_WINDOW_MS);
    g.font = `${20 * dpr}px "IBM Plex Mono", monospace`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    // The keystroke pulse is drawn with mini[0] (the down-click — the
    // loudest, leftmost spike) at x = pulseCenter − spanPx/2.  Shift the
    // letter to that same x so it sits directly above the down-click
    // instead of the visual center of the envelope.
    const downShift = (VIZ_PULSE_SPAN_PX * dpr) / 2;
    for (const ch of state.typedChars) {
      const age = (now - ch.t) / VIZ_WINDOW_MS;
      const x = W - age * W - downShift;
      const fade = 1 - age * 0.55;
      const isSpace = ch.c === " ";
      g.fillStyle = isSpace
        ? withAlpha(COL_INK_DIM, fade * 0.5)
        : withAlpha(COL_INK, fade);
      g.fillText(isSpace ? "·" : ch.c, x, H / 2 + 1 * dpr);
    }
    requestAnimationFrame(frame);
  }
  frame();
}

// Schedule audio playback and the visual pulse at the same wall-clock
// instant so they arrive together — no setTimeout race against the
// audio thread.
function schedulePulse(audioTime, switchName, mini, char) {
  const ctx = state.audioCtx;
  const delay = Math.max(0, (audioTime - ctx.currentTime) * 1000);
  setTimeout(() => {
    state.typingPulses.push({ t: performance.now(), name: switchName, mini });
    if (state.typingPulses.length > 240) state.typingPulses.shift();
    flashSwitchTile(switchName);
    if (char != null) appendTypedChar(char);
  }, delay);
}

function flashSwitchTile(name) {
  document.querySelectorAll(`.switch-tile[data-name="${CSS.escape(name)}"]`)
    .forEach((tile) => {
      tile.classList.remove("pulse");
      // reflow so the animation re-runs
      void tile.offsetWidth;
      tile.classList.add("pulse");
    });
}

function drawTypingViz() {
  const c = $("typist-viz");
  if (!c) return;
  const g = c.getContext("2d");
  function frame() {
    const dpr = sizeCanvas(c);
    const W = c.width, H = c.height, half = H / 2;
    g.fillStyle = COL_BG; g.fillRect(0, 0, W, H);

    // second markers
    g.strokeStyle = COL_GRID; g.lineWidth = 1;
    for (let s = 0; s <= 5; s++) {
      const x = W - (s / 5) * W;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
    }
    g.strokeStyle = COL_GRID_2;
    g.beginPath(); g.moveTo(0, half); g.lineTo(W, half); g.stroke();
    g.fillStyle = COL_INK_MUTE;
    g.font = `${10 * dpr}px "IBM Plex Mono", monospace`;
    for (let s = 1; s <= 5; s++) {
      const x = W - (s / 5) * W;
      g.fillText(`-${s}s`, x + 4 * dpr, H - 6 * dpr);
    }

    const now = performance.now();
    state.typingPulses = state.typingPulses.filter((p) => (now - p.t) < VIZ_WINDOW_MS);
    const spanPx = VIZ_PULSE_SPAN_PX * dpr;
    for (const p of state.typingPulses) {
      const age = (now - p.t) / VIZ_WINDOW_MS;
      const x = W - age * W;
      const fade = 1 - age * 0.55;
      const col = colorForSwitch(p.name);
      g.beginPath();
      const len = p.mini.length;
      for (let i = 0; i < len; i++) {
        const px = x - spanPx / 2 + (i / (len - 1)) * spanPx;
        const py = half - p.mini[i] * half * 0.92;
        if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      for (let i = len - 1; i >= 0; i--) {
        const px = x - spanPx / 2 + (i / (len - 1)) * spanPx;
        const py = half + p.mini[i] * half * 0.92;
        g.lineTo(px, py);
      }
      g.closePath();
      g.fillStyle = withAlpha(col, 0.42 * fade); g.fill();
      g.strokeStyle = withAlpha(col, fade);
      g.lineWidth = 1 * dpr;
      g.stroke();
    }
    requestAnimationFrame(frame);
  }
  frame();
}


// ============== ui render: scope, switches, tiles, status ==========

function setStatus(s) { $("status-text").textContent = s; }

function setPrimary(mode) {
  const b = $("primary");
  b.classList.remove("armed", "busy");
  if (mode === "enable")         b.textContent = "enable mic";
  else if (mode === "calibrate") b.textContent = "▶ calibrate switch";
  else if (mode === "arm")       b.textContent = "▶ start";
  else if (mode === "armed")     { b.textContent = "■ stop"; b.classList.add("armed"); }
}

// The primary button is a chameleon — its action depends on what the
// user still needs to do. Calibration is the precondition for freeform
// capture: without a learned template we don't know what a press of
// this switch sounds like, so triggering on broadband peaks alone is
// guesswork. Walk the prerequisites in order.
function currentPrimaryMode() {
  if (state.armed) return "armed";
  if (!state.audioCtx || !state.stream) return "enable";
  // no switch selected → arm() will alert and tell them to make one;
  // we still show "enable mic" as the next visible action.
  if (!state.currentSwitch) return "enable";
  if (!state.switchTemplates.has(state.currentSwitch)) return "calibrate";
  return "arm";
}

function refreshPrimary() {
  setPrimary(currentPrimaryMode());
  const recal = $("guided-btn");
  if (!recal) return;
  if (state.currentSwitch && state.switchTemplates.has(state.currentSwitch)) {
    recal.classList.remove("hidden");
    recal.textContent = "re-calibrate";
  } else {
    recal.classList.add("hidden");
  }
}

function renderScope() {
  const c = $("scope");
  const g = c.getContext("2d");
  function frame() {
    const dpr = sizeCanvas(c);
    const W = c.width, H = c.height, half = H / 2;
    g.fillStyle = COL_BG; g.fillRect(0, 0, W, H);

    // second markers — show 3 s window
    g.strokeStyle = COL_GRID; g.lineWidth = 1;
    for (let s = 0; s <= 3; s++) {
      const x = W - (s / 3) * W;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
    }
    g.strokeStyle = COL_GRID_2;
    g.beginPath(); g.moveTo(0, half); g.lineTo(W, half); g.stroke();

    if (state.env) {
      const env = state.env, events = state.envEvents;
      const N = env.length;
      const barW = W / N;
      const start = state.envWrite;
      for (let i = 0; i < N; i++) {
        const idx = (start + i) % N;
        const v = env[idx];
        const hh = Math.min(half, v * half);
        const x = i * barW;
        g.fillStyle = events[idx]
          ? COL_ACCENT
          : state.armed ? COL_INK : COL_INK_MUTE;
        g.fillRect(x, half - hh, Math.max(1, barW), hh * 2);
      }
    }

    const thr = state.autoThreshold;
    const noise = state.floorEMA;
    g.strokeStyle = withAlpha(COL_ACCENT, 0.5);
    g.beginPath();
    g.moveTo(0, half - thr * half); g.lineTo(W, half - thr * half);
    g.moveTo(0, half + thr * half); g.lineTo(W, half + thr * half);
    g.stroke();
    g.strokeStyle = withAlpha(COL_INK_DIM, 0.35);
    g.beginPath();
    g.moveTo(0, half - noise * half); g.lineTo(W, half - noise * half);
    g.moveTo(0, half + noise * half); g.lineTo(W, half + noise * half);
    g.stroke();

    const db = state.audioCtx ? linToDb(state.level) : -120;
    const lin = clamp((db + 60) / 60, 0, 1);
    $("level-fill").style.width = (lin * 100) + "%";
    $("level-db").textContent = state.audioCtx ? `${db.toFixed(0)} dB` : "— dB";
    $("meta-floor").textContent = state.audioCtx ? state.floorEMA.toFixed(3) : "—";

    requestAnimationFrame(frame);
  }
  frame();
}

// Build a switch tile as a div+role=button so it can host an inner color
// swatch button without nested-button HTML weirdness. The CSS custom
// property --c carries the switch's color into the stylesheet.
function makeSwitchTile(sw, isActive, onSelect) {
  const tile = document.createElement("div");
  tile.className = "switch-tile" + (isActive ? " active" : "");
  tile.setAttribute("role", "button");
  tile.setAttribute("tabindex", "0");
  tile.dataset.name = sw.name;
  const color = colorForSwitch(sw.name);
  tile.style.setProperty("--c", color);
  tile.innerHTML = `
    <button class="swatch" type="button" aria-label="change color"></button>
    <span class="name">${sw.name}</span>
    <span class="ct">${sw.count}</span>
  `;
  tile.addEventListener("click", (e) => {
    if (e.target.closest(".swatch")) return;
    onSelect();
  });
  tile.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(); }
  });
  tile.querySelector(".swatch").addEventListener("click", (e) => {
    e.stopPropagation();
    openColorPicker(sw.name, e.currentTarget);
  });
  return tile;
}

function renderSwitchRow() {
  const row = $("switch-row");
  row.innerHTML = "";
  if (state.switches.length === 0) {
    const e = document.createElement("div");
    e.className = "switch-empty";
    e.textContent = "no switches yet — create one";
    row.appendChild(e);
    return;
  }
  for (const sw of state.switches) {
    row.appendChild(makeSwitchTile(sw, sw.name === state.currentSwitch, () => selectSwitch(sw.name)));
  }
}

function updateTypingButtons() {
  const box = $("typist-switches");
  if (!box) return;
  box.innerHTML = "";
  const switches = state.switches.filter((s) => s.count > 0);
  if (!switches.length) return;
  for (const sw of switches) {
    box.appendChild(makeSwitchTile(sw, sw.name === state.typingSwitch, () => setTypingSwitch(sw.name)));
  }
}

function openColorPicker(name, anchor) {
  closeColorPicker();
  const pop = document.createElement("div");
  pop.className = "color-popover";
  for (const c of COLOR_PALETTE) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "color-swatch";
    b.style.background = c;
    if (colorForSwitch(name).toLowerCase() === c.toLowerCase()) b.classList.add("active");
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      setSwitchColor(name, c);
      closeColorPicker();
    });
    pop.appendChild(b);
  }
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.top  = (r.bottom + 6 + window.scrollY) + "px";
  pop.style.left = Math.max(8, r.left + window.scrollX - 4) + "px";
  state.colorPopover = pop;
  // close on outside-click on the next tick
  setTimeout(() => document.addEventListener("mousedown", outsideClickClose, true), 0);
}

function outsideClickClose(e) {
  if (state.colorPopover && !state.colorPopover.contains(e.target)) closeColorPicker();
}

function closeColorPicker() {
  document.removeEventListener("mousedown", outsideClickClose, true);
  if (state.colorPopover) {
    state.colorPopover.remove();
    state.colorPopover = null;
  }
}

function sortedTiles() {
  const order = $("order").value;
  const arr = state.switchSamples.slice();
  const peak = (t) => t.meta ? t.meta.peak : -1;
  if (order === "amplitude-asc")  arr.sort((a, b) => peak(a) - peak(b));
  else if (order === "amplitude-desc") arr.sort((a, b) => peak(b) - peak(a));
  else if (order === "random") arr.sort(() => Math.random() - 0.5);
  return arr;
}

function renderTiles() {
  const grid = $("sample-grid");
  grid.innerHTML = "";
  for (const t of sortedTiles()) {
    const el = document.createElement("div");
    el.className = "tile";
    el.dataset.key = t.key;
    if (!t.meta) el.classList.add("pending");
    if (state.activeSample && state.activeSample.key === t.key) el.classList.add("active");
    const c = document.createElement("canvas");
    c.width = 220; c.height = 30;
    el.appendChild(c);
    const label = document.createElement("div");
    label.className = "label";
    const peakTxt = t.meta ? t.meta.peak.toFixed(2) : "…";
    label.innerHTML = `<span>${t.file.slice(9, 15)}</span><span>${peakTxt}</span>`;
    el.appendChild(label);
    el.addEventListener("click", () => selectSample(t));
    grid.appendChild(el);
    if (t.meta) requestAnimationFrame(() => drawMini(c, t));
  }
}

async function selectSample(t) {
  state.activeSample = t;
  $("detail-title").textContent = `${t.switch} / ${t.file}`;
  document.querySelectorAll(".tile").forEach((el) => {
    el.classList.toggle("active", el.dataset.key === t.key);
  });
  if (!t.meta) {
    $("detail-info").textContent = "loading…";
    try { await ensureSampleMeta(t); }
    catch (e) { $("detail-info").textContent = "decode failed: " + e.message; return; }
  }
  $("detail-info").textContent =
    `${t.meta.buf.duration.toFixed(3)} s · ${t.meta.buf.sampleRate} Hz · ` +
    `peak ${t.meta.peak.toFixed(3)} · rms ${t.meta.rms.toFixed(3)}`;
  drawDetailWave(t);
  drawDetailFFT(t);
  drawDetailSpectrogram(t);
}

function playSampleNow(t) {
  if (!t.meta) return;
  const src = state.audioCtx.createBufferSource();
  src.buffer = t.meta.buf;
  src.connect(state.audioCtx.destination);
  src.start();
}

async function deleteActive() {
  if (!state.activeSample) return;
  if (!confirm(`remove ${state.activeSample.file}?`)) return;
  try { await fsDeleteSample(state.activeSample.switch, state.activeSample.file); }
  catch (e) { alert("delete failed: " + e.message); return; }
  state.samplesCache.delete(state.activeSample.key);
  state.activeSample = null;
  $("detail-title").textContent = "— select a sample —";
  $("detail-info").textContent = "";
  clearCanvas("detail-wave");
  clearCanvas("detail-fft");
  clearCanvas("detail-spec");
  await refreshSwitches();
  if (state.currentSwitch) await loadSwitchSamples(state.currentSwitch);
}

// ============== presets ============================================
//
// Curated keyswitch datasets hosted as static files alongside the app.
// /presets/index.json lists them; /presets/<id>/<file>.wav are the WAVs.
// Importing copies each WAV into the user's storage as a new switch.

async function openPresetsDialog() {
  const list = $("presets-list");
  list.innerHTML = '<div class="dim">loading…</div>';
  $("presets-dialog").showModal();
  let presets = null;
  try {
    const r = await fetch("/presets/index.json", { cache: "no-store" });
    if (r.ok) presets = await r.json();
  } catch (_) { /* network or 404 — show empty */ }
  if (!Array.isArray(presets) || presets.length === 0) {
    list.innerHTML = '<div class="dim">no presets available yet.<br>check back soon.</div>';
    return;
  }
  list.innerHTML = "";
  for (const p of presets) {
    const el = document.createElement("div");
    el.className = "preset-item";
    el.style.setProperty("--c", p.color || "#f5a623");
    el.innerHTML = `
      <div class="preset-dot"></div>
      <div class="preset-info">
        <div class="preset-name"></div>
        <div class="preset-desc"></div>
      </div>
      <div class="preset-count"></div>
      <button class="action small" type="button">import</button>
    `;
    el.querySelector(".preset-name").textContent = p.name || p.id;
    el.querySelector(".preset-desc").textContent = p.description || "";
    el.querySelector(".preset-count").textContent = `${(p.files || []).length} samples`;
    el.querySelector("button").addEventListener("click", () => importPreset(p, el));
    list.appendChild(el);
  }
}

async function importPreset(preset, itemEl) {
  if (!state.storageHandle) {
    $("presets-dialog").close();
    showStorageGate(state.storageName);
    return;
  }
  if (!Array.isArray(preset.files) || preset.files.length === 0) {
    setStatus("preset has no files");
    return;
  }
  itemEl.classList.add("importing");
  const btn = itemEl.querySelector("button");
  btn.disabled = true;
  const swName = preset.id;
  let done = 0;
  try {
    const dir = await state.storageHandle.getDirectoryHandle(swName, { create: true });
    for (const file of preset.files) {
      const r = await fetch(`/presets/${encodeURIComponent(swName)}/${encodeURIComponent(file)}`);
      if (!r.ok) throw new Error("HTTP " + r.status);
      const ab = await r.arrayBuffer();
      const fh = await dir.getFileHandle(file, { create: true });
      const w = await fh.createWritable();
      await w.write(ab);
      await w.close();
      done++;
      btn.textContent = `${done}/${preset.files.length}`;
    }
    if (preset.color) setSwitchColor(swName, preset.color);
    $("presets-dialog").close();
    setStatus(`imported ${preset.name || swName} · ${done} samples`);
    await refreshSwitches();
    await selectSwitch(swName);
  } catch (e) {
    console.error("import failed", e);
    btn.textContent = "retry";
    btn.disabled = false;
    setStatus("import failed: " + e.message);
  } finally {
    itemEl.classList.remove("importing");
  }
}

async function removeCurrentSwitch() {
  const sw = state.currentSwitch;
  if (!sw) return;
  if (!confirm(`remove switch '${sw}' and all of its samples? this cannot be undone.`)) return;
  try { await fsDeleteSwitch(sw); }
  catch (e) { alert("remove failed: " + e.message); return; }

  state.switches = state.switches.filter((s) => s.name !== sw);
  state.switchProfiles.delete(sw);
  state.switchColors.delete(sw);
  try { localStorage.setItem("thock.colors", JSON.stringify([...state.switchColors])); }
  catch (_) { /* ignore */ }

  const prefix = `${sw}::`;
  for (const k of Array.from(state.samplesCache.keys())) {
    if (k.startsWith(prefix)) state.samplesCache.delete(k);
  }

  state.activeSample = null;
  $("detail-title").textContent = "— select a sample —";
  $("detail-info").textContent = "";
  clearCanvas("detail-wave"); clearCanvas("detail-fft"); clearCanvas("detail-spec");

  state.currentSwitch = state.switches.length ? state.switches[0].name : null;
  state.typingSwitch = state.currentSwitch;
  renderSwitchRow();
  updateTypingButtons();
  if (state.currentSwitch) {
    await loadSwitchSamples(state.currentSwitch);
  } else {
    $("fp-name").textContent = "—";
    $("fp-meta").textContent = "";
    state.switchSamples = [];
    renderTiles();
    drawFingerprint(null);
  }
  setStatus(`removed · ${sw}`);
}

async function deleteAllInSwitch() {
  const sw = state.currentSwitch;
  if (!sw) return;
  if (!confirm(`remove every sample in '${sw}'?`)) return;
  try { await fsDeleteSwitch(sw); }
  catch (e) { alert("delete failed: " + e.message); return; }
  const prefix = `${sw}::`;
  for (const k of Array.from(state.samplesCache.keys())) {
    if (k.startsWith(prefix)) state.samplesCache.delete(k);
  }
  state.switchProfiles.delete(sw);
  state.activeSample = null;
  $("detail-title").textContent = "— select a sample —";
  $("detail-info").textContent = "";
  clearCanvas("detail-wave"); clearCanvas("detail-fft"); clearCanvas("detail-spec");
  await refreshSwitches();
  if (!state.switches.find((s) => s.name === sw)) {
    state.switches.push({ name: sw, samples: [], count: 0 });
    state.switches.sort((a, b) => a.name.localeCompare(b.name));
    state.currentSwitch = sw;
    renderSwitchRow();
  }
  await loadSwitchSamples(sw);
}


// ============== wiring + init ======================================

function wire() {
  $("primary").addEventListener("click", async () => {
    const mode = currentPrimaryMode();
    if (mode === "enable") {
      try { await enableMic(); }
      catch (e) { console.error(e); setStatus("mic error: " + e.message); }
      return;
    }
    if (mode === "calibrate") {
      if (!state.currentSwitch) { alert("create or select a switch first"); return; }
      startGuided().catch((e) => { console.error(e); setStatus("calibrate failed: " + e.message); });
      return;
    }
    if (mode === "armed") {
      disarm();
      return;
    }
    arm().catch((e) => { console.error(e); setStatus("arm error: " + e.message); });
  });

  $("new-switch").addEventListener("click", () => {
    const d = $("new-switch-dialog");
    $("new-switch-name").value = "";
    d.showModal();
    setTimeout(() => $("new-switch-name").focus(), 0);
  });
  $("new-switch-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); $("new-switch-dialog").close("ok"); }
    else if (e.key === "Escape") { e.preventDefault(); $("new-switch-dialog").close("cancel"); }
  });
  $("new-switch-cancel").addEventListener("click", () => $("new-switch-dialog").close("cancel"));
  $("new-switch-dialog").addEventListener("close", async () => {
    try {
      const d = $("new-switch-dialog");
      if (d.returnValue !== "ok") return;
      const name = $("new-switch-name").value.trim();
      if (!name) return;
      if (!/^[A-Za-z0-9._-]+$/.test(name)) {
        alert("invalid name — use letters, digits, dot, dash, underscore");
        return;
      }
      if (!state.switches.find((s) => s.name === name)) {
        state.switches.push({ name, samples: [], count: 0 });
        state.switches.sort((a, b) => a.name.localeCompare(b.name));
      }
      state.currentSwitch = name;
      renderSwitchRow();
      updateTypingButtons();
      await loadSwitchSamples(name);
    } catch (e) {
      console.error("new-switch failed", e);
      setStatus("new-switch failed: " + e.message);
    }
  });

  $("order").addEventListener("change", () => renderTiles());
  $("delete-all-btn").addEventListener("click", () => deleteAllInSwitch());
  $("detail-play").addEventListener("click", () => state.activeSample && playSampleNow(state.activeSample));
  $("detail-delete").addEventListener("click", () => deleteActive());

  $("type-start").addEventListener("click", () => {
    startTyping().catch((e) => { console.error(e); setStatus("typing error: " + e.message); });
  });
  $("type-stop").addEventListener("click", stopTyping);


  $("remove-switch-btn").addEventListener("click", () => removeCurrentSwitch());

  $("presets-btn").addEventListener("click", () => openPresetsDialog());
  $("presets-close").addEventListener("click", () => $("presets-dialog").close());

  // fft settings — power-user controls; absent from the default DOM, but
  // settable via console (`state.fft.window = 'hann'; refreshFftViews()`)
  // or by adding the picker elements back.
  if ($("fp-window")) {
    $("fp-window").addEventListener("change", () => {
      state.fft.window = $("fp-window").value; saveFftSettings(); refreshFftViews();
    });
  }
  if ($("fp-scale")) {
    $("fp-scale").addEventListener("change", () => {
      state.fft.scale = $("fp-scale").value; saveFftSettings(); refreshFftViews();
    });
  }

  const setupAfter = async () => {
    await refreshSwitches();
    if (state.currentSwitch) await loadSwitchSamples(state.currentSwitch);
  };

  $("guided-btn").addEventListener("click", () => {
    startGuided().catch((e) => {
      console.error("guided failed", e);
      setStatus("guided failed: " + e.message);
    });
  });
  $("guided-cancel").addEventListener("click", cancelGuided);
  $("guided-skip").addEventListener("click", skipGuidedPhase);

  $("storage-btn").addEventListener("click", () => showStorageGate(state.storageName));
  $("storage-pick").addEventListener("click", () => {
    pickStorage().then(setupAfter)
      .catch((e) => { if (e.name !== "AbortError") setStatus("picker failed: " + e.message); });
  });
  $("storage-opfs").addEventListener("click", () => {
    useOpfsStorage().then(setupAfter)
      .catch((e) => setStatus("browser storage failed: " + e.message));
  });
}

function showStorageGate(prevName) {
  $("storage-gate").classList.remove("hidden");
  $("storage-prev-name").textContent = prevName || "—";
  $("storage-gate-sub").style.display = prevName ? "" : "none";
  // hide whichever backend this browser doesn't expose
  $("storage-pick").classList.toggle("hidden", !pickerSupported());
  $("storage-opfs").classList.toggle("hidden", !opfsSupported());
  $("storage-btn").textContent = "no folder";
  $("storage-btn").classList.add("needs-folder");
}

function hideStorageGate() {
  $("storage-gate").classList.add("hidden");
  $("storage-btn").textContent = state.storageName || "folder";
  $("storage-btn").classList.remove("needs-folder");
}

function refreshFftViews() {
  if (state.currentSwitch) {
    const profile = computeSwitchProfile(state.currentSwitch);
    state.switchProfiles.set(state.currentSwitch, profile);
    drawFingerprint(profile);
  } else {
    drawFingerprint(null);
  }
  if (state.activeSample && state.activeSample.meta) drawDetailFFT(state.activeSample);
}

async function init() {
  syncPalette();
  loadSwitchColors();
  loadSwitchDwells();
  loadSwitchTemplates();
  loadFftSettings();
  wire();
  refreshPrimary();
  if ($("fp-window")) $("fp-window").value = state.fft.window;
  if ($("fp-scale"))  $("fp-scale").value  = state.fft.scale;
  renderScope();
  drawTypingViz();
  drawTypingText();

  if (!fsSupported()) {
    showStorageGate(null);
    setStatus("no storage backend available in this browser");
    return;
  }
  const resumed = await tryResumeStorage();
  if (resumed === true) {
    hideStorageGate();
    setStatus(`storage · ${state.storageName} · click 'enable mic' to begin`);
  } else if (resumed && resumed.needsGesture) {
    showStorageGate(resumed.handle.name);
    setStatus("previous folder needs permission — click 'choose folder'");
    // reusing the same handle is fine on the next user gesture
    $("storage-pick").addEventListener("click", async function once() {
      $("storage-pick").removeEventListener("click", once, true);
      try { await requestStoragePermission(resumed.handle); }
      catch (_) { return; }
      await refreshSwitches();
      if (state.currentSwitch) await loadSwitchSamples(state.currentSwitch);
    }, { once: true, capture: true });
  } else {
    showStorageGate(null);
    setStatus("choose where samples live to begin");
  }

  await refreshSwitches();
  if (state.currentSwitch) {
    state.typingSwitch = state.currentSwitch;
    await loadSwitchSamples(state.currentSwitch);
  }
}

init().catch((e) => {
  console.error("init failed", e);
  setStatus("init failed — see console");
});
