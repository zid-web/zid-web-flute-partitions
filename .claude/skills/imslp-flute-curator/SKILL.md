---
name: imslp-flute-curator
description: Trouve, télécharge, analyse et classe des partitions de flûte d'IMSLP (domaine public) par niveau de difficulté (1–5) et score de complexité (0–100), puis les publie dans le catalogue de l'application (public/scores/). À utiliser quand on veut ajouter des morceaux, rééquilibrer les niveaux, vérifier une partition importée ou convertir un PDF IMSLP en MusicXML.
---

# Curateur de partitions de flûte IMSLP

Ce skill alimente l'application en partitions **jouables et suivables note à note**.
L'application a besoin de **MusicXML monodique** (une seule partie, la flûte) : un PDF seul
ne suffit pas, car le suivi doit connaître la hauteur exacte de chaque note.

Tous les scripts se lancent **depuis la racine du dépôt** ; les fichiers intermédiaires vont
dans `skill-work/` (ignoré par git).

## Règles à respecter

1. **Identifiants IMSLP** : uniquement dans les variables d'environnement `IMSLP_USERNAME` et
   `IMSLP_PASSWORD` (fichier `.env` local non versionné ou secret GitHub Actions). Ne jamais les
   écrire dans un fichier versionné, un message de commit ou une conversation.
2. **Droits** : ne garder que `Public Domain`, `CC0` et `Creative Commons Attribution` (avec ou
   sans ShareAlike). Exclure `Non-PD`, `NonCommercial` (sauf `--allow-nc` sur décision explicite
   du propriétaire). Conserver `license` et `sourceUrl` dans le `.meta.json` : ils sont affichés
   et servent d'attribution. Attention : IMSLP est au Canada ; une œuvre d'un compositeur mort il
   y a moins de 70 ans peut être protégée en France — vérifier le champ `Copyright` du fichier.
3. **Politesse** : 1 requête/seconde maximum (`--delay`), pas de téléchargement massif inutile.
4. **OMR = à relire** : toute partition issue de la reconnaissance optique (`origin: "omr"`) est
   marquée `needsReview` et **n'est pas publiée** par défaut. La relire (MuseScore) avant de
   la publier avec `--include-review` ou après correction.

## Pipeline

```bash
# 1. Découvrir les œuvres pour flûte (métadonnées seulement, pas de compte nécessaire)
python3 .claude/skills/imslp-flute-curator/scripts/curate.py discover --limit 300
#    catégories par défaut : « For flute », « For flute, piano », « For 2 flutes », « For flute, continuo »
#    autre catégorie : --category "For flute, guitar"

# 2. Télécharger les fichiers numériques (MusicXML/MIDI) ; --pdf ajoute les PDF pour l'OMR
IMSLP_USERNAME=… IMSLP_PASSWORD=… python3 .claude/skills/imslp-flute-curator/scripts/curate.py fetch

# 3. (optionnel) OMR des PDF avec Audiveris → skill-work/omr/*.mxl
python3 .claude/skills/imslp-flute-curator/scripts/curate.py omr

# 4. Extraire la partie de flûte et calculer difficulté + niveau → skill-work/analysed.json
python3 .claude/skills/imslp-flute-curator/scripts/curate.py analyse

# 5. Publier une sélection équilibrée (ex. 4 morceaux par niveau) puis régénérer le catalogue
python3 .claude/skills/imslp-flute-curator/scripts/curate.py publish --per-level 4

# Régénérer seulement catalog.json (après une correction manuelle dans public/scores/)
python3 .claude/skills/imslp-flute-curator/scripts/curate.py catalog
```

Les MIDI sont convertis en MusicXML si MuseScore (`mscore`) est installé ; sinon ils sont ignorés.

## Comment la difficulté est calculée (`scripts/difficulty.py`)

Indicateurs extraits de la partie de flûte, normalisés entre 0 et 1, puis pondérés :

| Indicateur | Poids | 0 → 1 |
|---|---|---|
| Vitesse (notes / seconde au tempo indiqué, 90 par défaut) | 18 | 1 → 8 notes/s |
| Tessiture (écart grave–aigu) | 14 | 7 → 31 demi-tons |
| Part de 3ᵉ octave (≥ Do6) | 12 | 0 → 30 % des notes |
| Armure | 10 | 0 → 5 altérations |
| Altérations accidentelles | 10 | 0 → 25 % des notes |
| Sauts (> quinte, et saut maximal) | 10 | 0 → 20 % ; quinte → 2 octaves |
| Valeurs courtes (plus petite durée) | 8 | noire → double croche |
| Variété rythmique (durées distinctes) | 8 | 2 → 8 |
| Notes délicates (Do♯/Mi♭ graves, Ré/Mi♭ 2ᵉ octave, 3ᵉ octave) | 5 | 0 → 20 % |
| N-olets et ornements | 5 | 0 → 15 % des notes |

Score de complexité = moyenne pondérée × 100. Niveau : **1** < 15 ≤ **2** < 30 ≤ **3** < 48 ≤ **4** < 68 ≤ **5**.

Ces seuils sont un point de départ : si un professeur juge un morceau mal classé, ajuster les
poids dans `complexity_score` / les seuils dans `level_for`, puis relancer `catalog` et les tests.
Pour forcer un niveau, ajouter `"levelOverride": n` dans le `.meta.json` (voir « Catalogue »).

## Catalogue

Chaque morceau publié = `public/scores/<id>.musicxml` + `public/scores/<id>.meta.json`
(`id`, `title`, `composer`, `file`, `source`, `sourceUrl`, `license`, `origin`, `tags`).
`catalog.json` est **généré** : ne pas l'éditer à la main. Le service worker met en cache
toutes les partitions, donc l'application fonctionne hors ligne après la première ouverture,
et les applications natives les embarquent.

Mélodies traditionnelles et exercices : écrire un JSON dans `content/originals/` (notation
compacte décrite dans `scripts/make_samples.py`), puis `python3 scripts/make_samples.py content/originals/*.json` et `catalog`.

## Vérifications avant de publier

- `python3 -m unittest discover -s .claude/skills/imslp-flute-curator/tests`
- `npm test` puis `npm run dev` : ouvrir le morceau, « Écouter » doit jouer la bonne mélodie
  et le curseur s'arrêter sur chaque note (pas sur les silences ni les notes liées).
- Tessiture dans `Si3–Ré7`, une seule voix, pas de partie de piano restante.
