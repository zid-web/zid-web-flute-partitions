// Ajoute la signature « release » au projet Android généré par `tauri android init`
// (recette de la documentation Tauri). Lit src-tauri/gen/android/keystore.properties.
import { readFileSync, writeFileSync } from "node:fs";

const file = "src-tauri/gen/android/app/build.gradle.kts";
let src = readFileSync(file, "utf8");
if (src.includes('create("release")')) process.exit(0);

if (!src.includes("import java.io.FileInputStream")) src = `import java.io.FileInputStream\n${src}`;
if (!src.includes("import java.util.Properties")) src = `import java.util.Properties\n${src}`;

src = src.replace(
  /android \{\n/,
  `android {
    signingConfigs {
        create("release") {
            val props = Properties()
            props.load(FileInputStream(rootProject.file("keystore.properties")))
            keyAlias = props["keyAlias"] as String
            keyPassword = props["password"] as String
            storeFile = file(props["storeFile"] as String)
            storePassword = props["password"] as String
        }
    }
`,
);
src = src.replace(
  /getByName\("release"\) \{\n/,
  `getByName("release") {\n            signingConfig = signingConfigs.getByName("release")\n`,
);
writeFileSync(file, src);
console.log("Signature Android configurée.");
