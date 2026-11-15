import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./ErrorBoundary";
import AppSecurityBoundary from "./features/security/AppSecurityBoundary";
import "./index.css";

const root = document.getElementById("root");
// Floating terminal backgrounds stay transparent outside the compact dock card.
const windowParams = new URLSearchParams(window.location.search);
// Retire the old metadata preview cache; drag previews no longer use storage.
try {
  for (let index = localStorage.length - 1; index >= 0; index--) {
    const key = localStorage.key(index);
    if (key?.startsWith("netrix_terminal_preview_v1:") || key?.startsWith("netrix_terminal_preview_v2:")) localStorage.removeItem(key);
  }
} catch { /* Storage may be unavailable in a restricted webview. */ }
if (windowParams.get("detached") === "true" || windowParams.get("tabPreview") === "true") {
  document.documentElement.dataset.terminalWindow = "true";
}
if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <ErrorBoundary>
        {windowParams.get("tabPreview") === "true"
          ? <App /> // Public drag metadata only; preview windows have no backend/IPC capability.
          : <AppSecurityBoundary><App /></AppSecurityBoundary>}
      </ErrorBoundary>
    </React.StrictMode>,
  );
}
