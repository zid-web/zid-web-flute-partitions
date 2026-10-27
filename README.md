# 🎶 Flûte Partitions

Application pédagogique et ludique pour apprendre la flûte traversière : on choisit un morceau,
on joue, et **chaque note s'allume quand elle est réussie**. Un curseur avance sur la partition,
la note attendue est en orange, les notes réussies passent au vert et une fausse note clignote en rouge.

- 🎤 **Reconnaissance des notes au micro**, entièrement sur l'appareil (algorithme McLeod, aucun son envoyé sur Internet)
- 🎼 Rendu de partitions MusicXML (OpenSheetMusicDisplay), doigté de la note attendue, accordeur
- 🔊 Mode **Écouter** : l'application joue le morceau au tempo choisi
- ⭐ Étoiles, séries, encouragements, progression enregistrée sur l'appareil
- 📶 **Hors ligne** : PWA (service worker) sur le web, partitions embarquées dans les applications natives
- 💻📱 **Android, iOS, Windows, macOS** (Tauri 2) + web sur **Vercel**
- 📚 Catalogue classé par **niveau 1–5** et **complexité 0–100**, alimenté par le skill
  [`imslp-flute-curator`](.claude/skills/imslp-flute-curator/SKILL.md) à partir d'IMSLP

## Démarrer

```bash
npm install
npm run dev          # http://localhost:5173
npm test             # tests du suivi de partition
npm run build        # version web dans dist/
```

Le micro exige HTTPS (ou `localhost`). Sans flûte, le bouton « Note suivante » permet de parcourir la partition.

## Ajouter des partitions

Deux chemins, sans jamais relier l'application en direct à IMSLP (hors ligne, droits d'auteur, identifiants) :

### 1. Catalogue commun : robot « Curation IMSLP » (GitHub Actions)

Onglet **Actions → Curation IMSLP → Run workflow** (ou automatiquement le 1er de chaque mois).
Le robot cherche de nouvelles œuvres pour flûte sur IMSLP, ne garde que les licences libres et les fichiers
MusicXML, extrait la partie de flûte, calcule niveau et complexité, puis **ouvre une pull request** avec le
tableau des morceaux proposés. Rien n'est publié tant que la pull request n'est pas fusionnée ; à la fusion,
Vercel met le site à jour. `content/imslp-seen.json` mémorise les œuvres déjà examinées : chaque passage avance.

Prérequis (une fois) :
- *Settings → Secrets and variables → Actions* : secrets `IMSLP_USERNAME` et `IMSLP_PASSWORD`.
- *Settings → Actions → General* : cocher **« Allow GitHub Actions to create and approve pull requests »**.
- Les pull requests ouvertes par le robot ne déclenchent pas la CI d'elles-mêmes (règle GitHub) : l'aperçu
  Vercel suffit pour écouter les morceaux ; sinon fermer/rouvrir la pull request relance la CI.

En local, même pipeline : voir [le skill de curation](.claude/skills/imslp-flute-curator/SKILL.md).

### 2. Partitions personnelles : bouton « 📥 Importer une partition » (dans l'application)

L'élève ou le professeur télécharge un fichier **MusicXML** (`.mxl`, `.musicxml`) sur IMSLP ou ailleurs, puis
l'importe (ou le glisse) dans la bibliothèque. L'application garde la partie de flûte, calcule le niveau avec
les mêmes règles que le skill, et enregistre la partition **sur l'appareil uniquement** (IndexedDB, hors ligne).

Mélodies traditionnelles / exercices du catalogue : `content/originals/*.json` → `python3 scripts/make_samples.py content/originals/*.json`.

## Déployer le web sur Vercel

Importer le dépôt dans Vercel : `vercel.json` règle tout (Vite, sortie `dist/`). Aucune variable d'environnement.

## Applications natives (Tauri 2)

Prérequis locaux : Rust, et selon la cible Xcode (macOS/iOS), Android Studio + NDK (Android),
WebView2 (Windows, déjà présent sur Windows 10/11).

```bash
npm run tauri dev                  # application de bureau en développement
npm run tauri build                # installeur pour le système courant (.msi/.exe, .dmg/.app, .deb/.AppImage)
npx tauri android init && npx tauri android build --apk
npx tauri ios init && npx tauri ios build      # sur un Mac, avec un compte Apple Developer
```

Android : après `tauri android init`, ajouter la permission micro dans
`src-tauri/gen/android/app/src/main/AndroidManifest.xml` (le workflow de release le fait) :
`<uses-permission android:name="android.permission.RECORD_AUDIO" />`.

### Publier les applications

Pousser un tag : `git tag v0.1.0 && git push origin v0.1.0`. Le workflow **Release** crée un brouillon
de Release GitHub avec les installeurs Windows, macOS (universel), Linux et l'APK Android.

| Plateforme | Ce qu'il faut | Secrets / variables GitHub |
|---|---|---|
| Windows, Linux | rien | — |
| macOS signé + notarisé | compte Apple Developer (99 $/an) | `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` |
| Android signé (Play Store) | un keystore | `ANDROID_KEYSTORE` (base64), `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` — sans eux : APK de test (debug) |
| iOS (App Store / TestFlight) | compte Apple Developer | variable `APPLE_DEVELOPMENT_TEAM` + secrets `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_P8` |

## Architecture

```
src/lib/follower.ts   suivi de partition (logique pure, testée) : quand valider une note
src/lib/pitch.ts      micro → hauteur (pitchy)
src/lib/score.ts      OSMD : rendu, curseur, coloration des notes
src/lib/fingering.ts  doigtés Boehm des deux premières octaves
src/lib/difficulty.ts niveau / complexité dans le navigateur (portage du skill, testé contre catalog.json)
src/lib/import.ts     import .mxl/.musicxml ; src/lib/userScores.ts : stockage local (IndexedDB)
src/components/       Bibliothèque, Lecteur, Doigté
public/scores/        partitions MusicXML + catalog.json (généré)
.claude/skills/imslp-flute-curator/  skill de curation IMSLP (Python, sans dépendance)
src-tauri/            emballage natif
```

## Droits

Code : MIT. Partitions : domaine public ou Creative Commons, licence et source IMSLP indiquées dans
chaque `public/scores/*.meta.json`.
