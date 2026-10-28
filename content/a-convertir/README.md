# Partitions à convertir

Déposez ici les partitions de flûte à ajouter à l'application (PDF, ou MusicXML `.mxl` / `.musicxml`),
téléchargées sur IMSLP depuis votre navigateur.

**Comment** : sur github.com, ouvrez ce dossier, puis *Add file → Upload files*, glissez les fichiers et
validez (*Commit changes*). Le robot « Conversion des partitions déposées » démarre tout seul :

1. il reconnaît les notes des PDF (Audiveris) et garde la partie de flûte ;
2. il calcule le niveau (1 à 5) et vérifie la qualité de la reconnaissance ;
3. il ouvre une pull request « Catalogue : partitions déposées converties » (5 à 15 minutes).

Écoutez chaque morceau dans l'aperçu Vercel de la pull request, puis fusionnez : les morceaux arrivent
dans la bibliothèque de tous les utilisateurs, et les fichiers traités sont retirés de ce dossier.

**Conseils**

- Nommez le fichier `Compositeur - Titre.pdf` (ex. `Telemann - Fantaisie n°1.pdf`) : titre et
  compositeur seront repris tels quels.
- Préférez les PDF de **flûte seule**, propres (gravure moderne) : un scan ancien, penché ou une
  partition avec piano se reconnaissent mal et peuvent être écartés.
- Au-delà de 12 pages, seules les 12 premières sont converties.
- Vérifiez la licence sur la page IMSLP (domaine public ou Creative Commons, pas « NonCommercial »).
