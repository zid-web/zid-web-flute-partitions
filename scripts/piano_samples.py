#!/usr/bin/env python3
"""Prépare les échantillons de piano de l'application (public/samples/piano/).

Source : Salamander Grand Piano (Yamaha C5) d'Alexander Holm, licence CC-BY 3.0
(http://creativecommons.org/licenses/by/3.0/), dans la version MP3 du dépôt Tone.js :

    git clone --depth 1 https://github.com/Tonejs/audio /tmp/tonejs-audio
    python3 scripts/piano_samples.py /tmp/tonejs-audio/salamander

Une note tous les 3 demi-tons (La0 → Do8). Chaque note : 6 s au plus (un piano s'éteint de
lui-même ; les notes plus longues restent rares), fondu final de 1,5 s, stéréo 44,1 kHz,
MP3 112 kbit/s. Nécessite ffmpeg (avec libmp3lame).
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

OUT = Path("public/samples/piano")
STEP = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
NAME = re.compile(r"^([A-G])(s?)(\d)\.mp3$")  # « Ds4 » = ré♯4


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    source = Path(sys.argv[1])
    OUT.mkdir(parents=True, exist_ok=True)
    notes = []
    for mp3 in sorted(source.glob("*.mp3")):
        m = NAME.match(mp3.name)
        if not m:
            continue
        step, sharp, octave = m.groups()
        midi = (int(octave) + 1) * 12 + STEP[step] + (1 if sharp else 0)
        target = OUT / f"piano-{midi}.mp3"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(mp3), "-t", "6",
                        "-af", "afade=t=out:st=4.5:d=1.5", "-ar", "44100", "-ac", "2",
                        "-c:a", "libmp3lame", "-b:a", "112k", str(target)], check=True)
        notes.append(midi)
        print(f"{mp3.name} → {target.name} ({target.stat().st_size // 1024} Ko)")
    (OUT / "notes.json").write_text(json.dumps(sorted(notes)) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
