# thock

The honest sound library for mechanical keyswitches.

Reviewers say *thocky*, *poppy*, *creamy*, *marble*. Manufacturer demos
are recorded in soundproof booths with $3,000 microphones. You watch a
YouTube clip, buy the switch, install it on **your** board on **your**
desk, and it sounds nothing like the clip.

thock is the alternative: *you* record *your* switches under *your*
conditions, then compare them quantitatively — the actual frequencies,
the actual attack, the actual housing ring — and listen to them play
back as full paragraphs of typing, side by side.

It's a single web page. Nothing leaves your machine. There's no account
to make and nothing to install.

**Live: [thock.mwlabs.be](https://thock.mwlabs.be)**

---

## What you can do with it

### Just listen
Open the page, hit *library*, tick a few switches you're curious about.
They download in seconds, the typist plays them as paragraphs of real
prose at your chosen WPM. Click any switch chip to instantly hear that
one instead. No microphone needed if you only want to browse.

### Record your own switch
Plug a switch in (or just hold one between your fingers — it works
without a keyboard). Click *+ create a switch*, give it a name, click
*▶ record samples*. A visual metronome paces you through ~60 taps that
gradually speed up; we auto-curate the cleanest 30 across the tempo
range. The whole thing takes about a minute.

### Compare two switches
Record one, import another from the library, and the fingerprint pane
shows the averaged spectrum of whichever you have selected — same axes,
same scale. Switch between them with one click; the typist follows.

### Contribute your recording
Hit *export* on any switch you recorded — you get a zip with your
samples plus the name / type / weight / family you typed in. Email it
to **info@mwlabs.be** and it joins the curated library on the next
release.

## Why bother

A *press of switch X* is a concept: a class of acoustic events that all
share the switch's essential signature (housing resonance, click
character, release character) and only differ in measurements that
don't matter (how hard you pressed, the exact angle of your finger).
thock captures that signature — averages many presses into one honest
spectrum — so two switches can finally be compared without buying both
of them, recording in a treated room, or trusting an adjective.

## Running it yourself

Static site. No build step. Any HTTP server works:

```sh
python -m http.server 8765
```

or with [devenv](https://devenv.sh):

```sh
devenv up        # http://127.0.0.1:8765
```

That's the whole setup.

## What's in this repo

- The full thock web app (HTML, CSS, JavaScript)
- A small Python script that bundles a folder of WAV recordings into
  the FLAC catalog the site serves

The curated switch library itself lives in a separate (private) repo
mounted as a `library/` submodule — code stays open, the recordings
stay ours. End-users get the same experience either way; they just
can't trivially scrape the recordings from this repository.

If you clone and want the library available locally:

```sh
git submodule update --init
```

Without access to the library repo, the *library* button will be empty
but everything else (record, fingerprint, typist on your own
recordings) works fine.

## License

MIT — the code is yours to read, fork, and build on. The library
recordings are not covered (they're in a separate, not-MIT repo).
