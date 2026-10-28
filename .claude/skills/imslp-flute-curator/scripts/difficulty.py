#!/usr/bin/env python3
"""Analyse de difficulté d'une partition de flûte (MusicXML / .mxl), sans dépendance.

Calcule des indicateurs objectifs puis un score de complexité 0–100 et un niveau 1–5.
Usage : python3 difficulty.py partition.musicxml [...]   → JSON sur la sortie standard
"""
from __future__ import annotations

import json
import statistics
import sys
import zipfile
from dataclasses import asdict, dataclass
from pathlib import Path
from xml.etree import ElementTree as ET

STEP = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
NAMES = ["Do", "Do♯", "Ré", "Mi♭", "Mi", "Fa", "Fa♯", "Sol", "Sol♯", "La", "Si♭", "Si"]
MAJOR_KEYS = {-7: "Do♭", -6: "Sol♭", -5: "Ré♭", -4: "La♭", -3: "Mi♭", -2: "Si♭", -1: "Fa", 0: "Do", 1: "Sol", 2: "Ré", 3: "La", 4: "Mi", 5: "Si", 6: "Fa♯", 7: "Do♯"}
# Notes délicates sur la flûte (passages de registre, notes de la 3e octave, extrêmes graves).
AWKWARD = {61, 63, 74, 75, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96}


def midi_name(m: int) -> str:
    return f"{NAMES[m % 12]}{m // 12 - 1}"


def read_root(path: Path) -> ET.Element:
    if path.suffix.lower() == ".mxl" and zipfile.is_zipfile(path):  # certains « .mxl » sont du XML non compressé
        with zipfile.ZipFile(path) as z:
            container = ET.fromstring(z.read("META-INF/container.xml"))
            rootfile = next(e.get("full-path") for e in container.iter() if e.tag.endswith("rootfile"))
            data = z.read(rootfile)
    else:
        data = path.read_bytes()
    root = ET.fromstring(data)
    # Supprime les espaces de noms éventuels.
    for el in root.iter():
        if isinstance(el.tag, str) and "}" in el.tag:
            el.tag = el.tag.split("}", 1)[1]
    return root


@dataclass
class Analysis:
    file: str
    title: str
    composer: str
    note_count: int
    measures: int
    low: str
    high: str
    low_midi: int
    high_midi: int
    range_semitones: int
    third_octave_ratio: float
    key: str
    fifths: int
    time: str
    tempo: float
    accidental_ratio: float
    shortest_beats: float
    notes_per_second: float
    rhythm_variety: int
    mean_interval: float
    max_leap: int
    large_leap_ratio: float
    awkward_ratio: float
    tuplets: int
    ornaments: int
    multi_voice: bool
    complexity: int
    level: int

    def catalog_fields(self) -> dict:
        return {
            "complexity": self.complexity,
            "level": self.level,
            "key": f"{self.key} majeur" if self.fifths is not None else None,
            "time": self.time,
            "range": {"low": self.low, "high": self.high},
            "noteCount": self.note_count,
        }


def analyse(path: Path, part_index: int = 0) -> Analysis:
    root = read_root(path)
    title = (root.findtext("work/work-title") or root.findtext("movement-title") or path.stem).strip()
    composer = next((c.text.strip() for c in root.iter("creator") if c.get("type") == "composer" and c.text), "Inconnu")
    parts = root.findall("part")
    if not parts:
        raise ValueError("aucune partie dans la partition (score-timewise non géré)")
    part = parts[min(part_index, len(parts) - 1)]

    divisions = 1
    fifths = 0
    time = "4/4"
    tempo = 0.0
    pitches: list[int] = []
    durations: list[float] = []
    accidentals = 0
    tuplets = ornaments = 0
    voices: set[str] = set()
    measures = part.findall("measure")
    total_beats = 0.0
    for measure in measures:
        attrs = measure.find("attributes")
        if attrs is not None:
            divisions = int(attrs.findtext("divisions") or divisions)
            if attrs.find("key/fifths") is not None:
                fifths = int(attrs.findtext("key/fifths"))
            if attrs.find("time/beats") is not None:
                time = f"{attrs.findtext('time/beats')}/{attrs.findtext('time/beat-type')}"
        for snd in measure.iter("sound"):
            if snd.get("tempo") and not tempo:
                tempo = float(snd.get("tempo"))
        for pm in measure.iter("per-minute"):
            if not tempo and pm.text and pm.text.strip().replace(".", "", 1).isdigit():
                tempo = float(pm.text)
        measure_beats = 0.0
        for note in measure.findall("note"):
            voices.add(note.findtext("voice") or "1")
            if note.find("grace") is not None or note.find("cue") is not None:
                continue
            dur = int(note.findtext("duration") or 0) / divisions
            if note.find("chord") is None:
                measure_beats += dur
            if note.find("time-modification") is not None:
                tuplets += 1
            if note.find("notations/ornaments") is not None or note.find("notations/articulations/staccato") is not None:
                ornaments += 1
            if note.find("rest") is not None or note.find("chord") is not None:
                continue
            if any(t.get("type") == "stop" for t in note.findall("tie")):
                if durations:
                    durations[-1] += dur
                continue
            step = note.findtext("pitch/step")
            octave = note.findtext("pitch/octave")
            if step is None or octave is None:
                continue
            alter = float(note.findtext("pitch/alter") or 0)
            pitches.append(int((int(octave) + 1) * 12 + STEP[step] + round(alter)))
            durations.append(dur)
            if note.find("accidental") is not None:
                accidentals += 1
        total_beats += measure_beats

    n = len(pitches)
    if n == 0:
        raise ValueError("aucune note trouvée")
    tempo = tempo or 90.0
    intervals = [abs(b - a) for a, b in zip(pitches, pitches[1:])] or [0]
    seconds = total_beats * 60 / tempo if total_beats else n
    a = Analysis(
        file=path.name,
        title=title,
        composer=composer,
        note_count=n,
        measures=len(measures),
        low=midi_name(min(pitches)),
        high=midi_name(max(pitches)),
        low_midi=min(pitches),
        high_midi=max(pitches),
        range_semitones=max(pitches) - min(pitches),
        third_octave_ratio=round(sum(p >= 84 for p in pitches) / n, 3),
        key=MAJOR_KEYS.get(fifths, "?"),
        fifths=fifths,
        time=time,
        tempo=tempo,
        accidental_ratio=round(accidentals / n, 3),
        shortest_beats=min(durations),
        notes_per_second=round(n / seconds, 2),
        rhythm_variety=len({round(d, 3) for d in durations}),
        mean_interval=round(statistics.mean(intervals), 2),
        max_leap=max(intervals),
        large_leap_ratio=round(sum(i > 7 for i in intervals) / len(intervals), 3),
        awkward_ratio=round(sum(p in AWKWARD for p in pitches) / n, 3),
        tuplets=tuplets,
        ornaments=ornaments,
        multi_voice=len(voices) > 1,
        complexity=0,
        level=1,
    )
    a.complexity = complexity_score(a)
    a.level = level_for(a.complexity)
    return a


def clamp01(x: float) -> float:
    return max(0.0, min(1.0, x))


def complexity_score(a: Analysis) -> int:
    """Combinaison pondérée d'indicateurs normalisés (poids documentés dans SKILL.md)."""
    parts = {
        "tessiture": (clamp01((a.range_semitones - 7) / 24), 14),
        "aigu": (clamp01(a.third_octave_ratio / 0.3), 12),
        "armure": (clamp01(abs(a.fifths) / 5), 10),
        "altérations": (clamp01(a.accidental_ratio / 0.25), 10),
        "vitesse": (clamp01((a.notes_per_second - 1) / 7), 18),
        "valeurs courtes": (clamp01((1 - a.shortest_beats) / 0.75), 8),
        "rythmes variés": (clamp01((a.rhythm_variety - 2) / 6), 8),
        "sauts": (clamp01(a.large_leap_ratio / 0.2) * 0.6 + clamp01((a.max_leap - 7) / 17) * 0.4, 10),
        "notes délicates": (clamp01(a.awkward_ratio / 0.2), 5),
        "ornements/n-olets": (clamp01((a.tuplets + a.ornaments) / max(a.note_count, 1) / 0.15), 5),
    }
    total = sum(w for _, w in parts.values())
    return round(100 * sum(v * w for v, w in parts.values()) / total)


def level_for(score: int) -> int:
    for level, upper in ((1, 15), (2, 30), (3, 48), (4, 68)):
        if score < upper:
            return level
    return 5


if __name__ == "__main__":
    out = []
    for arg in sys.argv[1:]:
        try:
            out.append(asdict(analyse(Path(arg))))
        except Exception as exc:  # noqa: BLE001 — on rapporte l'erreur et on continue
            out.append({"file": arg, "error": str(exc)})
    json.dump(out, sys.stdout, ensure_ascii=False, indent=2)
    print()
