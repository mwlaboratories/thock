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
      // Accept both .wav (user recordings) and .flac (library imports).
      // decodeAudioData handles both via the same code path downstream.
      if (fe.kind !== "file") continue;
      const lower = fn.toLowerCase();
      if (lower.endsWith(".wav") || lower.endsWith(".flac")) samples.push(fn);
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
  // 350 ms default. Per-switch calibration overrides this via
  // state.switchDwells (capped at 500 ms — wider was over-pairing
  // consecutive presses in normal typing).
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
  // Display metadata for switches (name, family, description) so the
  // main UI can show "Autumn" instead of the raw directory id
  // "chocv2_autumn". Populated when importing from the library;
  // user-created switches (via "+ new") have no entry and fall back
  // to their raw id.
  switchMeta: new Map(),

  // --- typist ---
  // Live-fetched article passages from libertis.net (or null if the
  // fetch failed). makeTextStream falls back to the bundled PASSAGES
  // when this is missing.
  articles: null,
  typingActive: false, typingStop: null, typingSwitch: null,
  // play-all loop state: { active: bool } when running, null when not
  playAll: null,
  typingPulses: [],
  typedChars: [],

  // Master output bus + filter chain for room/mic-position presets.
  // Wired up by ensureAudioCtx() on first audio unlock.
  audioOut: null, roomHP: null, roomLS: null, roomPeak: null,
  roomLP: null, roomHS: null,
  roomPreset: "raw",

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

// Palette tuned to read on BOTH light and dark surfaces — every entry
// sits around L*≈55–65 so the fingerprint curve, switch-name display,
// and chip text all have enough contrast against the near-white light
// theme AND the near-black dark theme. Also distinguishable for typical
// red-green colourblindness via differing lightness as well as hue.
// Ordered roughly along the spectrum so the picker scans naturally:
// warm → cool, then neutrals at the end.
const COLOR_PALETTE = [
  "#f5a623", // amber  (default accent)
  "#e67e22", // orange
  "#e25555", // coral
  "#c0392b", // crimson
  "#d63384", // pink
  "#a040b3", // magenta
  "#9472d8", // violet
  "#5b6acb", // indigo
  "#3d8be8", // sky
  "#2da8c0", // aqua
  "#0f9c8e", // teal
  "#2e9d6c", // emerald
  "#3f9550", // forest green
  "#7a8a30", // olive
  "#b78d2a", // mustard
  "#a05a2c", // brown
  "#7c8590", // slate
  "#5a6470", // charcoal
];

// Earlier palette had four colours (ivory / lime / mint / teal) that
// were L≈80+ and disappeared on the light theme's near-white surface.
// Any switch whose stored colour matches a retired entry gets remapped
// at load time to its lightness-corrected replacement — saves the user
// from re-picking after the palette update.
const RETIRED_COLOR_MAP = {
  "#e8e6e0": "#a05a2c", // ivory → brown
  "#d4e642": "#b78d2a", // lime → mustard
  "#7dd87d": "#3f9550", // mint → forest green
  "#2dd4bf": "#0f9c8e", // washed teal → darker teal
  "#ff6b6b": "#e25555", // washed coral → readable coral
  "#5ba8ff": "#3d8be8", // washed sky → readable sky
  "#b18cff": "#9472d8", // washed violet → readable violet
  "#ec4899": "#d63384", // washed pink → readable pink
};

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
  // Migrate retired colours forward so old assignments stay readable.
  let migrated = false;
  for (const [name, color] of state.switchColors) {
    const lower = (color || "").toLowerCase();
    if (RETIRED_COLOR_MAP[lower]) {
      state.switchColors.set(name, RETIRED_COLOR_MAP[lower]);
      migrated = true;
    }
  }
  if (migrated) {
    try { localStorage.setItem("thock.colors", JSON.stringify([...state.switchColors])); }
    catch (_) { /* ignore */ }
  }
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

// Reset & open the new-switch dialog. Clears all fields so the modal
// always starts fresh; auto-id derivation from name kicks back in.
function openNewSwitchDialog() {
  for (const id of ["new-switch-id", "new-switch-name", "new-switch-family", "new-switch-desc"]) {
    const el = $(id);
    if (el) el.value = "";
  }
  $("new-switch-id").dataset.touched = "";
  $("new-switch-dialog").showModal();
  setTimeout(() => $("new-switch-name").focus(), 0);
}

// Turn a display name into a filesystem-safe id slug. Lowercase,
// non-alphanumerics → underscore, collapsed runs.
function _slugifyId(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_{2,}/g, "_");
}

function setSwitchMeta(id, meta) {
  state.switchMeta.set(id, meta);
  try {
    localStorage.setItem("thock.switchMeta", JSON.stringify([...state.switchMeta]));
  } catch (_) { /* private mode etc */ }
}

function loadSwitchMeta() {
  try {
    const raw = localStorage.getItem("thock.switchMeta");
    if (raw) state.switchMeta = new Map(JSON.parse(raw));
  } catch (_) { /* malformed → start fresh */ }
}

// Travel viz: the description carries "<pre> / <total> mm" at the
// end (set by the library catalogue). Pull those out for the small
// bar graph rendered next to the switch name.
function parseTravel(desc) {
  if (!desc) return null;
  const m = /([\d.]+)\s*\/\s*([\d.]+)\s*mm/.exec(desc);
  if (!m) return null;
  const pre = parseFloat(m[1]);
  const total = parseFloat(m[2]);
  if (!isFinite(pre) || !isFinite(total) || total <= 0) return null;
  return { pre, total };
}

// Vertical key-travel viz for the fingerprint header. The bar is
// anchored at the BOTTOM of the SVG — the switch sits on the PCB
// like a real one, the colour fills upward by total travel, and
// the top of the bar is where the keycap rests. Background
// hairline runs the full 0–3.5 mm domain so a low-profile switch
// with little travel reads as 'short, anchored at the floor' next
// to standards that reach further up. Horizontal tick sits inside
// the bar at the actuation depth (pre-travel below the rest).
function travelVizSVG(pre, total, titleText) {
  const MAX = 3.5;
  const W = 18;
  const H = 56;
  const padY = 4;
  const usable = H - 2 * padY;
  const yBottom = H - padY;
  const barH = Math.max(0, Math.min(1, total / MAX)) * usable;
  const yTopBar = yBottom - barH;
  // Actuation tick: pre mm below the top of the bar (rest pos).
  // Equivalent to (total - pre) mm above bottom-out.
  const yPre = yBottom - Math.max(0, Math.min(1, (total - pre) / MAX)) * usable;
  const cx = W / 2;
  return `<svg class="travel-viz-v" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"`
    + ` role="img" aria-label="${titleText}"><title>${titleText}</title>`
    + `<line class="tv-bg" x1="${cx}" y1="${padY}" x2="${cx}" y2="${yBottom}"/>`
    + `<line class="tv-total" x1="${cx}" y1="${yTopBar}" x2="${cx}" y2="${yBottom}" stroke="var(--c, #999)"/>`
    + `<line class="tv-actuation" x1="${cx - 6}" y1="${yPre}" x2="${cx + 6}" y2="${yPre}" stroke="var(--c, #999)"/>`
    + `</svg>`;
}

// Display name for a switch: library-provided name if imported, else
// the raw directory id (which is also what the user typed if they
// created the switch themselves via "+ new").
function displayName(id) {
  if (!id) return "—";
  const m = state.switchMeta.get(id);
  return (m && m.name) ? m.name : id;
}

// Render the vertical travel viz next to the fingerprint name.
// Slot stays empty for switches without a parseable description
// (user-recorded, no library meta).
function renderFingerprintTravel(id) {
  const el = $("fp-travel");
  if (!el) return;
  el.innerHTML = "";
  if (!id) return;
  const m = state.switchMeta.get(id);
  const travel = parseTravel(m && m.description);
  if (!travel) return;
  el.style.setProperty("--c", colorForSwitch(id));
  el.innerHTML = travelVizSVG(
    travel.pre, travel.total,
    `actuates at ${travel.pre} mm, bottoms out at ${travel.total} mm`,
  );
}

// Render the family + type + weight tags next to the fingerprint name.
// Pulled from switchMeta. The tags inherit the switch's color so
// "Cherry MX Blue" and "Choc v2 Blue" stay visually distinct even
// without reading the text.
function renderFingerprintTags(id) {
  const el = $("fp-tags");
  if (!el) return;
  el.innerHTML = "";
  if (!id) return;
  const m = state.switchMeta.get(id) || {};
  const descParts = (m.description || "").split("·").map((s) => s.trim()).filter(Boolean);
  const bits = [];
  if (m.family) bits.push(m.family);
  for (const p of descParts) bits.push(p);
  if (!bits.length) return;
  const color = colorForSwitch(id);
  el.style.setProperty("--fp-color", color);
  for (const b of bits) {
    const t = document.createElement("span");
    t.className = "fp-tag";
    t.textContent = b;
    el.appendChild(t);
  }
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

  // Master playback bus. All audio sources (typist, inspect ▶ play,
  // ▶ play all) feed audioOut instead of ctx.destination directly so
  // the room / housing EQ can be applied uniformly.
  //
  // Chain: audioOut → HP → LS → Peak → LP → HS → destination
  //   HP    — high-pass, kills the close-mic plate-vibration rumble
  //   LS    — low-shelf, sculpts the thock body weight
  //   Peak  — peaking filter, dials in housing resonance / hollow ring
  //   LP    — low-pass, sets how much HF survives the distance
  //   HS    — high-shelf, fine-tunes the upper-mid sparkle
  // The default preset ('raw') leaves every stage flat / wide so the
  // bypass case really is bypass.
  state.audioOut = ctx.createGain();
  state.roomHP = ctx.createBiquadFilter();
  state.roomHP.type = "highpass";
  state.roomHP.frequency.value = 20;
  state.roomHP.Q.value = 0.707;
  state.roomLS = ctx.createBiquadFilter();
  state.roomLS.type = "lowshelf";
  state.roomLS.frequency.value = 200;
  state.roomLS.gain.value = 0;
  state.roomPeak = ctx.createBiquadFilter();
  state.roomPeak.type = "peaking";
  state.roomPeak.frequency.value = 1000;
  state.roomPeak.Q.value = 1;
  state.roomPeak.gain.value = 0;
  state.roomLP = ctx.createBiquadFilter();
  state.roomLP.type = "lowpass";
  state.roomLP.frequency.value = ctx.sampleRate / 2;
  state.roomLP.Q.value = 0.707;
  state.roomHS = ctx.createBiquadFilter();
  state.roomHS.type = "highshelf";
  state.roomHS.frequency.value = 2500;
  state.roomHS.gain.value = 0;
  state.audioOut
    .connect(state.roomHP)
    .connect(state.roomLS)
    .connect(state.roomPeak)
    .connect(state.roomLP)
    .connect(state.roomHS)
    .connect(ctx.destination);

  // Re-apply the last preset choice (might have been set before
  // audio was unlocked).
  applyRoomPreset(state.roomPreset || "raw");
  return ctx;
}

// EQ presets — biquad chain values tuned against documented
// practice from film sound design + room acoustics literature,
// not pure guesswork. Each preset shapes:
//
//   hp       high-pass cutoff (Hz)           kills close-mic plate rumble
//   ls       low-shelf gain (dB) / lsFreq    body weight
//   peak     peaking gain (dB) / peakFreq / peakQ   housing resonance
//   lp       low-pass cutoff (Hz)            distance / damping
//   hs       high-shelf gain (dB) / hsFreq   sparkle / harshness
//
// Key facts the numbers are tuned against:
//   - Air attenuation below 500 Hz is small and roughly linear, so
//     bass survives distance — distance presets should not aggressively
//     HP. (TVTech / prosoundtraining.com)
//   - Walls block highs AND lows but pass mids well; "next room"
//     LP usually lands around 1 kHz. (sound-design guides)
//   - PE foam mod scrubs HF above ~4 kHz and enhances the low-end
//     pop. (NPK / Switch and Click)
//   - Underwater practice: HP 80-100 Hz, LP 500-1000 Hz, +3 to +6 dB
//     boost below 250 Hz. (musicguymixing, soundcy)
const ROOM_PRESETS = {
  // True bypass — no EQ, no HP. The recording exactly as captured.
  raw:        { hp: 20,   lp: 22050, hs: 0,   hsFreq: 2500, ls: 0,   lsFreq: 200, peak: 0,  peakFreq: 1000, peakQ: 1 },

  // Boutique custom: aluminium case + gasket + some foam. Gasket
  // dampens case resonance ('clean slate'), case mass shelves up
  // bass, low-mid peak ~250 Hz delivers the signature warm thock.
  // HF kill is moderate — gasket is dampening, not muffling.
  gasket:     { hp: 100,  lp: 8000,  hs: -5,  hsFreq: 3500, ls: 6,   lsFreq: 120, peak: 3,  peakFreq: 250,  peakQ: 2 },

  // Thick case foam + plate foam: foam absorbs HF above ~4 kHz
  // aggressively, kills the ring, the reverberant cavity goes to
  // zero. Click-band gets a peaking cut, deep thock, plenty of body.
  foam:       { hp: 90,   lp: 4000,  hs: -10, hsFreq: 2500, ls: 7,   lsFreq: 140, peak: -4, peakFreq: 1500, peakQ: 1.5 },

  // Stock plastic case, no foam: hollow ring at ~520 Hz, mild bass
  // loss, brighter top. HP cleans up the worst plate rumble.
  hollow:     { hp: 140,  lp: 9500,  hs: 1,   hsFreq: 4000, ls: -2,  lsFreq: 100, peak: 7,  peakFreq: 520,  peakQ: 3 },

  // Thin laptop / cheap travel keyboard: scooped bass, sharp click-
  // band peak, no body. Heavy HP, deep low-shelf cut.
  tin_can:    { hp: 320,  lp: 7500,  hs: -2,  hsFreq: 2000, ls: -10, lsFreq: 220, peak: 9,  peakFreq: 1400, peakQ: 5 },

  // Across the desk (~1 m). HP only kills the plate-vibration end of
  // the spectrum (sub-bass that wouldn't propagate); rest of the
  // bass band is intact since air doesn't absorb low freq much.
  desk:       { hp: 150,  lp: 5500,  hs: -6,  hsFreq: 2500, ls: -1,  lsFreq: 150, peak: 0,  peakFreq: 1000, peakQ: 1 },

  // Across the room (~3 m, soft furnishings absorb HF first). Still
  // gentle HP — low end carries.
  far:        { hp: 180,  lp: 2500,  hs: -14, hsFreq: 1800, ls: -3,  lsFreq: 200, peak: 0,  peakFreq: 1000, peakQ: 1 },

  // Through a closed door — LP ~1 kHz is the film-sound canon.
  // Walls block lows somewhat but mids pass; HP moderate.
  next_room:  { hp: 200,  lp: 1000,  hs: -22, hsFreq: 1200, ls: -6,  lsFreq: 250, peak: 0,  peakFreq: 1000, peakQ: 1 },

  // For fun: underwater. HP 80 + LP 700 matches the film canon for
  // 'pronounced submerged' (some guides go as low as 300). +5 dB LS
  // lift sits in the documented 3-6 dB band. Peaking bloom at 350 Hz
  // gives the 'submerged body' resonance.
  underwater: { hp: 80,   lp: 700,   hs: -24, hsFreq: 1500, ls: 5,   lsFreq: 180, peak: 3,  peakFreq: 350,  peakQ: 1.8 },
};

function applyRoomPreset(name) {
  state.roomPreset = name;
  const p = ROOM_PRESETS[name] || ROOM_PRESETS.raw;
  if (!state.audioCtx) return;  // applied lazily on ensureAudioCtx
  const t = state.audioCtx.currentTime;
  // Short ramp so flipping presets mid-playback doesn't click.
  const TC = 0.04;
  state.roomHP.frequency.setTargetAtTime(p.hp, t, TC);
  state.roomLS.frequency.setTargetAtTime(p.lsFreq, t, TC);
  state.roomLS.gain.setTargetAtTime(p.ls, t, TC);
  state.roomPeak.frequency.setTargetAtTime(p.peakFreq, t, TC);
  state.roomPeak.Q.setTargetAtTime(p.peakQ, t, TC);
  state.roomPeak.gain.setTargetAtTime(p.peak, t, TC);
  state.roomLP.frequency.setTargetAtTime(p.lp, t, TC);
  state.roomHS.frequency.setTargetAtTime(p.hsFreq, t, TC);
  state.roomHS.gain.setTargetAtTime(p.hs, t, TC);
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

  // While the metronome session is actively recording, mirror each
  // batch into state.guided.chunks so we have the full PCM for
  // post-hoc cycle slicing. The ring buffer is only 4 s — useless for
  // a 40 s session — hence the separate growing buffer.
  if (state.guided && state.guided.active) {
    const copy = new Float32Array(inp.length);
    copy.set(inp);
    state.guided.chunks.push(copy);
    state.guided.chunksLen += inp.length;
  }
  // Noise-profile accumulator: during the guided session's !listening
  // window (3-2-1 countdown before recording starts) the room is
  // genuinely quiet. Grab an FFT frame every ~150 ms. Stored on the
  // template at finishGuided so future denoising can subtract it.
  if (state.guided && state.guided.noiseProfile && !state.guided.listening) {
    const np = state.guided.noiseProfile;
    const accumStride = Math.floor(state.sampleRate * 0.15);
    if (state.absIdx >= np.fftN && state.absIdx - np.lastAccumAbs > accumStride) {
      try { _accumulateGuidedNoiseFrame(); }
      catch (e) { /* never break audio thread on this */ }
      np.lastAccumAbs = state.absIdx;
    }
  }

  // noise floor: slow EMA of high-passed peak while not in a press.
  if (!state.inEvent) {
    state.floorEMA = state.floorEMA * 0.99 + hpBatchPeak * 0.01;
  }
  // Lower floor 0.008 → 0.003 so soft silent-switch taps in a genuinely
  // quiet room can still cross threshold. The 4× multiplier over the
  // adaptive floor still keeps random mic noise from triggering.
  state.autoThreshold = clamp(state.floorEMA * 4, 0.003, 0.5);

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
  if ($("session-count")) $("session-count").textContent = "0";
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
// One flow, not two. The metronome ticks N beats with the tempo
// accelerating from REC_BPM_START to REC_BPM_END across the session.
// User follows the beat; we capture every wavefront pair. Afterward
// we score each cycle by SNR + attack quality + isolation, bin them
// across the tempo range, and keep the cleanest REC_KEEP_N to write
// to disk. No "calibrate then record" split — recording IS the
// calibration.
const REC_BEATS      = 60;
const REC_BPM_START  = 50;
const REC_BPM_END    = 180;  // ≈ 45 WPM single-finger — keepable
const REC_KEEP_N     = 30;
const REC_BINS       = 5;    // tempo buckets for range coverage

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
    // Metronome state
    active: false,           // true when beats are firing
    beat: 0,                 // 1-indexed; 0 = pre-roll
    nextBeatTimer: null,
    listening: false,        // true during recording phase only
    countdown: 0,            // 3-2-1 preroll
    // Beat timestamps (sample-indices relative to sessionStartAbs).
    // These ARE the priors the post-hoc detector uses to find taps.
    beatTimes: [],
    // Long-form PCM capture — the ring buffer is only 4 s, so we
    // mirror each handleBatch into chunks for the full session length.
    chunks: [],
    chunksLen: 0,
    sessionStartAbs: 0,
    // Noise profile accumulated during preroll silence + small gaps
    noiseProfile: { fftN: 1024, mag: new Float64Array(513), framesAccum: 0, lastAccumAbs: 0 },
  };
  $("guided-modal").classList.remove("hidden");
  updateGuidedUI();
  if (!state.armed) await arm();
  beginRecordingCountdown();
}

function beginRecordingCountdown() {
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
      state.guided.active = true;
      state.guided.sessionStartAbs = state.absIdx;
      state.guided.chunks = [];
      state.guided.chunksLen = 0;
      setStatus("recording…");
      _metronomeBeat();
    }
  };
  setTimeout(tick, 1000);
}

// Exponential ramp from REC_BPM_START → REC_BPM_END across REC_BEATS.
// Exponential because perceptually a doubling-of-speed is similar at
// every tempo, so a log spacing produces an even-feeling acceleration.
function bpmAtBeat(beat) {
  const t = clamp((beat - 1) / Math.max(1, REC_BEATS - 1), 0, 1);
  return REC_BPM_START * Math.pow(REC_BPM_END / REC_BPM_START, t);
}

function _metronomeBeat() {
  const g = state.guided;
  if (!g || !g.active) return;
  g.beat++;
  // Record the sample-index when this beat fired — post-hoc detection
  // anchors its tap search around these. Relative to sessionStartAbs so
  // it indexes directly into the concatenated PCM chunks.
  g.beatTimes.push(state.absIdx - g.sessionStartAbs);
  setStageBeat(g.beat);
  updateGuidedUI();
  if (g.beat >= REC_BEATS) {
    g.active = false;
    // small grace period so the last tap's release tail finishes
    setTimeout(() => finishGuided(false), 600);
    return;
  }
  const bpm = bpmAtBeat(g.beat + 1);
  const intervalMs = Math.max(120, Math.round(60000 / bpm));
  g.nextBeatTimer = setTimeout(_metronomeBeat, intervalMs);
}

// ----- visual stage helpers (metronome ring + center dot) ----------
//
// Single visual: progress ring fills as the session advances; the dot
// pulses to accent on each beat and flashes green when a tap is
// captured. NO text/icon swapping per beat — that was visually
// horrible at fast tempo.

const _METRO_CIRC = 339.292;  // 2 * pi * 54 (must match CSS dasharray)

function _setDotLabel(s) {
  const el = $("metro-dot-label");
  if (el) el.textContent = s;
}

function _setProgress(frac) {
  const el = $("metro-progress");
  if (!el) return;
  const f = Math.max(0, Math.min(1, frac));
  el.style.strokeDashoffset = String(_METRO_CIRC * (1 - f));
}

function _flashDot(cls, ms) {
  const dot = $("metro-dot");
  if (!dot) return;
  dot.classList.remove(cls);
  void dot.offsetWidth;  // reflow so the class re-applies
  dot.classList.add(cls);
  setTimeout(() => dot && dot.classList.remove(cls), ms);
}

function setStageBeat(beatN) {
  _setDotLabel("");
  _setProgress(beatN / REC_BEATS);
  _flashDot("beat", 110);
}

function setStageForSlot(_phase, _slotIdx) {
  // legacy no-op — kept so any old callers don't throw
}

function setStageCaptured() {
  _flashDot("captured", 220);
}

function setStageCountdown(n) {
  _setDotLabel(String(n));
  _setProgress(0);
}

// (advanceGuidedPhase / displayLearnedSoFar / formatRoleLine removed —
// the new metronome flow has only one continuous "phase" so the
// phase-advance machinery isn't needed.)


function cancelGuided() {
  if (!state.guided) return;
  finishGuided(true);
}

// Threshold for a "good enough" session: anything below this number of
// kept samples surfaces the summary modal asking the user to retry
// (matching was hard / too few clean cycles).
const REC_MIN_ACCEPTABLE = 15;

async function finishGuided(cancelled) {
  const g = state.guided;
  const sw = state.currentSwitch;
  if (!g) return;

  if (g.nextBeatTimer) { clearTimeout(g.nextBeatTimer); g.nextBeatTimer = null; }
  g.active = false;
  g.listening = false;

  if (cancelled || !sw) {
    state.guided = null;
    $("guided-modal").classList.add("hidden");
    _hideSummary();
    if (state.armed) disarm();
    refreshPrimary();
    setStatus(cancelled ? "recording cancelled" : "recording aborted");
    return;
  }

  $("guided-status").textContent = "processing…";

  const pcm = new Float32Array(g.chunksLen);
  let off = 0;
  for (const c of g.chunks) { pcm.set(c, off); off += c.length; }
  g.chunks = [];

  const sr = state.sampleRate;
  const cycles = _detectCyclesFromPcm(pcm, sr, g.beatTimes, g.noiseProfile);
  const scored = cycles.map((c) => ({ ...c, score: _scoreFromPcm(c, pcm, sr) }));
  const selected = _selectByBeatRange(scored, REC_KEEP_N, REC_BINS, g.beatTimes.length);
  const pairedCount = scored.filter((c) => c.paired).length;
  const pairRate = scored.length ? pairedCount / scored.length : 0;
  console.log("[thock] session:", {
    beats: g.beatTimes.length,
    cyclesDetected: cycles.length,
    paired: pairedCount,
    selected: selected.length,
  });

  g.processed = { pcm, sr, cycles, selected, pairedCount, pairRate, sessionStartAbs: 0 };

  // Auto-commit regardless of yield. Marginal sessions used to surface
  // a 'try again / keep these' summary; now we just save whatever the
  // metronome captured. The user can re-record from the main grid if
  // the result isn't good enough.
  await _commitGuidedSession();
}

function _showSummary({ kept, cycles, paired, pairRate, good }) {
  const sum = $("guided-summary");
  if (!sum) return;
  const metro = $("metro");
  if (metro) metro.style.display = "none";
  $("guided-hint").style.display = "none";
  $("guided-status").textContent = "";

  const headline = good
    ? `kept <strong>${kept}</strong> samples across the tempo range`
    : `only <strong>${kept}</strong> usable samples · this is probably too few`;
  const reasons = [];
  if (pairRate < 0.5) reasons.push(`pairing was difficult (${Math.round(pairRate * 100)}% of cycles paired)`);
  if (cycles < 30) reasons.push(`only ${cycles} cycles detected (target ${REC_BEATS})`);
  const reasonLine = reasons.length ? `<div class="summary-detail">${reasons.join(" · ")}</div>` : "";

  sum.innerHTML =
    `<div class="summary-headline">${headline}</div>` +
    reasonLine +
    `<div class="summary-detail">try again to improve quality, or keep what we have.</div>`;
  sum.classList.remove("hidden");

  $("guided-retry").classList.remove("hidden");
  $("guided-accept").classList.remove("hidden");
  $("guided-cancel").textContent = "discard";
}

function _hideSummary() {
  const sum = $("guided-summary");
  if (sum) { sum.classList.add("hidden"); sum.innerHTML = ""; }
  const metro = $("metro");
  if (metro) metro.style.display = "";
  const hint = $("guided-hint");
  if (hint) hint.style.display = "";
  const cancel = $("guided-cancel");
  if (cancel) cancel.textContent = "cancel";
}

async function _commitGuidedSession() {
  const g = state.guided;
  const sw = state.currentSwitch;
  if (!g || !g.processed || !sw) return;
  const { pcm, sr, cycles, selected, sessionStartAbs } = g.processed;

  $("guided-status").textContent = `saving ${selected.length}…`;

  let saved = 0;
  for (const c of selected) {
    try {
      const startIdx = Math.max(0, c.startAbs - sessionStartAbs);
      const endIdx = Math.min(pcm.length, c.endAbs - sessionStartAbs);
      if (endIdx - startIdx < sr * 0.012) continue;
      const slice = pcm.slice(startIdx, endIdx);
      const wav = encodeWav(slice, sr);
      await fsSaveSample(sw, wav, null);
      saved++;
    } catch (e) { console.error("save failed", e); }
  }

  // Dwell calibration from paired cycles.
  const gaps = g.processed.cycles
    .filter((c) => c.paired)
    .map((c) => c.dwellMs)
    .sort((a, b) => a - b);
  if (gaps.length >= 4) {
    const median = gaps[Math.floor(gaps.length / 2)];
    const calibrated = clamp(Math.round((median + 80) / 10) * 10, 200, 500);
    setSwitchDwell(sw, calibrated);
  }

  // Persist noise spectrum on template (denoise-on-save will read this later).
  const np = g.noiseProfile;
  if (np && np.framesAccum >= 5) {
    const noiseSpectrum = new Array(np.mag.length);
    for (let i = 0; i < np.mag.length; i++) noiseSpectrum[i] = np.mag[i] / np.framesAccum;
    const existing = state.switchTemplates.get(sw) || {};
    setSwitchTemplate(sw, {
      ...existing,
      noiseSpectrum,
      noiseFftN: np.fftN,
      noiseFramesAccum: np.framesAccum,
      noiseSr: sr,
      sampleCount: saved,
      learnedAt: Date.now(),
    });
  }

  state.guided = null;
  $("guided-modal").classList.add("hidden");
  _hideSummary();
  if (state.armed) disarm();
  await refreshSwitches();
  if (sw === state.currentSwitch) await loadSwitchSamples(sw);
  refreshPrimary();
  setStatus(`recorded · ${saved} samples kept (from ${cycles.length} cycles)`);
}

// User chose "try again" — discard the processed session and restart
// the metronome run with a fresh countdown. No files written.
async function _retryGuidedSession() {
  const g = state.guided;
  if (!g) return;
  g.processed = null;
  g.beatTimes = [];
  g.chunks = [];
  g.chunksLen = 0;
  g.beat = 0;
  g.noiseProfile = { fftN: 1024, mag: new Float64Array(513), framesAccum: 0, lastAccumAbs: 0 };
  _hideSummary();
  _setProgress(0);
  $("guided-status").textContent = "ready…";
  beginRecordingCountdown();
}

// ----- post-hoc tap detection -------------------------------------
//
// Anchored to the metronome beat times: for each beat, scan a short
// window around it for the loudest transient, refine to its onset,
// then look forward in time for a quieter release transient. Beats
// where no transient pops above noise are dropped silently. This
// replaces the live trigger entirely — the trigger was missing soft
// taps that were visually obvious in the scope.

const _RMS_HOP_MS = 3;     // envelope resolution
const _SEARCH_PRE_MS = 120;   // ms before beat to start looking
const _SEARCH_POST_MS = 450;  // ms after beat to stop looking
const _RELEASE_MAX_MS = 350;  // max press→release gap
const _RELEASE_MIN_MS = 18;   // min press→release gap (skip press's own tail)
const _SNR_THR = 4.0;         // must exceed this × noise RMS to count

function _buildEnvelope(pcm, hop) {
  const env = new Float32Array(Math.ceil(pcm.length / hop));
  for (let e = 0, i = 0; e < env.length; e++) {
    let p = 0;
    const end = Math.min(pcm.length, i + hop);
    for (let j = i; j < end; j++) {
      const a = pcm[j] < 0 ? -pcm[j] : pcm[j];
      if (a > p) p = a;
    }
    env[e] = p;
    i = end;
  }
  return env;
}

function _rmsOf(pcm, start, end) {
  start = Math.max(0, start | 0);
  end = Math.min(pcm.length, end | 0);
  if (end <= start) return 0;
  let s = 0;
  for (let i = start; i < end; i++) s += pcm[i] * pcm[i];
  return Math.sqrt(s / (end - start));
}

// Find the first onset in [startSamp, endSamp] where the envelope
// rises above `threshold`. Refines the onset to the local peak +
// walks back to the rising edge (20 % of peak).
function _findOnsetInRange(pcm, env, hop, startSamp, endSamp, threshold) {
  const startHop = Math.max(0, Math.floor(startSamp / hop));
  const endHop = Math.min(env.length, Math.ceil(endSamp / hop));
  let trigHop = -1;
  for (let e = startHop; e < endHop; e++) {
    if (env[e] >= threshold) { trigHop = e; break; }
  }
  if (trigHop < 0) return null;
  // local peak within ~30 ms
  const peakWin = Math.floor(0.030 * (hop > 0 ? (env.length * hop / pcm.length) : 1));
  let peakHop = trigHop, peakVal = env[trigHop];
  for (let e = trigHop; e < Math.min(endHop, trigHop + 12); e++) {
    if (env[e] > peakVal) { peakVal = env[e]; peakHop = e; }
  }
  // walk back from peak to find onset (envelope ≤ 20 % of peak)
  let onsetHop = peakHop;
  const onsetLevel = peakVal * 0.20;
  for (let e = peakHop; e >= startHop; e--) {
    if (env[e] < onsetLevel) { onsetHop = e + 1; break; }
  }
  return {
    onsetSamp: Math.max(0, onsetHop * hop),
    peakSamp: peakHop * hop,
    peak: peakVal,
  };
}

function _detectCyclesFromPcm(pcm, sr, beatTimes, noiseProfile) {
  if (!pcm.length || !beatTimes.length) return [];
  const hop = Math.max(1, Math.floor((_RMS_HOP_MS / 1000) * sr));
  const env = _buildEnvelope(pcm, hop);
  // Noise floor from the first ~2 s of capture (before metronome starts).
  // Falls back to a small floor if the preamble was noisy or short.
  const preambleEnd = Math.min(pcm.length, Math.max(beatTimes[0] - sr * 0.2, sr * 0.5));
  const noiseRms = Math.max(_rmsOf(pcm, 0, preambleEnd), 0.0005);
  const onsetThr = Math.max(noiseRms * _SNR_THR, 0.0015);
  const releaseSearchStart = Math.floor((_RELEASE_MIN_MS / 1000) * sr);
  const releaseSearchEnd = Math.floor((_RELEASE_MAX_MS / 1000) * sr);
  const preSamp = Math.floor((_SEARCH_PRE_MS / 1000) * sr);
  const postSamp = Math.floor((_SEARCH_POST_MS / 1000) * sr);

  const cycles = [];
  let lastPressEndAbs = -1;
  for (let bi = 0; bi < beatTimes.length; bi++) {
    const beatT = beatTimes[bi];
    // Don't search before the previous press's release (avoids
    // re-detecting the tail of the prior tap as this beat's press).
    const winStart = Math.max(lastPressEndAbs + 1, beatT - preSamp);
    const nextBeat = bi + 1 < beatTimes.length ? beatTimes[bi + 1] : pcm.length;
    const winEnd = Math.min(pcm.length, Math.min(beatT + postSamp, nextBeat - hop));
    const press = _findOnsetInRange(pcm, env, hop, winStart, winEnd, onsetThr);
    if (!press) continue;

    // Look for release: a second transient starting ≥ 18 ms after press
    // peak, quieter than press peak. Constrained to before the next beat.
    const relStart = press.peakSamp + releaseSearchStart;
    const relEnd = Math.min(pcm.length, press.peakSamp + releaseSearchEnd, nextBeat - hop);
    const releaseThr = Math.max(noiseRms * 3.0, press.peak * 0.18);
    const release = _findOnsetInRange(pcm, env, hop, relStart, relEnd, releaseThr);
    const paired = !!release;
    const dwellMs = paired ? ((release.onsetSamp - press.onsetSamp) / sr) * 1000 : null;
    const cycleStart = Math.max(0, press.onsetSamp - Math.floor(0.025 * sr));
    const cycleEnd = paired
      ? Math.min(pcm.length, release.peakSamp + Math.floor(0.040 * sr))
      : Math.min(pcm.length, press.peakSamp + Math.floor(0.100 * sr));
    cycles.push({
      startAbs: cycleStart,
      endAbs: cycleEnd,
      pressPeak: press.peak,
      releasePeak: paired ? release.peak : 0,
      dwellMs,
      paired,
      beatIdx: bi,
      noiseRms,
    });
    lastPressEndAbs = cycleEnd;
  }
  return cycles;
}

function _scoreFromPcm(c, pcm, sr) {
  const snr = Math.log(c.pressPeak / Math.max(c.noiseRms, 1e-5) + 1);
  const pairBonus = c.paired ? 0.6 : 0;
  // Penalize cycles whose window is suspiciously long (often means we
  // ran into the next beat's transient).
  const lengthMs = ((c.endAbs - c.startAbs) / sr) * 1000;
  const lengthPenalty = lengthMs > 350 ? -0.3 : 0;
  return snr + pairBonus + lengthPenalty;
}

// Bin by beat index directly (we know each beat's position on the
// tempo ramp) and take the top-scorers per bin. Guarantees the kept
// samples span the slow→fast range.
function _selectByBeatRange(scored, keepN, bins, totalBeats) {
  if (!scored.length) return [];
  const perBin = Math.ceil(keepN / bins);
  const beatsPerBin = Math.max(1, Math.ceil(totalBeats / bins));
  const buckets = Array.from({ length: bins }, () => []);
  for (const c of scored) {
    const idx = Math.min(bins - 1, Math.floor((c.beatIdx ?? 0) / beatsPerBin));
    buckets[idx].push(c);
  }
  const selected = [];
  for (const b of buckets) {
    b.sort((x, y) => y.score - x.score);
    selected.push(...b.slice(0, perBin));
  }
  selected.sort((a, b) => a.startAbs - b.startAbs);
  return selected.slice(0, keepN);
}

// Takes one FFT-sized window from the most recent ring buffer audio,
// magnitude-FFTs it, and accumulates into the guided session's noise
// profile. Called only when state.guided.listening is false (3-2-1
// countdown or cooldown), so the window is genuinely quiet.
function _accumulateGuidedNoiseFrame() {
  const g = state.guided;
  if (!g || !g.noiseProfile) return;
  const np = g.noiseProfile;
  const N = np.fftN;
  const sr = state.sampleRate;
  const startAbs = state.absIdx - N;
  const pcm = readRingRange(startAbs, state.absIdx);
  if (pcm.length < N) return;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const win = getWindow("hann", N);
  for (let i = 0; i < N; i++) re[i] = pcm[i] * win[i];
  fft(re, im);
  const mag = np.mag;
  for (let i = 0; i < mag.length; i++) {
    mag[i] += Math.sqrt(re[i] * re[i] + im[i] * im[i]);
  }
  np.framesAccum++;
}

function updateGuidedUI() {
  const g = state.guided;
  if (!g) return;
  $("guided-card-switch").textContent = displayName(state.currentSwitch);
  const bpmEl = $("guided-phase-num");
  if (bpmEl) {
    if (g.beat > 0) {
      bpmEl.textContent = `${Math.round(bpmAtBeat(g.beat))} BPM`;
    } else {
      bpmEl.textContent = "ready";
    }
  }
  const status = $("guided-status");
  if (status) {
    if (g.countdown > 0) status.textContent = "ready…";
    else status.textContent = `${g.beat} / ${REC_BEATS}`;
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
// Live trigger is no longer used during recording — its threshold
// drops too many soft taps that are clearly visible in the scope.
// Instead, finishGuided runs a post-hoc onset detector over the full
// captured PCM using beat times as priors. This is left as a no-op
// stub so emitWavefront's existing routing continues to short-circuit
// cleanly when state.guided is set.
function handleGuidedWavefront(_startAbs, _endAbs, _peak, _attackMs, _durationMs) {
  // no-op
}

function _clearPendingFlush() {
  if (state.pendingFlushTimer) {
    clearTimeout(state.pendingFlushTimer);
    state.pendingFlushTimer = null;
  }
  state.pendingWavefront = null;
}

// saveCycle is now only used by the (legacy) freeform pair coalescer
// path, which the new metronome flow bypasses. Kept simple — write
// the WAV with a timestamp-only filename, refresh the grid.
async function saveCycle(startAbs, endAbs, kind) {
  const sw = state.currentSwitch;
  if (!sw || !state.storageHandle) return;
  const pcm = readRingRange(startAbs, endAbs);
  const sr = state.sampleRate;
  if (pcm.length < sr * 0.012) return;
  const wav = encodeWav(pcm, sr);
  try {
    await fsSaveSample(sw, wav, null);
    state.sessionCount++;
    if ($("session-count")) $("session-count").textContent = String(state.sessionCount);
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
  // Stop any play-all loop bound to the prior switch's samples — leaving
  // it running across a switch change would mix the wrong sound source.
  if (state.playAll && state.playAll.active) {
    state.playAll.active = false;
    const btn = $("play-all-btn");
    if (btn) btn.textContent = "▶ play all";
  }
  state.currentSwitch = name;
  // bidirectional sync: the typist pane mirrors the active switch so the
  // two panels are always coherent. Changing one changes the other.
  state.typingSwitch = name;
  renderSwitchRow();
  updateTypingButtons();
  // primary button reflects "calibrated yet?" — flip to calibrate-or-arm
  refreshPrimary();
  refreshExportVisibility();
  if ($("meta-switch")) $("meta-switch").textContent = displayName(name);
  setStatus(`switch · ${displayName(name)}`);
  await loadSwitchSamples(name);
}

async function loadSwitchSamples(name) {
  const sw = state.switches.find((s) => s.name === name);
  $("fp-name").textContent = displayName(name);
  renderFingerprintTags(name);
  renderFingerprintTravel(name);
  refreshExportVisibility();
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
    // Skip the bottom two octaves: anything that low is residual
    // proximity rumble / plate vibration from the close mic, not
    // useful switch character.
    if (f < 250 || f > sr / 2 - 200) continue;
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
  const tog = $("type-toggle");
  if (tog) { tog.textContent = "■ stop"; tog.classList.add("armed"); }
  $("typist-status").classList.add("typing");
  $("typist-status").textContent = "typing · " + displayName(state.typingSwitch);
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
  const stream = makeTextStream();

  try {
    while (!stop) {
      if (state.typingSwitch !== poolName) {
        poolName = state.typingSwitch;
        $("typist-status").textContent = "typing · " + displayName(poolName);
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
      // perceptually louder. Edge ramps (20 ms in, 15 ms out) kill
      // the "plop" you'd otherwise hear when the WAV's first/last
      // sample isn't at zero — the step is broadband but speaker
      // cones move farthest at low frequencies, so the click reads as
      // a bass thump. Both ramps land inside the preroll/tail
      // silence (capture pipeline writes ~50 ms preroll), so no
      // perceptual loss on the press transient itself.
      const gain = state.audioCtx.createGain();
      let velGain = 0.55 + ampTarget * 0.5;
      if (ch === " ") velGain *= 1.15;
      const dur = src.buffer.duration;
      const FADE_IN = Math.min(0.020, dur * 0.25);
      const FADE_OUT = Math.min(0.015, dur * 0.20);
      gain.gain.setValueAtTime(0, nextTime);
      gain.gain.linearRampToValueAtTime(velGain, nextTime + FADE_IN);
      gain.gain.setValueAtTime(velGain, nextTime + Math.max(FADE_IN, dur - FADE_OUT));
      gain.gain.linearRampToValueAtTime(0, nextTime + dur);

      // Stereo pan from a rough QWERTY position model: left half of the
      // keyboard pans left, right half pans right. The cue is subtle
      // (max ±0.6) but it's a strong subconscious signal that lifts
      // realism a lot — typing on a real board is never a point source.
      const pan = state.audioCtx.createStereoPanner();
      pan.pan.value = panForChar(ch);

      src.connect(gain).connect(pan).connect(state.audioOut);
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
    const tog = $("type-toggle");
    if (tog) { tog.textContent = "▶ start"; tog.classList.remove("armed", "busy"); }
    $("typist-status").classList.remove("typing");
    $("typist-status").textContent = "idle";
    updateTypingButtons();
  }
}

function stopTyping() { if (state.typingStop) state.typingStop(); }

function setTypingSwitch(name) {
  state.typingSwitch = name;
  if (state.typingActive) $("typist-status").textContent = "typing · " + displayName(name);
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

// Live article source. Tries libertis.net's common RSS/Atom paths via
// a direct fetch first (works if their CORS allows it), then via a
// public proxy as fallback. On any failure leaves state.articles null
// and the typist falls back to the classic PASSAGES below — typing
// always works regardless of network state.
async function loadArticles() {
  const candidates = [
    "https://libertis.net/feed/",
    "https://libertis.net/feed",
    "https://libertis.net/rss",
    "https://libertis.net/rss.xml",
    "https://libertis.net/feed.xml",
    "https://libertis.net/atom.xml",
    "https://libertis.net/index.xml",
  ];
  const proxy = (url) => "https://api.allorigins.win/raw?url=" + encodeURIComponent(url);
  for (const direct of candidates) {
    for (const url of [direct, proxy(direct)]) {
      try {
        const r = await fetch(url);
        if (!r.ok) continue;
        const text = await r.text();
        const articles = parseFeedToPassages(text);
        if (articles.length >= 3) {
          state.articles = articles;
          updateTypistSource();
          console.log(`thock: ${articles.length} articles loaded from ${direct}`);
          return;
        }
      } catch (e) { /* try next candidate */ }
    }
  }
  console.warn("thock: libertis.net unreachable, typist using classic passages");
}

function parseFeedToPassages(xml) {
  const out = [];
  const stripHtml = (s) => s
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  const extract = (itemRe, bodyRe) => {
    let m;
    while ((m = itemRe.exec(xml))) {
      const body = m[1];
      const d = body.match(bodyRe);
      if (!d) continue;
      let text = stripHtml(d[1]);
      if (text.length < 100) continue;
      if (text.length > 1500) text = text.slice(0, 1500);
      out.push(text);
    }
  };
  extract(/<item>([\s\S]*?)<\/item>/gi,
          /<(?:content:encoded|description|summary)[^>]*>([\s\S]*?)<\/(?:content:encoded|description|summary)>/i);
  if (!out.length) {
    extract(/<entry[^>]*>([\s\S]*?)<\/entry>/gi,
            /<(?:content|summary)[^>]*>([\s\S]*?)<\/(?:content|summary)>/i);
  }
  return out;
}

function updateTypistSource() {
  const el = $("typist-source");
  if (!el) return;
  if (state.articles && state.articles.length) {
    el.textContent = `source: libertis.net (${state.articles.length} articles)`;
  } else {
    el.textContent = "source: classic passages";
  }
}

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

// Source: libertis.net articles when reachable, classic PASSAGES as
// fallback. Mode selector was removed — one source, picked at load time.
function makeTextStream() {
  const source = (state.articles && state.articles.length >= 3)
    ? state.articles
    : PASSAGES;
  let pending = "";
  let cycleIdx = 0;
  function refill() {
    pending += source[cycleIdx++ % source.length] + "  ·  ";
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
  if (mode === "enable")           b.textContent = "enable mic";
  else if (mode === "new-switch")  b.textContent = "+ create a switch";
  else if (mode === "record")      b.textContent = "▶ record samples";
}

// Single-flow primary button: enable mic → create switch → record.
// The metronome-driven recording IS the calibration; no separate
// "▶ start" freeform state.
function currentPrimaryMode() {
  if (!state.audioCtx || !state.stream) return "enable";
  if (!state.currentSwitch) return "new-switch";
  return "record";
}

function refreshPrimary() {
  setPrimary(currentPrimaryMode());
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
    if ($("meta-floor")) $("meta-floor").textContent = state.audioCtx ? state.floorEMA.toFixed(3) : "—";

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
    <span class="name"></span>
    <span class="ct">${sw.count}</span>
  `;
  tile.querySelector(".name").textContent = displayName(sw.name);
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
  const dur = (t) => (t.meta && t.meta.buf) ? t.meta.buf.duration : -1;
  if (order === "duration-asc") arr.sort((a, b) => dur(a) - dur(b));
  else if (order === "duration-desc") arr.sort((a, b) => dur(b) - dur(a));
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
  const ctx = state.audioCtx;
  const src = ctx.createBufferSource();
  src.buffer = t.meta.buf;
  const gain = ctx.createGain();
  // Same envelope as the typist — edge ramps land inside the
  // preroll/tail silence and kill the bass-thump edge clicks.
  const start = ctx.currentTime + 0.005;
  const dur = src.buffer.duration;
  const FADE_IN = Math.min(0.020, dur * 0.25);
  const FADE_OUT = Math.min(0.015, dur * 0.20);
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(1, start + FADE_IN);
  gain.gain.setValueAtTime(1, start + Math.max(FADE_IN, dur - FADE_OUT));
  gain.gain.linearRampToValueAtTime(0, start + dur);
  src.connect(gain).connect(state.audioOut);
  src.start(start);

  // Also drop the sample's pulse into the typist viz so it slides
  // in from the right edge and scrolls across the time axis — same
  // path as a typed keystroke, just triggered from the inspect panel.
  if (t.meta.mini && t.switch) {
    state.typingPulses.push({
      t: performance.now(),
      name: t.switch,
      mini: t.meta.mini,
    });
    if (state.typingPulses.length > 240) state.typingPulses.shift();
  }
}

// Play every loaded sample in current sort order, gap of ~120 ms
// between each, looping forever until the user clicks the button
// again. Schedules ahead in the AudioContext clock so the timing
// is sample-accurate (not setTimeout jitter).
async function togglePlayAll() {
  const btn = $("play-all-btn");
  if (state.playAll && state.playAll.active) {
    state.playAll.active = false;
    if (btn) btn.textContent = "▶ play all";
    return;
  }
  await ensureAudioCtx();
  const tiles = sortedTiles().filter((t) => t.meta && t.meta.buf);
  if (!tiles.length) { setStatus("no samples to play"); return; }
  state.playAll = { active: true };
  if (btn) btn.textContent = "■ stop";
  const GAP_S = 0.12;
  let next = state.audioCtx.currentTime + 0.05;
  let i = 0;
  while (state.playAll && state.playAll.active) {
    const t = tiles[i % tiles.length];
    const buf = t.meta.buf;
    const src = state.audioCtx.createBufferSource();
    src.buffer = buf;
    // Same edge-ramp envelope as the typist (kills bass-thump edge clicks).
    const gain = state.audioCtx.createGain();
    const FADE_IN = Math.min(0.020, buf.duration * 0.25);
    const FADE_OUT = Math.min(0.015, buf.duration * 0.20);
    gain.gain.setValueAtTime(0, next);
    gain.gain.linearRampToValueAtTime(1, next + FADE_IN);
    gain.gain.setValueAtTime(1, next + Math.max(FADE_IN, buf.duration - FADE_OUT));
    gain.gain.linearRampToValueAtTime(0, next + buf.duration);
    src.connect(gain).connect(state.audioOut);
    src.start(next);
    next += buf.duration + GAP_S;
    i++;
    // Sleep until we're <300 ms ahead so we don't queue thousands of
    // sources up-front (which would also block stop responsiveness).
    const aheadMs = (next - state.audioCtx.currentTime) * 1000 - 300;
    if (aheadMs > 0) await sleep(aheadMs);
  }
  if (btn) btn.textContent = "▶ play all";
}

// ----- export current switch as ZIP (for contribution emails) ------

// CRC-32 (IEEE 802.3 polynomial). Built once, ~256 entries. Used by
// the ZIP writer per file.
const _CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();
function _crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = _CRC32_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// Build an uncompressed (STORED) ZIP from a list of {name, data}.
// Pure byte assembly — no library needed. STORED is fine because
// our payload is WAV/FLAC (already poorly-compressible) and the
// recipient just runs bundle_library.py on it anyway.
function _buildZipStored(files) {
  const enc = new TextEncoder();
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const data = f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data);
    const crc = _crc32(data);
    const size = data.length;

    // Local file header (30 bytes + name + data)
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);    // PK\x03\x04
    lv.setUint16(4, 20, true);            // version needed
    lv.setUint16(6, 0, true);             // flags
    lv.setUint16(8, 0, true);             // method = STORED
    lv.setUint16(10, 0, true);            // mod time
    lv.setUint16(12, 0, true);            // mod date
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);         // compressed size
    lv.setUint32(22, size, true);         // uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);            // extra len
    local.set(nameBytes, 30);
    localChunks.push(local, data);

    // Central directory record (46 bytes + name)
    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);    // PK\x01\x02
    cv.setUint16(4, 20, true);            // version made by
    cv.setUint16(6, 20, true);            // version needed
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);            // comment len
    cv.setUint16(34, 0, true);            // disk number
    cv.setUint16(36, 0, true);            // internal attrs
    cv.setUint32(38, 0, true);            // external attrs
    cv.setUint32(42, offset, true);       // local header offset
    cd.set(nameBytes, 46);
    centralChunks.push(cd);

    offset += local.length + data.length;
  }

  const cdSize = centralChunks.reduce((s, c) => s + c.length, 0);
  const cdOffset = offset;
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);      // PK\x05\x06
  ev.setUint16(4, 0, true);               // disk
  ev.setUint16(6, 0, true);               // disk with cd
  ev.setUint16(8, files.length, true);    // entries on this disk
  ev.setUint16(10, files.length, true);   // total entries
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdOffset, true);
  ev.setUint16(20, 0, true);              // comment len

  const total = offset + cdSize + 22;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of localChunks)   { out.set(c, pos); pos += c.length; }
  for (const c of centralChunks) { out.set(c, pos); pos += c.length; }
  out.set(end, pos);
  return out;
}

// Library-imported switches don't get an export button — the value
// of the curated library is the library itself; trivial in-app
// re-export would undercut that. User-created switches stay
// exportable so people can contribute their own recordings back.
function refreshExportVisibility() {
  const btn = $("export-btn");
  if (!btn) return;
  const sw = state.currentSwitch;
  const meta = sw ? state.switchMeta.get(sw) : null;
  const fromLibrary = meta && meta.source === "library";
  btn.classList.toggle("hidden", !!fromLibrary);
}

async function exportCurrentSwitch() {
  const sw = state.currentSwitch;
  if (!sw) { setStatus("no switch selected"); return; }
  const switchEntry = state.switches.find((s) => s.name === sw);
  if (!switchEntry || !switchEntry.count) { setStatus("nothing to export — no samples"); return; }

  const btn = $("export-btn");
  if (btn) { btn.disabled = true; btn.textContent = "packing…"; }

  try {
    const files = [];
    // 1) the user's filled-in metadata so the recipient doesn't have
    //    to re-enter name / type / weight / family.
    const meta = state.switchMeta.get(sw) || {};
    const metaOut = {
      name: meta.name || sw,
      family: meta.family || "",
      description: meta.description || "",
      color: colorForSwitch(sw),
    };
    files.push({ name: `${sw}/meta.json`, data: new TextEncoder().encode(JSON.stringify(metaOut, null, 2) + "\n") });

    // 2) every WAV / FLAC on disk
    for (let i = 0; i < switchEntry.samples.length; i++) {
      const fname = switchEntry.samples[i];
      const ab = await fsReadSample(sw, fname);
      files.push({ name: `${sw}/${fname}`, data: new Uint8Array(ab) });
      if (btn && (i % 4 === 0)) btn.textContent = `packing · ${i + 1}/${switchEntry.samples.length}`;
    }

    const zipBytes = _buildZipStored(files);
    const blob = new Blob([zipBytes], { type: "application/zip" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${sw}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setStatus(`exported ${sw}.zip · ${(zipBytes.length / 1024).toFixed(0)} KB · ${switchEntry.samples.length} samples + meta.json`);
  } catch (e) {
    console.error("export failed", e);
    setStatus("export failed: " + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "export"; }
  }
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

// ============== library (curated switch catalog) ==================
//
// Hosted as static files alongside the app: /library/index.json lists
// each switch (family, name, description, color, files); WAVs live at
// /library/<id>/<file>.wav. The library dialog lets the user pick
// multiple switches to import in one go, grouped by family. Importing
// is ADDITIVE only — unticking a switch in the library never deletes
// the user's local copy of that switch (or any of their own
// recordings). Removal is intentional, via the per-switch remove
// button on the main grid.

// Infer switch type from description text. Avoids requiring a `type`
// field in meta.json (it's usually right there in the description) but
// honors an explicit type field if one's set.
function _switchType(p) {
  if (p.type) return String(p.type).toLowerCase();
  const d = String(p.description || "").toLowerCase();
  if (d.includes("silent")) return "silent";
  if (d.includes("clicky")) return "clicky";
  if (d.includes("tactile")) return "tactile";
  if (d.includes("linear")) return "linear";
  return "other";
}

// Strip the family prefix from the displayed name when the entry is
// shown inside its family group — "Choc v2 Autumn" becomes "Autumn",
// less noise at a glance.
function _stripFamilyPrefix(name, family) {
  if (!name || !family) return name || "";
  const lower = name.toLowerCase();
  const fLower = family.toLowerCase();
  if (lower.startsWith(fLower + " ")) return name.slice(family.length + 1);
  if (lower.startsWith(fLower)) return name.slice(family.length).trim();
  return name;
}

async function openLibraryDialog() {
  const list = $("library-list");
  list.innerHTML = '<div class="dim">loading…</div>';
  $("library-dialog").showModal();
  let switches = null;
  try {
    const r = await fetch("/library/index.json", { cache: "no-store" });
    if (r.ok) switches = await r.json();
  } catch (_) { /* network or 404 — show empty */ }
  if (!Array.isArray(switches) || switches.length === 0) {
    list.innerHTML = '<div class="dim">no library switches available yet.</div>';
    return;
  }
  state.libraryCatalog = switches;
  state.librarySelected = new Set();
  state.libraryFilter = { type: "all", q: "" };
  $("library-search").value = "";
  for (const c of $("library-chips").querySelectorAll(".library-chip")) {
    c.classList.toggle("active", c.dataset.type === "all");
  }
  _renderLibraryList();
}

function _renderLibraryList() {
  const list = $("library-list");
  if (!list) return;
  const switches = state.libraryCatalog || [];
  // Only treat a switch as "owned" if it actually has samples on
  // disk. A 0-sample directory means a previous import was aborted
  // mid-flight (closed mid-download); show it as re-importable so
  // the user can recover without manually removing it first.
  const haveIds = new Set(state.switches.filter((s) => s.count > 0).map((s) => s.name));
  const selected = state.librarySelected;
  const { type, q } = state.libraryFilter || { type: "all", q: "" };
  const qLower = q.trim().toLowerCase();

  const byFamily = new Map();
  for (const s of switches) {
    if (type !== "all" && _switchType(s) !== type) continue;
    if (qLower && !((s.name || "").toLowerCase().includes(qLower)
                 || (s.description || "").toLowerCase().includes(qLower))) continue;
    const fam = s.family || "Other";
    if (!byFamily.has(fam)) byFamily.set(fam, []);
    byFamily.get(fam).push(s);
  }

  list.innerHTML = "";
  if (!byFamily.size) {
    list.innerHTML = '<div class="dim">no switches match the filter.</div>';
    _updateLibraryCount();
    return;
  }
  for (const [family, items] of byFamily) {
    const famEl = document.createElement("div");
    famEl.className = "library-family";
    // Switches in this family the user can actually act on
    // (the owned ones are excluded — they're already in the set).
    const selectable = items.filter((p) => !haveIds.has(p.id));
    const selectableCount = selectable.length;
    const allSelected = selectableCount > 0 && selectable.every((p) => selected.has(p.id));
    const bulkLabel = selectableCount === 0
      ? ""
      : (allSelected ? `− all` : `+ all (${selectableCount})`);
    const head = document.createElement("div");
    head.className = "library-family-head";
    head.innerHTML = `<span class="library-family-name"></span>`
      + (bulkLabel ? `<button type="button" class="library-family-bulk">${bulkLabel}</button>` : "");
    head.querySelector(".library-family-name").textContent = family;
    if (bulkLabel) {
      head.querySelector(".library-family-bulk").addEventListener("click", () => {
        if (allSelected) {
          for (const p of selectable) selected.delete(p.id);
        } else {
          for (const p of selectable) selected.add(p.id);
        }
        _renderLibraryList();
      });
    }
    famEl.appendChild(head);
    const grid = document.createElement("div");
    grid.className = "library-grid";
    for (const p of items) {
      const owned = haveIds.has(p.id);
      const isSelected = selected.has(p.id);
      const tile = document.createElement("button");
      tile.type = "button";
      tile.className = "library-tile"
        + (owned ? " owned" : "")
        + (isSelected ? " selected" : "");
      tile.style.setProperty("--c", p.color || "#f5a623");
      tile.dataset.id = p.id;
      tile.disabled = owned;
      const shortName = _stripFamilyPrefix(p.name || p.id, family);
      const desc = (p.description || "").trim();
      // Pull off a short weight/type chip if the description is "X · Y gf"
      const parts = desc.split("·").map((s) => s.trim()).filter(Boolean);
      const typeBadge = parts[0] || _switchType(p);
      const weightBadge = parts[1] || "";
      tile.innerHTML = `
        <div class="library-tile-head">
          <span class="library-tile-dot"></span>
          <span class="library-tile-name"></span>
          <span class="library-tile-check">✓</span>
        </div>
        <div class="library-tile-meta">
          <span class="library-tile-type"></span>
          ${weightBadge ? `<span class="library-tile-weight"></span>` : ""}
        </div>
        ${owned ? `<div class="library-tile-status">in your set</div>` : ""}
      `;
      tile.querySelector(".library-tile-name").textContent = shortName;
      tile.querySelector(".library-tile-type").textContent = typeBadge;
      if (weightBadge) tile.querySelector(".library-tile-weight").textContent = weightBadge;
      if (!owned) {
        tile.addEventListener("click", () => {
          if (selected.has(p.id)) selected.delete(p.id);
          else selected.add(p.id);
          tile.classList.toggle("selected");
          _updateLibraryCount();
        });
      }
      grid.appendChild(tile);
    }
    famEl.appendChild(grid);
    list.appendChild(famEl);
  }
  _updateLibraryCount();
}

function _updateLibraryCount() {
  const n = state.librarySelected ? state.librarySelected.size : 0;
  const el = $("library-count");
  if (el) el.textContent = `${n} selected`;
  const ok = $("library-ok");
  if (ok) ok.disabled = n === 0;
}

// Block dialog cancel (ESC) — used as an event listener that prevents
// the default close behavior while imports are in flight.
function _blockDialogCancel(e) { e.preventDefault(); }

async function importSelectedFromLibrary() {
  const okBtn = $("library-ok");
  const closeBtn = $("library-close");
  const dlg = $("library-dialog");
  const catalog = state.libraryCatalog || [];
  const selected = state.librarySelected || new Set();
  if (!state.storageHandle) {
    dlg.close();
    showStorageGate(state.storageName);
    return;
  }
  const have = new Set(state.switches.filter((s) => s.count > 0).map((s) => s.name));
  const wanted = [];
  for (const id of selected) {
    if (have.has(id)) continue;
    const p = catalog.find((x) => x.id === id);
    if (p) wanted.push(p);
  }
  if (!wanted.length) { dlg.close(); return; }

  // Lock the dialog while files are mid-flight: disable buttons,
  // block ESC cancel. Closing partway through used to leave switch
  // directories with 0 files on disk.
  okBtn.disabled = true;
  closeBtn.disabled = true;
  dlg.addEventListener("cancel", _blockDialogCancel);

  let firstImported = null;
  let totalFiles = 0, doneFiles = 0;
  for (const p of wanted) totalFiles += (p.files || []).length;

  // Browsers cap concurrent fetches per origin at ~6; pushing 8 workers
  // keeps the pipeline saturated without paying for extra queuing.
  const CONCURRENCY = 8;

  try {
    for (const preset of wanted) {
      try {
        const dir = await state.storageHandle.getDirectoryHandle(preset.id, { create: true });
        const files = preset.files || [];

        // Parallel fetch + write within a switch, capped at CONCURRENCY.
        // Workers pull from a shared cursor so fast fetches don't wait on
        // slower siblings (which they would under a chunked Promise.all).
        let cursor = 0;
        const worker = async () => {
          while (cursor < files.length) {
            const file = files[cursor++];
            const r = await fetch(`/library/${encodeURIComponent(preset.id)}/${encodeURIComponent(file)}`);
            if (!r.ok) throw new Error("HTTP " + r.status);
            const ab = await r.arrayBuffer();
            const fh = await dir.getFileHandle(file, { create: true });
            const w = await fh.createWritable();
            await w.write(ab);
            await w.close();
            doneFiles++;
            okBtn.textContent = `importing · ${doneFiles}/${totalFiles}`;
          }
        };
        const n = Math.min(CONCURRENCY, files.length);
        await Promise.all(Array.from({ length: n }, worker));

        if (preset.color) setSwitchColor(preset.id, preset.color);
        setSwitchMeta(preset.id, {
          name: preset.name || preset.id,
          family: preset.family || "",
          description: preset.description || "",
          source: "library",  // hides export button — see refreshExportVisibility
        });
        if (!firstImported) firstImported = preset.id;
      } catch (e) {
        console.error("import failed for", preset.id, e);
        setStatus(`failed to import ${preset.id}: ${e.message}`);
      }
    }
  } finally {
    okBtn.disabled = false;
    okBtn.textContent = "import selected";
    closeBtn.disabled = false;
    dlg.removeEventListener("cancel", _blockDialogCancel);
  }

  dlg.close();
  setStatus(`imported ${wanted.length} switch${wanted.length === 1 ? "" : "es"} · ${doneFiles} samples`);
  await refreshSwitches();
  if (firstImported) await selectSwitch(firstImported);
}

async function removeCurrentSwitch() {
  const sw = state.currentSwitch;
  if (!sw) return;
  if (!confirm(`remove switch '${displayName(sw)}' and all of its samples? this cannot be undone.`)) return;
  try { await fsDeleteSwitch(sw); }
  catch (e) { alert("remove failed: " + e.message); return; }

  state.switches = state.switches.filter((s) => s.name !== sw);
  state.switchProfiles.delete(sw);
  state.switchColors.delete(sw);
  state.switchMeta.delete(sw);
  try { localStorage.setItem("thock.colors", JSON.stringify([...state.switchColors])); }
  catch (_) { /* ignore */ }
  try { localStorage.setItem("thock.switchMeta", JSON.stringify([...state.switchMeta])); }
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
    renderFingerprintTags(null);
    state.switchSamples = [];
    renderTiles();
    drawFingerprint(null);
  }
  setStatus(`removed · ${displayName(sw)}`);
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
    if (mode === "new-switch") {
      openNewSwitchDialog();
      return;
    }
    // mode === "record" — kick off the metronome recording session.
    startGuided().catch((e) => { console.error(e); setStatus("record failed: " + e.message); });
  });

  $("new-switch").addEventListener("click", openNewSwitchDialog);
  // Enter inside any input → submit; Esc → cancel
  for (const id of ["new-switch-id", "new-switch-name", "new-switch-family", "new-switch-desc"]) {
    $(id).addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); $("new-switch-dialog").close("ok"); }
      else if (e.key === "Escape") { e.preventDefault(); $("new-switch-dialog").close("cancel"); }
    });
  }
  // Auto-derive id from name as the user types — so they typically
  // never have to touch the id field. Stops auto-syncing the moment
  // the user manually edits the id (so it doesn't surprise them).
  $("new-switch-name").addEventListener("input", () => {
    const idEl = $("new-switch-id");
    if (idEl.dataset.touched === "1") return;
    idEl.value = _slugifyId($("new-switch-name").value);
  });
  $("new-switch-id").addEventListener("input", () => {
    $("new-switch-id").dataset.touched = "1";
  });

  $("new-switch-cancel").addEventListener("click", () => $("new-switch-dialog").close("cancel"));
  $("new-switch-dialog").addEventListener("close", async () => {
    try {
      const d = $("new-switch-dialog");
      if (d.returnValue !== "ok") return;
      const idRaw = $("new-switch-id").value.trim();
      const name = $("new-switch-name").value.trim();
      const family = $("new-switch-family").value.trim();
      const desc = $("new-switch-desc").value.trim();
      const id = idRaw || _slugifyId(name);
      if (!id) { alert("need an id (or a name to derive one from)"); return; }
      if (!/^[A-Za-z0-9._-]+$/.test(id)) {
        alert("invalid id — use letters, digits, dot, dash, underscore");
        return;
      }
      if (!state.switches.find((s) => s.name === id)) {
        state.switches.push({ name: id, samples: [], count: 0 });
        state.switches.sort((a, b) => a.name.localeCompare(b.name));
      }
      // Persist whatever display metadata the user filled in. Empty
      // fields are fine — displayName falls back to the id.
      if (name || family || desc) {
        setSwitchMeta(id, { name: name || id, family, description: desc });
      }
      await selectSwitch(id);
    } catch (e) {
      console.error("new-switch failed", e);
      setStatus("new-switch failed: " + e.message);
    }
  });

  $("order").addEventListener("change", () => renderTiles());
  $("delete-all-btn").addEventListener("click", () => deleteAllInSwitch());
  $("play-all-btn").addEventListener("click", () => {
    togglePlayAll().catch((e) => { console.error(e); setStatus("play-all failed: " + e.message); });
  });
  $("export-btn").addEventListener("click", () => {
    exportCurrentSwitch().catch((e) => { console.error(e); setStatus("export failed: " + e.message); });
  });
  $("detail-play").addEventListener("click", () => state.activeSample && playSampleNow(state.activeSample));
  $("detail-delete").addEventListener("click", () => deleteActive());

  $("type-toggle").addEventListener("click", () => {
    if (state.typingActive) {
      stopTyping();
    } else {
      startTyping().catch((e) => { console.error(e); setStatus("typing error: " + e.message); });
    }
  });

  // Restore last-chosen room preset (localStorage), then wire the
  // dropdown. AudioContext may not exist yet; applyRoomPreset stores
  // the choice and re-applies it when ensureAudioCtx() runs.
  try {
    const saved = localStorage.getItem("thock.roomPreset");
    if (saved && ROOM_PRESETS[saved]) {
      state.roomPreset = saved;
      $("room-preset").value = saved;
    }
  } catch (_) {}
  $("room-preset").addEventListener("change", (e) => {
    const v = e.target.value;
    applyRoomPreset(v);
    try { localStorage.setItem("thock.roomPreset", v); } catch (_) {}
  });


  $("remove-switch-btn").addEventListener("click", () => removeCurrentSwitch());

  $("library-btn").addEventListener("click", () => openLibraryDialog());
  $("library-close").addEventListener("click", () => $("library-dialog").close());
  $("library-ok").addEventListener("click", () => {
    importSelectedFromLibrary().catch((e) => { console.error(e); setStatus("import failed: " + e.message); });
  });
  $("library-search").addEventListener("input", (e) => {
    if (!state.libraryFilter) state.libraryFilter = { type: "all", q: "" };
    state.libraryFilter.q = e.target.value;
    _renderLibraryList();
  });
  $("library-chips").addEventListener("click", (e) => {
    const chip = e.target.closest(".library-chip");
    if (!chip) return;
    for (const c of $("library-chips").querySelectorAll(".library-chip")) {
      c.classList.toggle("active", c === chip);
    }
    if (!state.libraryFilter) state.libraryFilter = { type: "all", q: "" };
    state.libraryFilter.type = chip.dataset.type;
    _renderLibraryList();
  });

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
    // First-run nudge: if storage is set up but the user has no
    // switches yet, surface the curated library so they have
    // something to listen to immediately.
    if (!state.switches.length) maybeAutoOpenLibrary();
  };

  $("guided-cancel").addEventListener("click", cancelGuided);

  // Storage UI removed — OPFS is auto-initialized at boot. No buttons
  // to wire here. pickStorage / useOpfsStorage are still exported for
  // internal use (tryResumeStorage for legacy disk-folder handles, and
  // init's auto-OPFS fallback).
}

// Storage gate UI is gone — thock auto-uses OPFS on init. These two
// shims keep older callers (importSelectedFromLibrary, arm, etc.)
// from throwing when they reach for the (no-longer-existing) gate.
async function showStorageGate(_prevName) {
  // If we somehow lost the storage handle, transparently re-init OPFS.
  if (!state.storageHandle && opfsSupported()) {
    try { await useOpfsStorage(); }
    catch (e) { setStatus("storage unavailable: " + e.message); }
  }
}
function hideStorageGate() { /* no-op */ }

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
  loadSwitchMeta();
  loadFftSettings();
  wire();
  refreshPrimary();
  if ($("fp-window")) $("fp-window").value = state.fft.window;
  if ($("fp-scale"))  $("fp-scale").value  = state.fft.scale;
  renderScope();
  drawTypingViz();
  drawTypingText();
  updateTypistSource();
  loadArticles().catch(() => {});

  if (!fsSupported()) {
    showStorageGate(null);
    setStatus("no storage backend available in this browser");
    return;
  }
  // Storage: prefer resuming whatever the user had before; otherwise
  // silently initialize OPFS. The folder-picker option was dropped —
  // one storage mode, no decision required from the user. Existing
  // disk-folder handles still resume cleanly when permission allows.
  const resumed = await tryResumeStorage();
  if (resumed === true) {
    setStatus(`storage ready · click 'enable mic' to begin`);
  } else {
    // resumed === false (nothing stored) OR { needsGesture } (we'd
    // need a click to re-grant disk-folder permission). Either way,
    // fall back to OPFS — it's the new default.
    if (opfsSupported()) {
      try { await useOpfsStorage(); setStatus(`storage ready · click 'enable mic' to begin`); }
      catch (e) { setStatus("storage unavailable: " + e.message); }
    } else {
      setStatus("no storage available in this browser");
    }
  }

  await refreshSwitches();
  // Backfill display names for any owned switch that matches a library
  // entry — handles imports done before this persistence existed.
  syncMetaFromLibrary().catch(() => {});
  if (state.currentSwitch) {
    state.typingSwitch = state.currentSwitch;
    await loadSwitchSamples(state.currentSwitch);
  } else if (state.storageHandle && !state.switches.length) {
    // Storage was resumed from a prior session but the user emptied
    // it (or never recorded). Show library — same first-run nudge.
    maybeAutoOpenLibrary();
  }
}

// For switches imported before display-name persistence existed (or
// imported on another device that sync'd just the WAVs), fetch the
// library index and backfill state.switchMeta for any owned switch
// that matches a library entry. Idempotent — re-runs harmlessly.
async function syncMetaFromLibrary() {
  try {
    const r = await fetch("/library/index.json", { cache: "no-store" });
    if (!r.ok) return;
    const list = await r.json();
    if (!Array.isArray(list)) return;
    const owned = new Set(state.switches.map((s) => s.name));
    let changed = false;
    for (const p of list) {
      if (!owned.has(p.id)) continue;
      const current = state.switchMeta.get(p.id);
      const fresh = {
        name: p.name || p.id,
        family: p.family || "",
        description: p.description || "",
        source: "library",
      };
      if (!current
          || current.name !== fresh.name
          || current.family !== fresh.family
          || current.description !== fresh.description
          || current.source !== "library") {
        state.switchMeta.set(p.id, fresh);
        changed = true;
      }
    }
    if (changed) {
      try { localStorage.setItem("thock.switchMeta", JSON.stringify([...state.switchMeta])); }
      catch (_) { /* ignore */ }
      renderSwitchRow();
      updateTypingButtons();
      if (state.currentSwitch) {
        $("fp-name").textContent = displayName(state.currentSwitch);
        renderFingerprintTags(state.currentSwitch);
        if ($("meta-switch")) $("meta-switch").textContent = displayName(state.currentSwitch);
        refreshExportVisibility();
      }
    }
  } catch (_) { /* network or 404 — skip */ }
}

// Open the library dialog only when the index has entries — otherwise
// we'd flash an empty modal. Used as a soft first-run nudge so a new
// user immediately sees the curated switches instead of an empty grid.
async function maybeAutoOpenLibrary() {
  try {
    const r = await fetch("/library/index.json", { cache: "no-store" });
    if (!r.ok) return;
    const list = await r.json();
    if (Array.isArray(list) && list.length > 0) openLibraryDialog();
  } catch (_) { /* network/404 — skip */ }
}

init().catch((e) => {
  console.error("init failed", e);
  setStatus("init failed — see console");
});
