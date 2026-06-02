#!/usr/bin/env python3
"""Bundle a directory of <switch>/<sample>.wav recordings into the
library/ layout that the static site serves.

Usage:
    python scripts/bundle_library.py /path/to/your/samples [--clear]

Each direct subdirectory of the source becomes a library entry. WAVs
are copied into library/<switch_name>/, and library/index.json is
regenerated.

Optional per-switch metadata (drop a meta.json next to its samples to
override the auto-derived name / color / family):

    {
      "name": "Choc v2 Red",
      "family": "Kailh Choc v2",
      "description": "Linear · 50 ± 10 gf",
      "color": "#e25555"
    }
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

import soundfile as sf  # libsndfile wrapper; handles float WAV → FLAC

REPO = Path(__file__).resolve().parent.parent
DEFAULT_DST = REPO / "library"

# Theme-safe palette (mirrors app.js COLOR_PALETTE — every entry is
# readable on both the light and dark surfaces).
DEFAULT_COLORS = [
    "#f5a623", "#e67e22", "#e25555", "#c0392b",
    "#d63384", "#a040b3", "#9472d8", "#5b6acb",
    "#3d8be8", "#2da8c0", "#0f9c8e", "#2e9d6c",
    "#3f9550", "#7a8a30", "#b78d2a", "#a05a2c",
]


def humanize(slug: str) -> str:
    return slug.replace("_", " ").replace("-", " ").title()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("source", help="folder of <switch>/<wavs>")
    ap.add_argument("--dst", default=str(DEFAULT_DST), help="output library dir")
    ap.add_argument("--clear", action="store_true", help="wipe destination first")
    args = ap.parse_args()

    src = Path(args.source).expanduser().resolve()
    dst = Path(args.dst).expanduser().resolve()
    if not src.is_dir():
        print(f"source {src} is not a directory", file=sys.stderr)
        return 1

    if args.clear and dst.exists():
        # keep index.json shape but remove all the switch subdirs
        for p in dst.iterdir():
            if p.is_dir():
                shutil.rmtree(p)
    dst.mkdir(parents=True, exist_ok=True)

    index = []
    color_idx = 0
    for switch_dir in sorted(p for p in src.iterdir() if p.is_dir()):
        wavs = sorted(p.name for p in switch_dir.iterdir() if p.suffix.lower() == ".wav")
        if not wavs:
            print(f"skip {switch_dir.name}: no .wav files", file=sys.stderr)
            continue
        out_dir = dst / switch_dir.name
        out_dir.mkdir(exist_ok=True)
        flacs = []
        for f in wavs:
            src_wav = switch_dir / f
            dst_flac = out_dir / (Path(f).stem + ".flac")
            # Read whatever the source WAV's subtype is (thock writes
            # float32), write 24-bit FLAC — preserves float32's
            # effective precision (mantissa is 24 bits) without paying
            # for full-float storage, and matches what mainstream
            # browsers decode efficiently.
            data, sr = sf.read(str(src_wav), always_2d=False, dtype="float32")
            sf.write(str(dst_flac), data, sr, format="FLAC", subtype="PCM_24")
            flacs.append(dst_flac.name)

        meta_path = switch_dir / "meta.json"
        meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
        entry = {
            "id":          switch_dir.name,
            "name":        meta.get("name", humanize(switch_dir.name)),
            "family":      meta.get("family", ""),
            "description": meta.get("description", ""),
            "color":       meta.get("color", DEFAULT_COLORS[color_idx % len(DEFAULT_COLORS)]),
            "files":       flacs,
        }
        index.append(entry)
        color_idx += 1
        wav_bytes = sum((switch_dir / f).stat().st_size for f in wavs)
        flac_bytes = sum((out_dir / f).stat().st_size for f in flacs)
        ratio = (flac_bytes / wav_bytes * 100) if wav_bytes else 0
        fam = f" [{entry['family']}]" if entry["family"] else ""
        print(f"  {entry['id']}{fam}: {len(flacs)} samples · "
              f"{wav_bytes // 1024} KB → {flac_bytes // 1024} KB ({ratio:.0f}%)")

    (dst / "index.json").write_text(json.dumps(index, indent=2) + "\n")
    print(f"\nbundled {len(index)} switches → {dst}")
    print(f"index   → {dst / 'index.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
