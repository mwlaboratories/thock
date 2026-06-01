#!/usr/bin/env python3
"""Bundle a directory of <switch>/<sample>.wav recordings into the
presets/ layout that the static site serves.

Usage:
    python scripts/bundle_presets.py /path/to/your/samples [--meta meta.yaml]

Each direct subdirectory of the source becomes a preset. WAVs are copied
into presets/<switch_name>/, and presets/index.json is regenerated.

Optional per-switch metadata:
    Drop a meta.json next to each switch's samples to override
    name/description/color, e.g.:

        {
          "name": "Choc v2 Red",
          "description": "Kailh Choc v2 Red — 50 gf linear",
          "color": "#ff6b6b"
        }
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DEFAULT_DST = REPO / "presets"

DEFAULT_COLORS = [
    "#f5a623", "#ff6b6b", "#5ba8ff", "#7dd87d",
    "#b18cff", "#2dd4bf", "#ec4899", "#d4e642",
]


def humanize(slug: str) -> str:
    return slug.replace("_", " ").replace("-", " ").title()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("source", help="folder of <switch>/<wavs>")
    ap.add_argument("--dst", default=str(DEFAULT_DST), help="output presets dir")
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
        for f in wavs:
            shutil.copy2(switch_dir / f, out_dir / f)

        meta_path = switch_dir / "meta.json"
        meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
        entry = {
            "id":          switch_dir.name,
            "name":        meta.get("name", humanize(switch_dir.name)),
            "description": meta.get("description", ""),
            "color":       meta.get("color", DEFAULT_COLORS[color_idx % len(DEFAULT_COLORS)]),
            "files":       wavs,
        }
        index.append(entry)
        color_idx += 1
        print(f"  {entry['id']}: {len(wavs)} samples")

    (dst / "index.json").write_text(json.dumps(index, indent=2) + "\n")
    print(f"\nbundled {len(index)} presets → {dst}")
    print(f"index   → {dst / 'index.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
