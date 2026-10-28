/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// Tauri sets TAURI_ENV_PLATFORM while building the native apps: the service
// worker is useless there (assets are bundled in the binary, new scores come
// from src/lib/contentSync.ts).
const isTauri = Boolean(process.env.TAURI_ENV_PLATFORM);
// Version affichée dans l'application : commit déployé par Vercel, sinon date du build.
const appVersion = (process.env.VERCEL_GIT_COMMIT_SHA ?? "").slice(0, 7) || new Date().toISOString().slice(0, 10);

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
  plugins: [
    react(),
    VitePWA({
      // « prompt » : c'est src/lib/appUpdate.ts qui décide quand installer (jamais pendant un morceau).
      registerType: "prompt",
      disable: isTauri,
      includeAssets: ["icon.svg"],
      workbox: {
        // The scores and the catalog are precached: the app works offline
        // after the first visit.
        globPatterns: ["**/*.{js,css,html,svg,png,json,musicxml,xml}"],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      },
      manifest: {
        name: "Flûte Partitions",
        short_name: "Flûte",
        description: "Jouez des partitions de flûte : chaque note s'allume quand vous la jouez.",
        lang: "fr",
        theme_color: "#4f46e5",
        background_color: "#fdf8f0",
        display: "standalone",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
    }),
  ],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  test: { environment: "node" },
});
