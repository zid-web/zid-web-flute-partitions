#!/usr/bin/env python3
"""Prépare les échantillons de vraie flûte traversière de l'application (public/samples/flute/).

Source : VSCO-2 Community Edition (Versilian Studios), flûte « susvib » (tenue avec vibrato),
licence CC0 1.0 (domaine public) — https://github.com/sgossner/VSCO-2-CE

    git clone --depth 1 https://github.com/sgossner/VSCO-2-CE /tmp/vsco
    python3 scripts/flute_samples.py /tmp/vsco

Pour chaque note : silence de départ retiré, volume égalisé (RMS), 6,5 s au plus avec fondu
final, mono 44,1 kHz, MP3 96 kbit/s (lisible par tous les navigateurs et WebView).
Nécessite ffmpeg (avec libmp3lame) et numpy.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

import numpy as np

OUT = Path("public/samples/flute")
RATE = 44100
MAX_SECONDS = 6.5
FADE_SECONDS = 0.4
TARGET_RMS = 0.12
STEP = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
# Les fichiers VSCO nomment le do central « C3 » : octave du nom + 1 = octave scientifique.
NAME = re.compile(r"LDFlute_susvib_([A-G])(#?)(\d)_v1_1\.wav$")


def decode(path: Path) -> np.ndarray:
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-ac", "1", "-ar", str(RATE), "-f", "f32le", "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32).copy()


def prepare(x: np.ndarray) -> np.ndarray:
    env = np.abs(x)
    onset = int(np.argmax(env > env.max() * 0.05))
    x = x[max(0, onset - int(0.01 * RATE)):][: int(MAX_SECONDS * RATE)]
    # volume égalisé sur la partie tenue (après l'attaque)
    body = x[int(0.3 * RATE):]
    x = x * (TARGET_RMS / max(float(np.sqrt(np.mean(body ** 2))), 1e-6))
    fade = int(FADE_SECONDS * RATE)
    x[-fade:] *= np.linspace(1, 0, fade, dtype=np.float32)
    return np.clip(x, -0.98, 0.98).astype(np.float32)


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    source = Path(sys.argv[1]) / "Woodwinds/Flute/susvib"
    OUT.mkdir(parents=True, exist_ok=True)
    notes = []
    for wav in sorted(source.glob("*_v1_1.wav")):
        m = NAME.search(wav.name)
        if not m:
            continue
        step, sharp, octave = m.groups()
        midi = (int(octave) + 2) * 12 + STEP[step] + (1 if sharp else 0)
        pcm = prepare(decode(wav))
        target = OUT / f"flute-{midi}.mp3"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(RATE), "-ac", "1", "-i", "-",
                        "-c:a", "libmp3lame", "-b:a", "96k", str(target)], input=pcm.tobytes(), check=True)
        notes.append(midi)
        print(f"{wav.name} → {target.name} ({len(pcm) / RATE:.1f} s, {target.stat().st_size // 1024} Ko)")
    (OUT / "notes.json").write_text(json.dumps(sorted(notes)) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
