import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initAppUpdates } from "./lib/appUpdate";
import { isDesktopApp, isMac } from "./lib/platform";
import "./styles.css";

// Détection de l'application installée en local (Tauri desktop)
if (isDesktopApp()) {
  document.documentElement.classList.add("is-desktop-app");
  if (isMac()) {
    document.documentElement.classList.add("is-macos");
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

initAppUpdates();
