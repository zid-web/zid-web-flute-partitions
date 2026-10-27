#!/usr/bin/env python3
"""Génère des partitions MusicXML à partir d'une notation compacte.

Format d'une mélodie : jetons séparés par des espaces, "|" = barre de mesure.
  C5:q   do5 noire        F#4:e  fa#4 croche      Bb4:h. si♭4 blanche pointée
  r:q    soupir           G4:q~  liée à la note suivante
Durées : w (ronde) h (blanche) q (noire) e (croche) s (double croche), "." = pointée.

Usage : python3 scripts/make_samples.py content/originals/*.json  (sortie : public/scores/)
Chaque .json : {"id","title","composer","time":"4/4","fifths":0,"tempo":80,"melody":"..."}
"""
import json
import re
import sys
from pathlib import Path
from xml.sax.saxutils import escape

DIV = 4  # divisions par noire
DUR = {"w": 16, "h": 8, "q": 4, "e": 2, "s": 1}
TYPE = {"w": "whole", "h": "half", "q": "quarter", "e": "eighth", "s": "16th"}
TOKEN = re.compile(r"^(r|[A-G])(#|b)?(\d)?:([whqes])(\.)?(~)?$")


def note_xml(tok: str, tied_from: bool) -> tuple[str, int, bool]:
    m = TOKEN.match(tok)
    if not m:
        raise ValueError(f"jeton invalide : {tok}")
    step, acc, octave, d, dot, tie = m.groups()
    dur = DUR[d] + (DUR[d] // 2 if dot else 0)
    parts = ["<note>"]
    if step == "r":
        parts.append("<rest/>")
    else:
        alter = {"#": 1, "b": -1}.get(acc or "", 0)
        parts.append(f"<pitch><step>{step}</step>" + (f"<alter>{alter}</alter>" if alter else "") + f"<octave>{octave}</octave></pitch>")
    parts.append(f"<duration>{dur}</duration>")
    if tied_from:
        parts.append('<tie type="stop"/>')
    if tie:
        parts.append('<tie type="start"/>')
    parts.append(f"<voice>1</voice><type>{TYPE[d]}</type>" + ("<dot/>" if dot else ""))
    if acc and step != "r":
        parts.append(f"<accidental>{'sharp' if acc == '#' else 'flat'}</accidental>")
    notations = []
    if tied_from:
        notations.append('<tied type="stop"/>')
    if tie:
        notations.append('<tied type="start"/>')
    if notations:
        parts.append("<notations>" + "".join(notations) + "</notations>")
    parts.append("</note>")
    return "".join(parts), dur, bool(tie)


def to_musicxml(spec: dict) -> str:
    beats, beat_type = spec.get("time", "4/4").split("/")
    measures = [m.split() for m in spec["melody"].split("|") if m.strip()]
    out = []
    tied = False
    for i, toks in enumerate(measures, 1):
        attrs = ""
        if i == 1:
            attrs = (
                f"<attributes><divisions>{DIV}</divisions><key><fifths>{spec.get('fifths', 0)}</fifths></key>"
                f"<time><beats>{beats}</beats><beat-type>{beat_type}</beat-type></time>"
                "<clef><sign>G</sign><line>2</line></clef></attributes>"
                f'<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit>'
                f"<per-minute>{spec.get('tempo', 80)}</per-minute></metronome></direction-type>"
                f'<sound tempo="{spec.get("tempo", 80)}"/></direction>'
            )
        notes = []
        for t in toks:
            xml, _, tied = note_xml(t, tied)
            notes.append(xml)
        bar = '<barline location="right"><bar-style>light-heavy</bar-style></barline>' if i == len(measures) else ""
        out.append(f'<measure number="{i}">{attrs}{"".join(notes)}{bar}</measure>')
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n'
        '<score-partwise version="4.0">'
        f"<work><work-title>{escape(spec['title'])}</work-title></work>"
        f'<identification><creator type="composer">{escape(spec["composer"])}</creator>'
        f"<rights>{escape(spec.get('license', 'Domaine public'))}</rights></identification>"
        '<part-list><score-part id="P1"><part-name>Flûte</part-name>'
        "<score-instrument id=\"P1-I1\"><instrument-name>Flute</instrument-name></score-instrument>"
        '<midi-instrument id="P1-I1"><midi-program>74</midi-program></midi-instrument></score-part></part-list>'
        f'<part id="P1">{"".join(out)}</part></score-partwise>\n'
    )


def main(paths: list[str]) -> None:
    dest = Path("public/scores")
    dest.mkdir(parents=True, exist_ok=True)
    for p in paths:
        spec = json.loads(Path(p).read_text(encoding="utf-8"))
        target = dest / f"{spec['id']}.musicxml"
        target.write_text(to_musicxml(spec), encoding="utf-8")
        meta = {k: v for k, v in spec.items() if k not in ("melody",)}
        meta.setdefault("file", target.name)
        (dest / f"{spec['id']}.meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"✓ {target}")


if __name__ == "__main__":
    main(sys.argv[1:])
