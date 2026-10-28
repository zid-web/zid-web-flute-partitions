---
name: omr-notes
description: Reconnaît une partition scannée (PDF ou image) avec Audiveris, exporte le MusicXML (.mxl) puis le convertit en MuseScore (.mscz) avec un PDF de contrôle. À utiliser pour traiter une partition précise à relire et corriger à la main, par exemple un PDF IMSLP que le robot « Conversion des partitions déposées » a mis dans content/a-convertir/non-reconnus/.
---

# OMR d'une partition → MusicXML → MuseScore

Traite **un fichier** pour qu'une personne le relise. Pour alimenter le catalogue automatiquement,
c'est le skill `imslp-flute-curator` et le workflow « Conversion des partitions déposées ».

Lancer depuis la racine du dépôt (ou n'importe où avec `--sortie`).

## 1. Vérifier les outils

```bash
python3 .claude/skills/omr-notes/scripts/omr_notes.py check
```

- **Audiveris** (obligatoire) : https://github.com/Audiveris/audiveris/releases. Trouvé dans le
  `PATH`, `/Applications/Audiveris.app` (Mac), `/opt/audiveris` (Linux), ou `--audiveris CHEMIN`.
  Sous Linux sans écran, il passe par `xvfb-run` (paquet `xvfb`).
- **MuseScore** (facultatif, pour le `.mscz` et le PDF de contrôle) : `mscore`, `mscore3`,
  `musescore3` dans le `PATH`, `/Applications/MuseScore 4.app` (Mac), ou `--mscore CHEMIN`.
  Dans une session cloud Ubuntu : `sudo apt-get install -y --no-install-recommends musescore3`.
- **pypdf** (conseillé) : `pip3 install pypdf`, pour la reconnaissance page par page.

S'il manque Audiveris : s'arrêter et le dire. S'il manque MuseScore : continuer, le `.mxl` suffit.

## 2. Traiter la partition

```bash
python3 .claude/skills/omr-notes/scripts/omr_notes.py run "content/a-convertir/non-reconnus/fichier.pdf"
python3 .claude/skills/omr-notes/scripts/omr_notes.py run partition.png
python3 .claude/skills/omr-notes/scripts/omr_notes.py run recueil.pdf --pages 2-5   # quelques pages
```

1. Audiveris reconnaît le fichier entier. Si l'export échoue (« Error in export » : une page de
   titre ou un scan abîmé suffit), il recommence **page par page** (`page02.pdf`…) et garde les
   pages réussies. Une page peut donner plusieurs morceaux : `page03.mvt1.mxl`, `page03.mvt2.mxl`.
2. Chaque `.mxl` est converti en `.mscz` et en `.pdf` par MuseScore.

Sorties dans `skill-work/omr-notes/<nom du fichier>/` (ignoré par git) :

| Dossier | Contenu |
|---|---|
| `musicxml/` | `.mxl` d'Audiveris (+ `.omr`, à rouvrir dans l'interface d'Audiveris pour corriger) |
| `pages/` | pages découpées, si la reconnaissance page par page a servi |
| `musescore/` | `.mscz` et `.pdf` de contrôle |

Compter 1 à 2 minutes par page. Lancer en arrière-plan au-delà de quelques pages.

## 3. Rendre compte

Donner la liste des fichiers produits et leur chemin, les pages non reconnues, et rappeler que
l'OMR est **à relire** : signature rythmique et armure (souvent manquées sur les gravures
anciennes : « No target duration », « No effective key » dans le journal), mesures marquées
irrégulières dans MuseScore, et pour un duo ne garder que la 1ʳᵉ flûte. Une fois corrigé, le `.mxl`
se dépose dans `content/a-convertir/` : le robot ne refait pas l'OMR et l'ajoute au catalogue.

## Règles

- Droits : uniquement des partitions du domaine public ou Creative Commons (voir CLAUDE.md) ;
  les sorties restent dans `skill-work/`, ne pas les versionner sans vérification de la licence.
- IMSLP : ne jamais télécharger automatiquement (« Bot Check ») ; partir d'un fichier déjà déposé.
