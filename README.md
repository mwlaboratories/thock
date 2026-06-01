# thock

A measurement-instrument for the sound of mechanical keyswitches. Record
each press as a WAV, average the spectra into a per-switch *fingerprint*,
compare switches side-by-side, and let a built-in typist play your samples
back at any WPM with realistic English digraph rolls.

Single-page web app. Static. Runs entirely in the browser. Storage uses
the File System Access API (or OPFS as a fallback) — nothing leaves your
machine.

Live: **https://thock.mwlabs.be**

---

## What it does

- **capture** — enable the mic, hit *start*, press the key. Every press
  above the auto-tracked noise floor is segmented and written to disk as
  a WAV in real time. Hit *stop* when done.
- **inspect** — pick a sample to see its waveform (onset-aligned, with
  `DOWN`/`UP` markers for clicky switches), per-sample FFT, and a
  magma-colormap STFT spectrogram.
- **fingerprint** — averaged smoothed spectrum across every sample of a
  switch, with the top resonant peaks labeled (`428 Hz`, `1.24 kHz`,
  `4.5 kHz` …). That's the switch's identity.
- **typist** — plays your samples back as a real-text stream (top-100
  English words / quotes / pangrams / random). Common digraphs roll
  faster, awkward ones stretch, occasional micro-pauses. Letters appear
  on a synced canvas above the keystroke waveforms.
- **presets** — curated switch datasets hosted alongside the site;
  one-click import into your storage.
- **per-switch color** — small palette assigned via name hash or picked
  manually; persisted in `localStorage`.

## Running locally

Requires [devenv](https://devenv.sh):

```sh
devenv up        # starts a static server on http://127.0.0.1:8765
```

Or any static server pointed at the repo root:

```sh
python -m http.server 8765
```

Then open `http://127.0.0.1:8765`. Click *choose folder* (or *use browser
storage* on Firefox/Safari) to pick where samples are written.

## Browser support

- Chrome / Edge / Brave / Arc / Opera — folder picker available (real
  filesystem)
- Firefox / Safari — falls back to OPFS (browser-managed filesystem,
  files not visible to the OS but functionally identical)

Mic capture goes through AudioWorklet so capture latency stays well below
visible.

## Adding presets

After recording your dataset locally, bundle it:

```sh
python scripts/bundle_presets.py /path/to/your/samples --clear
```

This copies each `<switch>/*.wav` into `presets/<switch>/` and
regenerates `presets/index.json`. Drop a `meta.json` next to a switch's
samples for custom name / description / color:

```json
{
  "name": "Choc v2 Red",
  "description": "Kailh Choc v2 Red — 50 gf linear",
  "color": "#ff6b6b"
}
```

Commit the `presets/` tree, push, and the site picks them up.

## Deploying to Vercel

Pure static — no build step. From the repo root:

```sh
vercel --prod
```

Or connect the GitHub repo in the Vercel dashboard. A `vercel.json` is
included that sets the `.js` content type explicitly (needed for
AudioWorklet).

## Stack

- Vanilla HTML / CSS / JavaScript — no framework, no build
- Audio: Web Audio API, AudioWorklet for capture
- Storage: File System Access API + IndexedDB (handle), OPFS fallback
- Fonts: Major Mono Display (wordmark), Geist Mono (everything else)

## License

MIT.
