# CLAUDE.md

Application React + Vite + TypeScript (PWA) empaquetée avec Tauri 2. Français partout dans l'UI.

- Tests : `npm test` (vitest), `python3 -m unittest discover -s .claude/skills/imslp-flute-curator/tests` et `python3 -m unittest discover -s .claude/skills/omr-notes/tests`.
- OMR d'une partition à relire (Audiveris → .mxl → MuseScore .mscz + PDF de contrôle) : skill `omr-notes`, sorties dans `skill-work/omr-notes/`.
- Typecheck : `npm run typecheck`. Build web : `npm run build`.
- La logique de suivi de partition reste **pure** dans `src/lib/follower.ts` (pas d'audio ni de DOM) et testée.
- Hauteurs : numéros MIDI ; OSMD : octave 1 = octave MusicXML 4 (`noteToMidi` dans `src/lib/score.ts`).
- Partitions : uniquement via le skill `imslp-flute-curator` ou `scripts/make_samples.py` ; `public/scores/catalog.json` est **généré** (`curate.py catalog`), la CI vérifie qu'il est à jour.
- Jamais d'identifiants IMSLP dans le dépôt : variables d'environnement `IMSLP_USERNAME` / `IMSLP_PASSWORD`.
- Ne garder que des partitions domaine public / CC (pas de NonCommercial sans accord explicite).
- Hors ligne obligatoire : aucune fonction ne doit **dépendre** du réseau, pas de police ni de script externes. Seules exceptions, facultatives : la recherche de mise à jour (`src/lib/appUpdate.ts`, service worker) et, dans les applications natives, la synchronisation du catalogue depuis Vercel (`src/lib/contentSync.ts`).
- Son « Écouter » : vraie flûte enregistrée (`src/lib/sampler.ts`, `public/samples/flute/`, VSCO-2 CE en CC0, préparée par `scripts/flute_samples.py`) ; `src/lib/synth.ts` ne sert que si les échantillons ne se chargent pas.
- « Ma flûte » : notes enregistrées par l'utilisateur (`src/lib/myFlute.ts`, analyse pure et testée), gardées sur l'appareil (IndexedDB `flute-ma-flute`), jamais envoyées ; prioritaires à ±3 demi-tons pour « Écouter ».
- Piano : à l'import, les parties de piano sont repérées (`src/lib/accompaniment.ts`, pur et testé) — flûte + piano = accompagnement qui suit le jeu au micro, piano seul = écoute ; vrai piano `src/lib/piano.ts` (`public/samples/piano/`, Salamander Grand Piano CC-BY 3.0, `scripts/piano_samples.py`, crédit obligatoire).
- Mises à jour : jamais d'installation pendant un morceau (`setBusy`), uniquement depuis la bibliothèque.
- Difficulté : `difficulty.py` (skill) et `src/lib/difficulty.ts` (import dans l'app) doivent rester identiques ; le test d'import le vérifie sur `catalog.json`.
- Partitions importées : uniquement sur l'appareil (`src/lib/userScores.ts`, IndexedDB), jamais envoyées sur un serveur.
- IMSLP bloque les téléchargements automatiques (« Bot Check ») : ne jamais chercher à le contourner ; les PDF passent par le dépôt manuel `content/a-convertir/` (workflow « Conversion des partitions déposées »).
- Pas de connexion directe de l'application à IMSLP : le catalogue passe par le workflow « Curation IMSLP » et une pull request validée.
