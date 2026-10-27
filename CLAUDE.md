# CLAUDE.md

Application React + Vite + TypeScript (PWA) empaquetée avec Tauri 2. Français partout dans l'UI.

- Tests : `npm test` (vitest) et `python3 -m unittest discover -s .claude/skills/imslp-flute-curator/tests`.
- Typecheck : `npm run typecheck`. Build web : `npm run build`.
- La logique de suivi de partition reste **pure** dans `src/lib/follower.ts` (pas d'audio ni de DOM) et testée.
- Hauteurs : numéros MIDI ; OSMD : octave 1 = octave MusicXML 4 (`noteToMidi` dans `src/lib/score.ts`).
- Partitions : uniquement via le skill `imslp-flute-curator` ou `scripts/make_samples.py` ; `public/scores/catalog.json` est **généré** (`curate.py catalog`), la CI vérifie qu'il est à jour.
- Jamais d'identifiants IMSLP dans le dépôt : variables d'environnement `IMSLP_USERNAME` / `IMSLP_PASSWORD`.
- Ne garder que des partitions domaine public / CC (pas de NonCommercial sans accord explicite).
- Hors ligne obligatoire : pas d'appel réseau au runtime, pas de police ni de script externes.
