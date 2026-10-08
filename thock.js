import { Engine, ROOM_LABELS } from "/engine.js";
import GEO from "/atlas-geometry.js";

const $ = (id) => document.getElementById(id);
const SVG_NS = "http://www.w3.org/2000/svg";
const engine = new Engine();

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} },
};

// ============== Atlas geometry =====================================
// Board millimetres for the built prototype (mwlaboratories/atlas,
// pcb/atlas/atlas.kicad_pcb: 20 mm columns, 17 mm rows), with the case
// layers projected from its STLs. See scripts/atlas_geometry.py.

const PITCH_X = 20, PITCH_Y = 17;
const CAP_W = 17.5, CAP_H = 16.2;
const BOARD_CX = GEO.mirrorX / 2;
const HALF_VIEW = { L: [15, 25, 137, 103.5], R: [GEO.mirrorX - 152, 25, 137, 103.5] };
// Alpha switches column-major (x, then y); thumbs left → right.
const ALPHAS = GEO.switches.filter((s) => s[1] < 100).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
const THUMBS = GEO.switches.filter((s) => s[1] >= 100).sort((a, b) => a[0] - b[0]);

// Atlas default layer (images/keymap.svg), keymap positions 0..33.
const BASE = [
  ..."qwertyuiop", ..."asdfghjkl", "⌫", ..."zxcvbnm,.", "del",
  "space", "tab", "enter", "shift",
];
const HOLD = { 30: "", 31: "sym", 32: "num" };
const TAP_TEXT = { 19: null, 29: null, 30: " ", 31: "", 32: "\n", 33: "" };

const KEYS = BASE.map((label, pos) => {
  const [x, y, r] = pos < 30 ? ALPHAS[(pos % 10) * 3 + Math.floor(pos / 10)] : THUMBS[pos - 30];
  return { pos, label, x, y, r, half: x < BOARD_CX ? "L" : "R" };
});

// Physical key (event.code) → Atlas position. Letters sit where they do
// on Atlas; other keys land where Atlas puts them (num/sym layers, home
// row mods), so whatever you type lights the key you'd press on Atlas.
const CODE_POS = (() => {
  const m = {};
  BASE.forEach((l, i) => { if (/^[a-z]$/.test(l)) m["Key" + l.toUpperCase()] = i; });
  "1234567890".split("").forEach((d, i) => { m["Digit" + d] = i; m["Numpad" + d] = i; });
  Object.assign(m, {
    Comma: 27, Period: 28, Semicolon: 19, Slash: 29, Backspace: 19, Delete: 29,
    Space: 30, Tab: 31, Enter: 32, NumpadEnter: 32, ShiftLeft: 33, ShiftRight: 33,
    Minus: 16, Equal: 17, BracketLeft: 11, BracketRight: 21, Quote: 20,
    Backslash: 25, Backquote: 8, IntlBackslash: 25, Escape: 30, CapsLock: 11,
    ArrowLeft: 15, ArrowDown: 16, ArrowUp: 17, ArrowRight: 18, Home: 25, End: 28, Insert: 13,
    AltLeft: 11, MetaLeft: 12, ControlLeft: 13, ControlRight: 16, MetaRight: 17, AltRight: 18,
  });
  return m;
})();

// Character → position, for soft keyboards that only report text.
const CHAR_POS = (() => {
  const m = new Map();
  const sym = '!@#$%^&*`~"[{(\u0000/-=:;\']})\u0000\\_+|?';
  [...sym].forEach((c, i) => { if (c !== "\u0000") m.set(c, i); });
  [..."1234567890"].forEach((c, i) => m.set(c, i));
  BASE.forEach((l, i) => { if (l.length === 1 && l !== "⌫") m.set(l, i); });
  m.set(" ", 30); m.set("\t", 31); m.set("\n", 32);
  return m;
})();

// ============== state ==============================================

const state = {
  catalog: [],
  picked: new Set(store.get("thock.picks", [])),
  loaded: [],            // ids on the play screen, in catalog order
  active: store.get("thock.active", null),
  progress: new Map(),   // id → 0..1
  screen: "pick",
  shiftLatched: false,
};

const touchMode = window.matchMedia("(hover: none) and (pointer: coarse)").matches;

// ============== selection screen ===================================

function parseDesc(desc) {
  const parts = String(desc || "").split("·").map((s) => s.trim()).filter(Boolean);
  return { type: parts[0] || "", force: parts[1] || "", travel: parts[2] || "" };
}

function shortName(p) {
  const fam = (p.family || "").toLowerCase();
  const n = p.name || p.id;
  return fam && n.toLowerCase().startsWith(fam + " ") ? n.slice(fam.length + 1) : n;
}

function familyTag(p) {
  const m = /v(\d)/i.exec(p.family || "");
  return m ? "v" + m[1] : "";
}

// Choc v1 has the twin-blade stem, v2 the MX-style cross.
function stemSVG(p) {
  const v1 = /v1/i.test(p.family || "");
  const shape = v1
    ? '<rect x="5" y="3" width="3.2" height="14" rx="1"/><rect x="11.8" y="3" width="3.2" height="14" rx="1"/>'
    : '<path d="M8.4 3h3.2v5.4H17v3.2h-5.4V17H8.4v-5.4H3V8.4h5.4z"/>';
  return `<svg class="stem" viewBox="0 0 20 20" aria-hidden="true">${shape}</svg>`;
}

function renderPick() {
  const root = $("pick-groups");
  root.removeAttribute("aria-busy");
  root.innerHTML = "";
  const families = new Map();
  for (const p of state.catalog) {
    const f = p.family || "Other";
    if (!families.has(f)) families.set(f, []);
    families.get(f).push(p);
  }
  for (const [family, items] of families) {
    const group = document.createElement("section");
    group.className = "pick-group";
    const head = document.createElement("div");
    head.className = "pick-group-head";
    const h = document.createElement("h2");
    h.textContent = family;
    const all = document.createElement("button");
    all.type = "button";
    all.className = "link-btn";
    const syncAll = () => {
      const every = items.every((p) => state.picked.has(p.id));
      all.textContent = every ? "clear" : "select all";
      all.setAttribute("aria-label", (every ? "Clear " : "Select all ") + family);
    };
    all.addEventListener("click", () => {
      const every = items.every((p) => state.picked.has(p.id));
      for (const p of items) every ? state.picked.delete(p.id) : state.picked.add(p.id);
      renderPick();
    });
    syncAll();
    head.append(h, all);
    const grid = document.createElement("div");
    grid.className = "cards";
    for (const p of items) {
      const d = parseDesc(p.description);
      const on = state.picked.has(p.id);
      const card = document.createElement("button");
      card.type = "button";
      card.className = "card";
      card.setAttribute("aria-pressed", on ? "true" : "false");
      card.style.setProperty("--c", p.color || "#999");
      card.innerHTML = `
        ${stemSVG(p)}
        <span class="card-text">
          <span class="card-name"></span>
          <span class="card-type"></span>
          <span class="card-spec"></span>
        </span>
        <span class="card-check" aria-hidden="true"></span>`;
      card.querySelector(".card-name").textContent = shortName(p);
      card.querySelector(".card-type").textContent = d.type;
      card.querySelector(".card-spec").textContent = [d.force, d.travel].filter(Boolean).join(" · ");
      card.addEventListener("click", () => {
        if (state.picked.has(p.id)) state.picked.delete(p.id); else state.picked.add(p.id);
        card.setAttribute("aria-pressed", state.picked.has(p.id) ? "true" : "false");
        syncAll();
        updatePickBar();
      });
      grid.appendChild(card);
    }
    group.append(head, grid);
    root.appendChild(group);
  }
  updatePickBar();
}

function updatePickBar() {
  const ids = pickedIds();
  const n = ids.length;
  const files = ids.reduce((s, id) => s + (byId(id).files || []).length, 0);
  $("pick-count").textContent = n
    ? `${n} switch${n === 1 ? "" : "es"} · ${files} samples`
    : "none selected";
  $("pick-go").disabled = n === 0;
}

const byId = (id) => state.catalog.find((p) => p.id === id);
const pickedIds = () => state.catalog.filter((p) => state.picked.has(p.id)).map((p) => p.id);

// ============== play screen ========================================

function startPlaying() {
  engine.unlock();
  const ids = pickedIds();
  if (!ids.length) return;
  store.set("thock.picks", ids);
  state.loaded = ids;
  if (!ids.includes(state.active)) state.active = ids[0];
  renderSwitches();
  setActive(state.active);
  showScreen("play", true);
  loadQueue(ids);
}

async function loadQueue(ids) {
  const order = [state.active, ...ids.filter((id) => id !== state.active)];
  for (const id of order) {
    if (engine.isLoaded(id)) { state.progress.set(id, 1); updatePill(id); continue; }
    try {
      await engine.load(byId(id), (f) => { state.progress.set(id, f); updatePill(id); });
    } catch (e) {
      console.error(e);
      state.progress.set(id, -1);
    }
    updatePill(id);
  }
}

function renderSwitches() {
  const root = $("switches");
  root.innerHTML = "";
  for (const id of state.loaded) {
    const p = byId(id);
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pill";
    b.dataset.id = id;
    b.setAttribute("role", "radio");
    b.style.setProperty("--c", p.color || "#999");
    b.innerHTML = `<span class="pill-dot" aria-hidden="true"></span><span class="pill-name"></span><span class="pill-tag"></span><span class="pill-bar" aria-hidden="true"></span>`;
    b.querySelector(".pill-name").textContent = shortName(p);
    b.querySelector(".pill-tag").textContent = familyTag(p);
    b.addEventListener("click", () => {
      setActive(id);
      if (!touchMode) $("typed").focus({ preventScroll: true });
    });
    root.appendChild(b);
    updatePill(id);
  }
  root.onkeydown = (e) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    const i = state.loaded.indexOf(state.active);
    const step = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1;
    const next = state.loaded[(i + step + state.loaded.length) % state.loaded.length];
    setActive(next);
    root.querySelector(`[data-id="${CSS.escape(next)}"]`).focus();
  };
}

function updatePill(id) {
  const b = $("switches").querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (!b) return;
  const f = state.progress.get(id) ?? (engine.isLoaded(id) ? 1 : 0);
  b.classList.toggle("loading", f >= 0 && f < 1);
  b.classList.toggle("failed", f < 0);
  b.style.setProperty("--p", Math.max(0, f).toFixed(3));
  if (id === state.active) updateInfo();
}

function setActive(id) {
  state.active = id;
  store.set("thock.active", id);
  for (const b of $("switches").querySelectorAll(".pill")) {
    const on = b.dataset.id === id;
    b.setAttribute("aria-checked", on ? "true" : "false");
    b.tabIndex = on ? 0 : -1;
  }
  const p = byId(id);
  $("board").style.setProperty("--press", p.color || "#d97706");
  updateInfo();
}

function updateInfo() {
  const p = byId(state.active);
  if (!p) return;
  const d = parseDesc(p.description);
  const f = state.progress.get(p.id) ?? (engine.isLoaded(p.id) ? 1 : 0);
  const status = f < 0 ? " · failed to load" : f < 1 ? ` · loading ${Math.round(f * 100)}%` : "";
  $("switch-info").textContent = `${p.family} ${shortName(p)} · ${[d.type, d.force, d.travel].filter(Boolean).join(" · ")}${status}`;
}

// ============== Atlas rendering ====================================

function el(name, attrs, parent) {
  const n = document.createElementNS(SVG_NS, name);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(n);
  return n;
}

const keyEls = [];

function renderBoard() {
  const board = $("board");
  board.innerHTML = "";
  for (const half of ["L", "R"]) {
    const svg = el("svg", {
      class: "half half-" + half,
      viewBox: HALF_VIEW[half].join(" "),
      preserveAspectRatio: "xMidYMid meet",
      role: "presentation",
    }, board);
    const layers = half === "L" ? GEO.left : GEO.right;
    const shadow = el("g", { class: "case-shadow", transform: "translate(0 1.8)" }, svg);
    el("path", { d: layers.cover }, shadow);
    el("path", { d: layers.case }, shadow);
    el("path", { class: "cover", d: layers.cover }, svg);
    el("path", { class: "case", d: layers.case }, svg);
    el("path", { class: "case-top", d: layers.top }, svg);
    for (const k of KEYS.filter((k) => k.half === half)) {
      const g = el("g", {
        class: "key",
        "data-pos": k.pos,
        transform: `translate(${k.x} ${k.y})${k.r ? ` rotate(${k.r})` : ""}`,
      }, svg);
      el("rect", { class: "hit", x: -PITCH_X / 2, y: -PITCH_Y / 2, width: PITCH_X, height: PITCH_Y }, g);
      el("rect", { class: "cap-side", x: -CAP_W / 2, y: -CAP_H / 2 + 1.1, width: CAP_W, height: CAP_H, rx: 2.4 }, g);
      const cap = el("g", { class: "cap" }, g);
      el("rect", { class: "cap-top", x: -CAP_W / 2, y: -CAP_H / 2, width: CAP_W, height: CAP_H, rx: 2.4 }, cap);
      el("rect", { class: "cap-glow", x: -CAP_W / 2, y: -CAP_H / 2, width: CAP_W, height: CAP_H, rx: 2.4 }, cap);
      const long = k.label.length > 1;
      const t = el("text", { class: "legend" + (long ? " small" : ""), x: 0, y: HOLD[k.pos] ? -0.6 : 0.3 }, cap);
      t.textContent = k.label;
      if (HOLD[k.pos]) {
        const h = el("text", { class: "legend hold", x: 0, y: 4.6 }, cap);
        h.textContent = HOLD[k.pos];
      }
      keyEls[k.pos] = g;
    }
    for (const [x, y] of GEO.trackpoints) {
      if ((half === "L") !== (x < BOARD_CX)) continue;
      el("circle", { class: "nub-ring", cx: x, cy: y, r: 2.5 }, svg);
      el("circle", { class: "nub", cx: x, cy: y, r: 2.0 }, svg);
    }
  }
  board.addEventListener("pointerdown", onPointerDown);
  board.addEventListener("pointerup", onPointerUp);
  board.addEventListener("pointercancel", onPointerUp);
  board.addEventListener("lostpointercapture", onPointerUp);
  board.addEventListener("contextmenu", (e) => e.preventDefault());
}

// ============== presses ============================================

const holds = new Array(KEYS.length).fill(0);

function hold(pos) {
  if (pos == null || !keyEls[pos]) return;
  if (holds[pos]++ === 0) keyEls[pos].classList.add("down");
}

function release(pos) {
  if (pos == null || !keyEls[pos] || holds[pos] === 0) return;
  if (--holds[pos] === 0) keyEls[pos].classList.remove("down");
}

function releaseAll() {
  holds.fill(0);
  heldCodes.clear();
  pointers.clear();
  keyEls.forEach((g) => g && g.classList.remove("down"));
}

function sound(pos) {
  const k = pos != null ? KEYS[pos] : null;
  const pan = k ? (k.x - BOARD_CX) / 116 : 0;
  engine.play(state.active, pan);
}

function flash(pos) {
  hold(pos);
  setTimeout(() => release(pos), 90);
}

// Pointer: taps on the virtual keys. Each pointer is its own voice, so
// multi-finger rolls overlap like real rollover.
const pointers = new Map();

function onPointerDown(e) {
  const g = e.target.closest && e.target.closest(".key");
  if (!g) return;
  e.preventDefault();
  engine.unlock();
  const pos = Number(g.dataset.pos);
  try { g.setPointerCapture(e.pointerId); } catch (_) {}
  pointers.set(e.pointerId, pos);
  hold(pos);
  sound(pos);
  typeFromTap(pos);
}

function onPointerUp(e) {
  if (!pointers.has(e.pointerId)) return;
  release(pointers.get(e.pointerId));
  pointers.delete(e.pointerId);
}

function typeFromTap(pos) {
  const ta = $("typed");
  if (pos === 19) return editText(ta, "back");
  if (pos === 29) return editText(ta, "fwd");
  if (pos === 33) {
    state.shiftLatched = !state.shiftLatched;
    keyEls[33].classList.toggle("latched", state.shiftLatched);
    return;
  }
  let s = pos in TAP_TEXT ? TAP_TEXT[pos] : BASE[pos];
  if (!s) return;
  if (state.shiftLatched) {
    s = s.toUpperCase();
    state.shiftLatched = false;
    keyEls[33].classList.remove("latched");
  }
  editText(ta, "insert", s);
}

function editText(ta, op, s = "") {
  let a = ta.selectionStart, b = ta.selectionEnd;
  if (op === "back" && a === b) a = Math.max(0, a - 1);
  if (op === "fwd" && a === b) b = Math.min(ta.value.length, b + 1);
  ta.setRangeText(op === "insert" ? s : "", a, b, "end");
  ta.scrollTop = ta.scrollHeight;
}

// Keyboard: sound fires on keydown, before the browser inserts text.
const heldCodes = new Map();
let keyHandledAt = -1;

function posForKey(e) {
  if (e.code && e.code in CODE_POS) return CODE_POS[e.code];
  if (e.key && e.key.length === 1) {
    const p = CHAR_POS.get(e.key.toLowerCase());
    if (p != null) return p;
  }
  return null;
}

function onKeyDown(e) {
  if (state.screen !== "play") return;
  if (e.isComposing || e.keyCode === 229 || e.key === "Unidentified" || e.key === "Process") return;
  const ta = $("typed");
  const t = e.target;
  if (t && t.tagName === "SELECT") return;
  const activating = t && t.closest && t.closest("button") && (e.key === " " || e.key === "Enter");
  const typing = e.key.length === 1 || e.key === "Backspace" || e.key === "Enter";
  if (t !== ta && typing && !activating && !e.metaKey && !e.ctrlKey) ta.focus({ preventScroll: true });
  if (activating) return;

  const pos = posForKey(e);
  const id = e.code || e.key;
  keyHandledAt = performance.now();
  if (e.repeat || heldCodes.has(id)) return;
  heldCodes.set(id, pos);
  hold(pos);
  sound(pos);
}

function onKeyUp(e) {
  const id = e.code || e.key;
  if (!heldCodes.has(id)) return;
  release(heldCodes.get(id));
  heldCodes.delete(id);
}

// Soft keyboards (Android in particular) send keyCode 229 with no key
// identity, so the sound comes from the text change instead.
function onInput(e) {
  if (performance.now() - keyHandledAt < 150) return;
  const it = e.inputType || "";
  if (it === "insertReplacementText" || it === "insertFromPaste" || it === "historyUndo") return;
  let pos = null;
  if (it.startsWith("delete")) pos = it === "deleteContentForward" ? 29 : 19;
  else if (it === "insertLineBreak" || it === "insertParagraph") pos = 32;
  else if (e.data) pos = CHAR_POS.get(e.data.slice(-1).toLowerCase()) ?? null;
  flash(pos);
  sound(pos);
}

// ============== screens, viewport ==================================

function showScreen(name, push) {
  state.screen = name;
  $("pick").hidden = name !== "pick";
  $("play").hidden = name !== "play";
  document.documentElement.classList.toggle("is-play", name === "play");
  if (push) history.pushState({ screen: name }, "", name === "play" ? "#play" : location.pathname);
  if (name === "play") {
    window.scrollTo(0, 0);
    if (!touchMode) $("typed").focus({ preventScroll: true });
  } else {
    releaseAll();
    renderPick();
  }
}

function setSoftKeyboard(on) {
  const ta = $("typed");
  const btn = $("osk");
  ta.setAttribute("inputmode", on ? "text" : "none");
  btn.setAttribute("aria-pressed", on ? "true" : "false");
  btn.textContent = on ? "hide keyboard" : "system keyboard";
  if (on) { ta.blur(); ta.focus({ preventScroll: true }); }
  else ta.blur();
}

// iOS keeps the layout viewport tall when the on-screen keyboard opens;
// pin the play screen to the visual viewport so nothing gets pushed off.
function syncViewport() {
  const vv = window.visualViewport;
  const h = vv ? vv.height : window.innerHeight;
  document.documentElement.style.setProperty("--app-h", h + "px");
  if (state.screen === "play" && window.scrollY) window.scrollTo(0, 0);
}

// ============== init ===============================================

function wire() {
  $("pick-go").addEventListener("click", startPlaying);
  $("edit").addEventListener("click", () => {
    if (history.state && history.state.screen === "play") history.back();
    else showScreen("pick", true);
  });
  $("clear").addEventListener("click", () => {
    const ta = $("typed");
    ta.value = "";
    if (!touchMode || ta.getAttribute("inputmode") === "text") ta.focus({ preventScroll: true });
  });
  $("osk").addEventListener("click", () => setSoftKeyboard($("typed").getAttribute("inputmode") !== "text"));
  $("typed").addEventListener("input", onInput);

  const room = $("room");
  for (const [k, label] of Object.entries(ROOM_LABELS)) {
    const o = document.createElement("option");
    o.value = k; o.textContent = label;
    room.appendChild(o);
  }
  room.value = store.get("thock.room", "raw");
  engine.setRoom(room.value);
  room.addEventListener("change", () => {
    engine.setRoom(room.value);
    store.set("thock.room", room.value);
    if (!touchMode) $("typed").focus({ preventScroll: true });
  });

  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", releaseAll);
  document.addEventListener("visibilitychange", () => { if (document.hidden) releaseAll(); });
  window.addEventListener("popstate", (e) => {
    const s = e.state && e.state.screen;
    if (s === "play" && state.loaded.length) showScreen("play", false);
    else showScreen("pick", false);
  });

  if (touchMode) {
    document.documentElement.classList.add("touch");
    $("typed").setAttribute("inputmode", "none");
  }
  syncViewport();
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", syncViewport);
    window.visualViewport.addEventListener("scroll", syncViewport);
  }
  window.addEventListener("resize", syncViewport);
}

async function init() {
  wire();
  renderBoard();
  if (location.hash) history.replaceState(null, "", location.pathname);
  try {
    const r = await fetch("/library/index.json");
    state.catalog = await r.json();
  } catch (e) {
    $("pick-groups").innerHTML = '<p class="muted">Could not load the switch library. Reload to try again.</p>';
    return;
  }
  for (const id of [...state.picked]) if (!byId(id)) state.picked.delete(id);
  renderPick();
}

init();
