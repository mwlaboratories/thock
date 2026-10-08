// ===================================================================
//  thock playback engine
//
//  The live-typing half of the original app.js audio engine: one
//  AudioContext, a master bus through the room-EQ biquad chain, and a
//  fresh source → gain → pan graph per keystroke (so any number of
//  overlapping strokes ring out together). Samples are picked by
//  amplitude percentile with a short no-repeat memory and a ±10 cent
//  pitch jitter, exactly like the typist.
//
//  Live typing differs from the scheduled typist in one way: strokes
//  start *now*, and playback skips the ~25 ms of recorded pre-roll so
//  the transient lands as close to the keypress as the device allows.
// ===================================================================

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Same biquad values as app.js; see the notes there for the sources.
export const ROOM_PRESETS = {
  raw:        { hp: 20,   lp: 22050, hs: 0,   hsFreq: 2500, ls: 0,   lsFreq: 200, peak: 0,  peakFreq: 1000, peakQ: 1 },
  gasket:     { hp: 100,  lp: 8000,  hs: -5,  hsFreq: 3500, ls: 6,   lsFreq: 120, peak: 3,  peakFreq: 250,  peakQ: 2 },
  foam:       { hp: 90,   lp: 4000,  hs: -10, hsFreq: 2500, ls: 7,   lsFreq: 140, peak: -4, peakFreq: 1500, peakQ: 1.5 },
  hollow:     { hp: 140,  lp: 9500,  hs: 1,   hsFreq: 4000, ls: -2,  lsFreq: 100, peak: 7,  peakFreq: 520,  peakQ: 3 },
  tin_can:    { hp: 320,  lp: 7500,  hs: -2,  hsFreq: 2000, ls: -10, lsFreq: 220, peak: 9,  peakFreq: 1400, peakQ: 5 },
  desk:       { hp: 150,  lp: 5500,  hs: -6,  hsFreq: 2500, ls: -1,  lsFreq: 150, peak: 0,  peakFreq: 1000, peakQ: 1 },
  far:        { hp: 180,  lp: 2500,  hs: -14, hsFreq: 1800, ls: -3,  lsFreq: 200, peak: 0,  peakFreq: 1000, peakQ: 1 },
  next_room:  { hp: 200,  lp: 1000,  hs: -22, hsFreq: 1200, ls: -6,  lsFreq: 250, peak: 0,  peakFreq: 1000, peakQ: 1 },
  underwater: { hp: 80,   lp: 700,   hs: -24, hsFreq: 1500, ls: 5,   lsFreq: 180, peak: 3,  peakFreq: 350,  peakQ: 1.8 },
};

export const ROOM_LABELS = {
  raw: "raw recording",
  gasket: "gasket build",
  foam: "foam-lined",
  hollow: "hollow plastic",
  tin_can: "tin can",
  desk: "across the desk",
  far: "across the room",
  next_room: "next room",
  underwater: "underwater",
};

const FETCH_CONCURRENCY = 6;
// Playback starts this long before the detected onset so the 2 ms
// fade-in finishes before the transient instead of eating into it.
const PRE_ONSET_S = 0.003;

export class Engine {
  constructor() {
    this.ctx = null;
    this.banks = new Map();     // switch id → [{ buf, peak, offset }] sorted by peak
    this.loading = new Map();   // switch id → Promise
    this.recent = new Map();    // switch id → recent pick indices
    this.ampTarget = 0.5;
    this.room = "raw";
  }

  ensure() {
    if (this.ctx) return this.ctx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx({ latencyHint: "interactive" });
    this.ctx = ctx;
    // iOS 17+: play through the ring/silent switch like a media app.
    try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch (_) {}

    this.out = ctx.createGain();
    this.hp = ctx.createBiquadFilter();   this.hp.type = "highpass";  this.hp.Q.value = 0.707;
    this.ls = ctx.createBiquadFilter();   this.ls.type = "lowshelf";
    this.pk = ctx.createBiquadFilter();   this.pk.type = "peaking";
    this.lp = ctx.createBiquadFilter();   this.lp.type = "lowpass";   this.lp.Q.value = 0.707;
    this.hs = ctx.createBiquadFilter();   this.hs.type = "highshelf";
    this.out.connect(this.hp).connect(this.ls).connect(this.pk)
      .connect(this.lp).connect(this.hs).connect(ctx.destination);
    this.setRoom(this.room, true);
    return ctx;
  }

  // Must run inside a user gesture at least once (autoplay policy).
  unlock() {
    const ctx = this.ensure();
    if (ctx.state !== "running") ctx.resume().catch(() => {});
    return ctx;
  }

  setRoom(name, instant = false) {
    this.room = ROOM_PRESETS[name] ? name : "raw";
    if (!this.ctx) return;
    const p = ROOM_PRESETS[this.room];
    const t = this.ctx.currentTime;
    const TC = instant ? 0 : 0.04;
    const set = (param, v) => (instant ? (param.value = v) : param.setTargetAtTime(v, t, TC));
    set(this.hp.frequency, p.hp);
    set(this.ls.frequency, p.lsFreq); set(this.ls.gain, p.ls);
    set(this.pk.frequency, p.peakFreq); set(this.pk.Q, p.peakQ); set(this.pk.gain, p.peak);
    set(this.lp.frequency, Math.min(p.lp, this.ctx.sampleRate / 2));
    set(this.hs.frequency, p.hsFreq); set(this.hs.gain, p.hs);
  }

  isLoaded(id) { return this.banks.has(id); }

  load(entry, onProgress) {
    if (this.banks.has(entry.id)) return Promise.resolve(this.banks.get(entry.id));
    if (this.loading.has(entry.id)) return this.loading.get(entry.id);
    const p = this._load(entry, onProgress).finally(() => this.loading.delete(entry.id));
    this.loading.set(entry.id, p);
    return p;
  }

  async _load(entry, onProgress) {
    const ctx = this.ensure();
    const files = entry.files || [];
    const out = [];
    let cursor = 0, done = 0;
    const worker = async () => {
      while (cursor < files.length) {
        const file = files[cursor++];
        try {
          const r = await fetch(`/library/${encodeURIComponent(entry.id)}/${encodeURIComponent(file)}`);
          if (!r.ok) throw new Error("HTTP " + r.status);
          const buf = await decode(ctx, await r.arrayBuffer());
          out.push(analyse(buf));
        } catch (e) {
          console.warn("thock: sample failed", entry.id, file, e);
        }
        done++;
        if (onProgress) onProgress(done / files.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, files.length) }, worker));
    if (!out.length) throw new Error(`no playable samples for ${entry.id}`);
    out.sort((a, b) => a.peak - b.peak);
    this.banks.set(entry.id, out);
    return out;
  }

  // pan ∈ [-1, 1] (left → right). Returns false if the bank isn't ready.
  play(id, pan = 0) {
    const bank = this.banks.get(id);
    if (!bank || !this.ctx) return false;
    const ctx = this.ctx;
    if (ctx.state !== "running") ctx.resume().catch(() => {});

    // Force model: a slow random walk picks both which recording plays
    // (by peak percentile) and how loud, as in the typist.
    this.ampTarget = clamp(this.ampTarget + (Math.random() - 0.5) * 0.12, 0.2, 0.8);
    const N = bank.length;
    const jitter = (Math.random() - 0.5) * 0.18;
    let idx = clamp(Math.floor((this.ampTarget + jitter) * N), 0, N - 1);
    if (N > 2) {
      const recent = this.recent.get(id) || [];
      for (let off = 0; off < N; off++) {
        const cands = off === 0 ? [idx] : [idx + off, idx - off];
        const hit = cands.find((c) => c >= 0 && c < N && !recent.includes(c));
        if (hit != null) { idx = hit; break; }
      }
      recent.push(idx);
      while (recent.length > Math.min(3, Math.floor(N / 2))) recent.shift();
      this.recent.set(id, recent);
    }
    const s = bank[idx];

    const t0 = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = s.buf;
    src.playbackRate.value = 1 + (Math.random() - 0.5) * 0.012;

    const vel = 0.55 + this.ampTarget * 0.5;
    const dur = s.buf.duration - s.offset;
    const FADE_IN = 0.002;
    const FADE_OUT = Math.min(0.015, dur * 0.2);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vel, t0 + FADE_IN);
    g.gain.setValueAtTime(vel, t0 + Math.max(FADE_IN, dur - FADE_OUT));
    g.gain.linearRampToValueAtTime(0, t0 + dur);

    let node = src.connect(g);
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(pan * 0.6 + (Math.random() - 0.5) * 0.06, -0.7, 0.7);
      node = node.connect(p);
    }
    node.connect(this.out);
    src.start(t0, s.offset);
    return true;
  }
}

function decode(ctx, ab) {
  // Callback form for older Safari, promise form everywhere else.
  return new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(ab, resolve, reject);
    if (p && p.then) p.then(resolve, reject);
  });
}

function analyse(buf) {
  const ch = buf.getChannelData(0);
  let peak = 0, peakIdx = 0;
  for (let i = 0; i < ch.length; i++) {
    const v = ch[i] < 0 ? -ch[i] : ch[i];
    if (v > peak) { peak = v; peakIdx = i; }
  }
  // Onset = first sample ≥ 25 % of peak, the same rule app.js uses.
  const thr = peak * 0.25;
  let onset = peakIdx;
  for (let i = 0; i < peakIdx; i++) {
    if ((ch[i] < 0 ? -ch[i] : ch[i]) >= thr) { onset = i; break; }
  }
  const offset = Math.max(0, onset / buf.sampleRate - PRE_ONSET_S);
  return { buf, peak, offset };
}
