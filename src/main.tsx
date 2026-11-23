import React from "react";
import ReactDOM from "react-dom/client";
import T3App from "./t3/T3App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./styles/globals.css";
import { applyAppearance, readAppearance, readTheme, resolveTheme } from "./lib/theme";

// Before the first paint, so a stored theme never flashes the default.
document.documentElement.dataset.theme = resolveTheme(readTheme());
applyAppearance(readAppearance());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <T3App />
    </ErrorBoundary>
  </React.StrictMode>,
);
